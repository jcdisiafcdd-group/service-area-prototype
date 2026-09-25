"""Service-area computation (source-agnostic).

Click -> snap to nearest graph node -> dijkstra with time cutoff -> concave-hull
isochrone polygon, plus an accurate count of reachable test points (measured by
walk cost on the graph, not polygon containment).

The expensive graph is loaded once from the pickle cache and reused; each click
is a fast in-memory shortest-path search.
"""

from __future__ import annotations

import functools
import pickle
import time
from typing import Any

import networkx as nx
import numpy as np
from pyproj import Transformer
from scipy.spatial import cKDTree
from shapely.geometry import MultiPoint, mapping

from . import config

_GRAPH = None
_NODE_TREE = None
_NODE_LIST: list[int] = []
_NODE_INDEX: dict = {}
_POINT_NODES = None
_POINTS_FC = None
_TRANSFORMER = None


def _transform() -> Transformer:
    global _TRANSFORMER
    if _TRANSFORMER is None:
        _TRANSFORMER = Transformer.from_crs(
            config.WGS84_CRS, config.GRID_CRS, always_xy=True
        )
    return _TRANSFORMER


@functools.lru_cache(maxsize=1)
def _load() -> tuple:
    global _GRAPH, _NODE_TREE, _NODE_LIST, _NODE_INDEX
    t0 = time.time()
    with open(config.GRAPH_FILE, "rb") as fh:
        _GRAPH = pickle.load(fh)
    _NODE_LIST = list(_GRAPH.nodes)
    _NODE_INDEX = {u: i for i, u in enumerate(_NODE_LIST)}
    east = np.array([_GRAPH.nodes[u]["east"] for u in _NODE_LIST])
    north = np.array([_GRAPH.nodes[u]["north"] for u in _NODE_LIST])
    _NODE_TREE = cKDTree(np.column_stack([east, north]))
    print(f"[service_area] graph loaded: {len(_NODE_LIST)} nodes in {time.time()-t0:.2f}s")
    return _GRAPH, _NODE_TREE


def _point_nodes(points_xy: np.ndarray) -> np.ndarray:
    global _POINT_NODES
    if _POINT_NODES is None:
        e, n = _transform().transform(points_xy[:, 0], points_xy[:, 1])
        g, tree = _load()
        _POINT_NODES = tree.query(np.column_stack([e, n]))[1]
    return _POINT_NODES


def load_points() -> np.ndarray:
    import json

    with open(config.POINTS_FILE, encoding="utf-8") as fh:
        fc = json.load(fh)
    pts = np.array(
        [f["geometry"]["coordinates"] for f in fc["features"]], dtype=float
    )
    return pts


def snap(lon: float, lat: float) -> int | None:
    e, n = _transform().transform(lon, lat)
    g, tree = _load()
    dist, idx = tree.query([e, n], k=1)
    if dist > config.SNAP_MAX_M:
        return None
    return _NODE_LIST[idx]


