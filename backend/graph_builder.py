"""Build a routable walking NetworkX graph from the ingested 3D edges.

Edges (WGS84 [x, y, z]) are projected to HK1980 Grid (EPSG:2326). Endpoints
that coincide within a 3D tolerance are merged into shared nodes, so levels of
footbridges / subways stay distinct while street junctions connect. Each edge
carries a walking time derived from its true 3D length.

The expensive part runs once and is cached to a pickle; server startup just
unpickles it.
"""

from __future__ import annotations

import json
import time
from typing import Any

import networkx as nx
import numpy as np
from pyproj import Transformer
from scipy.spatial import cKDTree

from . import config

FEATURE_TYPE_NAMES = {
    1: "Footway", 2: "Footbridge", 4: "Subway", 5: "Service Lane",
    6: "Traffic Island", 7: "RunIn", 8: "Escalator", 9: "Travelator",
    10: "Lift", 11: "Ramp", 12: "Staircase", 13: "Stairlift", 14: "Other",
    15: "M_Footway", 16: "M_Escalator", 17: "M_Travelator", 18: "M_Lift",
    19: "M_Ramp", 20: "M_Staircase", 21: "M_Stairlift", 22: "M_Others",
    23: "Generalized Walkway inside Park", 24: "Footpath", 25: "Village",
    26: "Track", 30: "Crossing - Signalized", 31: "Crossing - Zebra",
    32: "Crossing - Cautionary", 33: "Crossing - Others",
}

# 3D merge tolerance (metres): connect endpoints that coincide, while keeping
# vertically-stacked levels (footbridge over road, floors) distinct.
MERGE_TOL_M = 0.6

_transformer = None


def _transform() -> Transformer:
    global _transformer
    if _transformer is None:
        _transformer = Transformer.from_crs(
            config.WGS84_CRS, config.GRID_CRS, always_xy=True
        )
    return _transformer


def _project(points: list[tuple]) -> tuple[np.ndarray, np.ndarray]:
    """points: [[x, y, z], ...] lon/lat WGS84 -> grid E/N and z arrays."""
    lon = np.array([p[0] for p in points])
    lat = np.array([p[1] for p in points])
    z = np.array([p[2] if len(p) > 2 and p[2] is not None else 0.0 for p in points])
    e, n = _transform().transform(lon, lat)
    return e, n, z


def _load_raw_edges() -> dict[str, Any]:
    with open(config.EDGES_FILE, encoding="utf-8") as fh:
        return json.load(fh)


def _merge_nodes(pts: np.ndarray, tol: float) -> np.ndarray:
    """Cluster points within tol (3D). Returns cluster id per point."""
    if pts.shape[0] == 0:
        return np.zeros(0, dtype=int)
    tree = cKDTree(pts)
    pairs = tree.query_pairs(tol, output_type="ndarray")

    parent = np.arange(pts.shape[0])

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    for a, b in pairs:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[ra] = rb
    for i in range(pts.shape[0]):
        find(i)
    # relabel -> 0..k-1
    _, node_ids = np.unique(parent, return_inverse=True)
    return node_ids


