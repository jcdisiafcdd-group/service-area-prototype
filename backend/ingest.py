"""One-time data ingestion: 18-district boundary + 3D Pedestrian Network crop.

Crops the official LandsD 3D Pedestrian Network to the configured district and
caches the raw edges (WGS84 GeoJSON, with Z) plus the district boundary itself.

Note on the ArcGIS service quirks:
- `geometry` must be a plain string bbox "xmin,ymin,xmax,ymax" (this hosted
  service rejects JSON envelope / polygon geometries).
- Z elevations are ONLY returned with `f=json&returnZ=true` (GeoJSON drops Z).
"""

from __future__ import annotations

import json
import time
from datetime import datetime, timezone
from typing import Any

import geopandas as gpd
import requests
from shapely.geometry import shape

from . import config

MAX_RECORDS_PER_REQ = 2000
MAX_PAGES = 400


def fetch_district_boundary(force: bool = False) -> gpd.GeoDataFrame:
    if config.DISTRICT_FILE.exists() and not force:
        print(f"[ingest] using cached district boundary: {config.DISTRICT_FILE.name}")
        return gpd.read_file(config.DISTRICT_FILE)

    print(f"[ingest] downloading 18-district boundary...")
    resp = requests.get(config.DISTRICT_BOUNDARY_URL, timeout=120)
    resp.raise_for_status()
    fc = resp.json()

    gdf = gpd.GeoDataFrame.from_features(fc, crs=config.WGS84_CRS)
    config.DISTRICT_FILE.parent.mkdir(parents=True, exist_ok=True)
    gdf.to_file(config.DISTRICT_FILE, driver="GeoJSON")
    print(f"[ingest] saved district boundary: {config.DISTRICT_FILE.name}")
    return gdf


def district_geometry(gdf: gpd.GeoDataFrame):
    m = gdf.loc[gdf["District"] == config.DISTRICT]
    if m.empty:
        names = sorted(gdf["District"].tolist())
        raise ValueError(f"District '{config.DISTRICT}' not found. Choices: {names}")
    return m.geometry.union_all()


def _feature_to_geojson(feat: dict[str, Any]) -> dict[str, Any] | None:
    geom = feat.get("geometry")
    if not geom:
        return None
    paths = geom.get("paths")
    if not paths:
        return None
    coords = [[tuple(c) for c in path] for path in paths]
    if len(paths) == 1:
        geometry: dict[str, Any] = {"type": "LineString", "coordinates": coords[0]}
    else:
        geometry = {"type": "MultiLineString", "coordinates": coords}
    return {
        "type": "Feature",
        "geometry": geometry,
        "properties": feat.get("attributes", {}),
    }


def fetch_pedestrian_edges(district_poly) -> list[dict[str, Any]]:
    bounds = district_poly.bounds
    # pad bbox slightly so edges crossing the boundary are captured, then crop
    # below with shapely intersection
    pad = 0.002
    bbox = f"{bounds[0]-pad},{bounds[1]-pad},{bounds[2]+pad},{bounds[3]+pad}"

    features: list[dict[str, Any]] = []
    offset = 0
    while True:
        print(f"[ingest] querying edges (offset={offset})...")
        params = {
            "where": "1=1",
            "geometry": bbox,
            "geometryType": "esriGeometryEnvelope",
            "inSR": "4326",
            "outSR": "4326",
            "outFields": "*",
            "returnGeometry": "true",
            "returnZ": "true",
            "resultOffset": offset,
            "resultRecordCount": MAX_RECORDS_PER_REQ,
            "f": "json",
        }
        resp = requests.get(config.PED_NETWORK_QUERY_URL, params=params, timeout=120)
        resp.raise_for_status()
        fc = resp.json()
        if isinstance(fc, dict) and "error" in fc:
            raise RuntimeError(f"ArcGIS error: {fc['error']}")
        batch = fc.get("features", [])
        batch_geo = [_feature_to_geojson(f) for f in batch]
        n_pre = len(features)
        features.extend(x for x in batch_geo if x is not None)
        print(f"[ingest]   got {len(batch)} features -> {len(features) - n_pre} with geometry")
        if len(batch) < MAX_RECORDS_PER_REQ:
            break
        offset += MAX_RECORDS_PER_REQ
        if offset // MAX_RECORDS_PER_REQ >= MAX_PAGES:
            print("[ingest] WARNING: reached MAX_PAGES, stopping pagination")
            break
        time.sleep(0.2)

    # client-side crop to district polygon (keeps only intersecting edges)
    cropped = []
    for feat in features:
        g = shape({"type": feat["geometry"]["type"],
                   "coordinates": feat["geometry"]["coordinates"]})
        if g.intersects(district_poly):
            cropped.append(feat)
    print(f"[ingest] cropped {len(features)} -> {len(cropped)} edges intersecting district")
    return cropped


def summarize(fc: dict[str, Any]) -> None:
    props = [f.get("properties", {}) for f in fc.get("features", [])]
    for key in ("Location", "Feature_Type", "Direction", "Enabled"):
        counts: dict[Any, int] = {}
        for p in props:
            v = p.get(key)
            counts[v] = counts.get(v, 0) + 1
        print(f"[ingest]   {key}: {dict(sorted(counts.items(), key=lambda kv: -kv[1]))}")


def main() -> None:
    import sys

    force = "--force" in sys.argv

    gdf = fetch_district_boundary(force=force)
    poly = district_geometry(gdf)

    if config.EDGES_FILE.exists() and not force:
        boundary_mtime = config.DISTRICT_FILE.stat().st_mtime
        edges_mtime = config.EDGES_FILE.stat().st_mtime
        if boundary_mtime <= edges_mtime:
            print(f"[ingest] using cached edges: {config.EDGES_FILE.name}")
            return

    print(f"[ingest] cropping 3D Pedestrian Network to '{config.DISTRICT}'...")
    features = fetch_pedestrian_edges(poly)
    if not features:
        raise RuntimeError("no pedestrian edges found for district")

    fc: dict[str, Any] = {
        "type": "FeatureCollection",
        "cropTo": config.DISTRICT,
        "ingestedAt": datetime.now(timezone.utc).isoformat(),
        "features": features,
    }
    summarize(fc)
    with open(config.EDGES_FILE, "w", encoding="utf-8") as fh:
        json.dump(fc, fh)
    print(f"[ingest] saved edges: {config.EDGES_FILE.name}")


if __name__ == "__main__":
    main()