def service_area(lon: float, lat: float, minutes: float) -> dict[str, Any]:
    g, _ = _load()
    t0 = time.time()

    start = snap(lon, lat)
    if start is None:
        return {"ok": False, "error": "Click is not near the pedestrian network."}

    lengths, paths = nx.single_source_dijkstra(
        g, start, cutoff=minutes, weight="time_min"
    )

    n = g.number_of_nodes()
    cost_arr = np.full(n, np.inf)
    for u, c in lengths.items():
        cost_arr[_NODE_INDEX[u]] = c

    points = load_points()
    pt_nodes = _point_nodes(points)
    count = int(np.sum(cost_arr[pt_nodes] <= minutes))

    reachable = list(lengths.keys())
    coords = [(g.nodes[u]["x"], g.nodes[u]["y"]) for u in reachable]
    polygon = _make_polygon(coords)

    features = _points_fc()["features"]
    routes = []
    for i, pt_node in enumerate(pt_nodes):
        if cost_arr[pt_node] > minutes:
            continue
        path = paths.get(pt_node)
        if not path:
            continue
        rcoords = [[g.nodes[u]["x"], g.nodes[u]["y"]] for u in path]
        length_m = 0.0
        for j in range(len(path) - 1):
            parallel = g.get_edge_data(path[j], path[j + 1])
            length_m += min(ed["length_m"] for ed in parallel.values())
        routes.append({
            "point_id": features[i]["properties"]["id"],
            "name": features[i]["properties"].get("name"),
            "time_min": round(lengths[pt_node], 1),
            "length_m": round(length_m, 0),
            "path": {"type": "LineString", "coordinates": rcoords},
        })

    snapped_node = g.nodes[start]
    return {
        "ok": True,
        "count": count,
        "total_points": len(points),
        "reachable_nodes": len(reachable),
        "minutes": minutes,
        "snapped": {"lon": snapped_node["x"], "lat": snapped_node["y"]},
        "district": config.DISTRICT,
        "polygon": polygon,
        "routes": routes,
        "ms": round((time.time() - t0) * 1000, 1),
    }


def _points_fc() -> dict[str, Any]:
    global _POINTS_FC
    if _POINTS_FC is None:
        import json

        with open(config.POINTS_FILE, encoding="utf-8") as fh:
            _POINTS_FC = json.load(fh)
    return _POINTS_FC


def route(lon: float, lat: float, point_id: int) -> dict[str, Any]:
    """Shortest walking path + metrics from a click to one facility point."""
    g, _ = _load()
    t0 = time.time()

    start = snap(lon, lat)
    if start is None:
        return {"ok": False, "error": "Click is not near the pedestrian network."}

    target_ftr = next(
        (f for f in _points_fc()["features"]
         if f["properties"].get("id") == point_id),
        None,
    )
    if target_ftr is None:
        return {"ok": False, "error": "Unknown facility id."}

    dlon, dlat = target_ftr["geometry"]["coordinates"]
    target = snap(dlon, dlat)
    if target is None:
        return {"ok": False, "error": "Facility is not near the pedestrian network."}

    try:
        dist_time, path = nx.bidirectional_dijkstra(g, start, target, weight="time_min")
    except nx.NetworkXNoPath:
        return {"ok": False, "error": "No walking route found to that facility."}

    coords = [[g.nodes[u]["x"], g.nodes[u]["y"]] for u in path]
    length_m = 0.0
    for i in range(len(path) - 1):
        parallel = g.get_edge_data(path[i], path[i + 1])
        length_m += min(ed["length_m"] for ed in parallel.values())

    snapped = g.nodes[start]
    return {
        "ok": True,
        "point_id": point_id,
        "name": target_ftr["properties"].get("name"),
        "time_min": round(dist_time, 1),
        "length_m": round(length_m, 0),
        "snapped": {"lon": snapped["x"], "lat": snapped["y"]},
        "path": {"type": "LineString", "coordinates": coords},
        "ms": round((time.time() - t0) * 1000, 1),
    }


def _make_polygon(coords: list[tuple[float, float]]) -> dict[str, Any] | None:
    if not coords:
        return None
    mp = MultiPoint(coords)
    try:
        hull = mp.concave_hull(ratio=0.8, allow_holes=False)
    except Exception:
        hull = mp.convex_hull
    if hull.geom_type == "Point":
        hull = hull.buffer(25)
    elif hull.geom_type == "LineString":
        hull = hull.buffer(10)
    return mapping(hull)


if __name__ == "__main__":
    g, tree = _load()
    print(f"nodes={g.number_of_nodes()} edges={g.number_of_edges()}")
    points = load_points()
    print(f"points={len(points)}")
    test = service_area(114.1630, 22.3300, 15)
    print({k: v for k, v in test.items() if k != "polygon"})
    test5 = service_area(114.1630, 22.3300, 5)
    print("5min count:", test5["count"], test5["reachable_nodes"])
    print("15min count:", test["count"], test["reachable_nodes"])