def build_graph() -> nx.MultiDiGraph:
    fc = _load_raw_edges()
    features = fc["features"]
    print(f"[graph] {len(features)} raw edges")

    pts_per_feature: list[np.ndarray] = []
    all_pts: list[tuple[float, float, float]] = []
    offset = 0
    offsets: list[int] = []
    for feat in features:
        geom = feat["geometry"]
        coords = geom["coordinates"]
        if geom["type"] == "LineString":
            parts = coords
        else:
            parts = [c for path in coords for c in path]
        proj = _project(parts)
        pts_per_feature.append(proj)
        n = proj[0].shape[0]
        offsets.append(offset)
        all_pts.extend(zip(*proj))
        offset += n

    all_pts_arr = np.asarray(all_pts, dtype=float)
    print(f"[graph] {all_pts_arr.shape[0]} vertices, merging at tol={MERGE_TOL_M} m...")
    cluster = _merge_nodes(all_pts_arr, MERGE_TOL_M)
    n_nodes = int(cluster.max()) + 1
    print(f"[graph] {n_nodes} nodes after merge")

    # node centroids (grid + lon/lat via inverse transform)
    inv = Transformer.from_crs(config.GRID_CRS, config.WGS84_CRS, always_xy=True)
    node_e = np.zeros(n_nodes)
    node_n = np.zeros(n_nodes)
    node_z = np.zeros(n_nodes)
    node_cnt = np.zeros(n_nodes)
    for i, (pt, c) in enumerate(zip(all_pts_arr, cluster)):
        node_e[c] += pt[0]
        node_n[c] += pt[1]
        node_z[c] += pt[2]
        node_cnt[c] += 1
    node_e /= node_cnt
    node_n /= node_cnt
    node_z /= node_cnt
    lon, lat = inv.transform(node_e, node_n)

    G = nx.MultiDiGraph()
    for c in range(n_nodes):
        G.add_node(c, x=float(lon[c]), y=float(lat[c]),
                   east=float(node_e[c]), north=float(node_n[c]), z=float(node_z[c]))

    speed_m = config.WALK_SPEED_MPM
    skipped = 0
    n_edges = 0
    for feat, pts, off in zip(features, pts_per_feature, offsets):
        props = feat.get("properties", {})
        feat_type = FEATURE_TYPE_NAMES.get(props.get("Feature_Type"), "Unknown")
        direction = int(props.get("Direction", 0) or 0)
        street = props.get("Street_Name") or ""
        e_arr, n_arr, z_arr = pts
        for i in range(e_arr.shape[0] - 1):
            diff = np.array([
                e_arr[i + 1] - e_arr[i],
                n_arr[i + 1] - n_arr[i],
                z_arr[i + 1] - z_arr[i],
            ])
            length = float(np.hypot(np.hypot(diff[0], diff[1]), diff[2]))
            u = int(cluster[off + i])
            v = int(cluster[off + i + 1])
            if u == v:
                skipped += 1
                continue
            data = {
                "length_m": length,
                "time_min": length / speed_m,
                "feat_type": feat_type,
                "direction": direction,
                "street": street,
                "enabled": bool(props.get("Enabled", 1) == 1),
                "route_id": props.get("Pedestrian_Route_ID"),
            }
            if direction == 1:      # one way forward (u -> v)
                G.add_edge(u, v, key=n_edges, **data)
                n_edges += 1
            elif direction == -1:   # one way backward (v -> u)
                G.add_edge(v, u, key=n_edges, **data)
                n_edges += 1
            else:                   # 0 = both ways
                G.add_edge(u, v, key=n_edges, **data)
                n_edges += 1
                G.add_edge(v, u, key=n_edges, **data)
                n_edges += 1

    print(f"[graph] nodes={G.number_of_nodes()} directed_edges={G.number_of_edges()} (skipped {skipped} degenerate)")
    comps = list(nx.weakly_connected_components(G))
    print(f"[graph] weakly-connected components: {len(comps)} (largest {max(len(c) for c in comps)} nodes)")

    G.graph["district"] = config.DISTRICT
    G.graph["crs"] = f"EPSG:{config.GRID_CRS}"
    G.graph["walk_speed_kmh"] = config.WALK_SPEED_KMH
    G.graph["merge_tol_m"] = MERGE_TOL_M
    return G


def main() -> None:
    if config.GRAPH_FILE.exists():
        if config.GRAPH_FILE.stat().st_mtime >= config.EDGES_FILE.stat().st_mtime:
            print(f"[graph] using cached graph: {config.GRAPH_FILE.name}")
            return

    t0 = time.time()
    G = build_graph()
    import pickle

    config.GRAPH_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(config.GRAPH_FILE, "wb") as fh:
        pickle.dump(G, fh, protocol=pickle.HIGHEST_PROTOCOL)
    print(f"[graph] nodes={G.number_of_nodes()} edges={G.number_of_edges()}")
    print(f"[graph] saved: {config.GRAPH_FILE.name}  ({time.time()-t0:.1f}s)")


if __name__ == "__main__":
    main()