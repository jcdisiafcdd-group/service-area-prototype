"""Build the point layer from the official LandsD Geo-Community Database (iGeoCom).

iGeoCom is a whole-territory set of geo-coded POIs (WGS84 GeoJSON) published
quarterly. We keep the *community facilities* CLASS=COM limited to the facility
types CMC (community centres / halls) and FSC (family / integrated family
service centres), then crop to the configured district. Cached to
data/points.geojson (raw iGeoCom download cached in data/iGeoCom_POI.geojson).
"""

from __future__ import annotations

import io
import json
import shutil
import subprocess
import zipfile
from datetime import datetime, timezone

import geopandas as gpd
import requests
from shapely.geometry import Point

from . import config

CLASS = "COM"
TYPES = ("CMC", "FSC")


def _download(url: str, dest) -> None:
    curl = shutil.which("curl")
    if curl:
        subprocess.run([curl, "-L", "-sS", "-o", str(dest), url], check=True)
        return
    resp = requests.get(url, verify=False, timeout=600)
    resp.raise_for_status()
    dest.write_bytes(resp.content)


def _ensure_raw() -> None:
    if config.IGEOCOM_RAW_FILE.exists():
        print(f"[points] using cached iGeoCom raw: {config.IGEOCOM_RAW_FILE.name}")
        return
    print("[points] downloading iGeoCom from data.gov.hk ...")
    tmp_zip = config.IGEOCOM_RAW_FILE.with_suffix(".tmp.zip")
    _download(config.IGEOCOM_URL, tmp_zip)
    with zipfile.ZipFile(tmp_zip) as zf:
        geojson_name = next(n for n in zf.namelist() if n.lower().endswith(".geojson"))
        config.IGEOCOM_RAW_FILE.write_bytes(zf.read(geojson_name))
    tmp_zip.unlink(missing_ok=True)
    print(f"[points] cached raw iGeoCom: {config.IGEOCOM_RAW_FILE.name}")


def main() -> None:
    if config.POINTS_FILE.exists():
        print(f"[points] using cached points: {config.POINTS_FILE.name}")
        return

    _ensure_raw()
    fc = json.loads(config.IGEOCOM_RAW_FILE.read_text(encoding="utf-8"))
    features = fc["features"]

    gdf = gpd.read_file(config.DISTRICT_FILE)
    poly = gdf.loc[gdf["District"] == config.DISTRICT].geometry.union_all()

    selected = [
        f for f in features
        if f["properties"].get("CLASS") == CLASS
        and f["properties"].get("TYPE") in TYPES
    ]
    picked = []
    for f in selected:
        lon, lat = f["geometry"]["coordinates"]
        if poly.contains(Point(lon, lat)):
            p = f["properties"]
            picked.append({
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": [lon, lat]},
                "properties": {
                    "id": len(picked) + 1,
                    "name": p.get("ENGLISHNAME"),
                    "name_zh": p.get("CHINESENAME"),
                    "type": p.get("TYPE"),
                    "category": f"{p.get('CLASS')}/{p.get('TYPE')}",
                    "address": p.get("E_ADDRESS"),
                    "address_zh": p.get("C_ADDRESS"),
                    "district": p.get("E_DISTRICT"),
                },
            })

    out = {
        "type": "FeatureCollection",
        "district": config.DISTRICT,
        "source": "LandsD Geo-Community Database (iGeoCom)",
        "filter": f"CLASS={CLASS}, TYPE in {TYPES}",
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "features": picked,
    }
    with open(config.POINTS_FILE, "w", encoding="utf-8") as fh:
        json.dump(out, fh)
    print(f"[points] {len(selected)} community facilities in HK "
          f"(CLASS={CLASS}, TYPE={TYPES}); {len(picked)} in {config.DISTRICT}")
    print(f"[points] saved: {config.POINTS_FILE.name}")


if __name__ == "__main__":
    main()