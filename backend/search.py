"""Place search via the Address Lookup Service (ALS).

Free-text query -> ALS `lookup` -> flat, bilingual candidate addresses that fall
inside the prototype district. Coordinates come back as WGS84 lat/lon, so a
result can be fed straight into the service-area computation.

ALS returns a deeply nested, slightly irregular payload (a building name may sit
under `EngPremisesAddress.BuildingName` *or* `EngEstate.EstateName`; Chinese
mirrors the same shape), so everything is normalised here before it reaches the
frontend.
"""

from __future__ import annotations

import json
import time
from typing import Any

import requests
from shapely.geometry import Point, shape

from . import config

MAX_LIMIT = 20
DEFAULT_LIMIT = 8
TIMEOUT_S = 8.0

# Repeat queries are cached in memory so typing / arrowing through results
# does not re-hit ALS for the same question. TTL matches ALS's own
# `Cache-Control: max-age=900, private`.
_CACHE: dict[tuple[str, int], tuple[float, dict]] = {}
_CACHE_MAX = 128
_CACHE_TTL_S = 900

_HEADERS = {"Accept": "application/json"}

_district_polygon = None


def _polygon():
    global _district_polygon
    if _district_polygon is None:
        with open(config.DISTRICT_FILE, encoding="utf-8") as fh:
            fc = json.load(fh)
        feature = next(
            f
            for f in fc["features"]
            if f["properties"].get("District") == config.DISTRICT
        )
        _district_polygon = shape(feature["geometry"])
    return _district_polygon


def _name_block(prem: dict) -> tuple[str | None, str | None]:
    """(English, Chinese) building/estate name."""
    eng = prem.get("EngPremisesAddress") or {}
    chi = prem.get("ChiPremisesAddress") or {}
    en = eng.get("BuildingName") or (eng.get("EngEstate") or {}).get("EstateName")
    zh = chi.get("BuildingName") or (chi.get("ChiEstate") or {}).get("EstateName")
    return en, zh


def _street_line(street: dict, *, chinese: bool) -> str:
    """Building number + street name, e.g. `37` + `UN CHAU STREET`."""
    name = street.get("StreetName") or ""
    no_from = street.get("BuildingNoFrom") or ""
    no_to = street.get("BuildingNoTo") or ""

    if no_from and no_to and no_to != no_from:
        number = f"{no_from}-{no_to}"
    else:
        number = no_from

    if chinese:
        return f"{name}{number}號" if name else (f"{number}號" if number else "")
    return " ".join(part for part in (number, name) if part)


def _address_blocks(prem: dict) -> tuple[str, str]:
    """(English, Chinese) one-line street/district address."""
    eng = prem.get("EngPremisesAddress") or {}
    chi = prem.get("ChiPremisesAddress") or {}

    en_parts = []
    en_street = _street_line(eng.get("EngStreet") or {}, chinese=False)
    if en_street:
        en_parts.append(en_street)
    en_district = (eng.get("EngDistrict") or {}).get("DcDistrict")
    if en_district:
        en_parts.append(en_district.title())

    zh_parts = []
    zh_street = _street_line(chi.get("ChiStreet") or {}, chinese=True)
    if zh_street:
        zh_parts.append(zh_street)
    zh_district = (chi.get("ChiDistrict") or {}).get("DcDistrict")
    if zh_district:
        zh_parts.append(zh_district)

    return ", ".join(en_parts), " ".join(zh_parts)


def _to_result(item: dict) -> dict[str, Any] | None:
    prem = ((item.get("Address") or {}).get("PremisesAddress")) or {}
    geo = prem.get("GeospatialInformation") or {}
    try:
        lat = float(geo["Latitude"])
        lng = float(geo["Longitude"])
    except (KeyError, TypeError, ValueError):
        return None

    en_name, zh_name = _name_block(prem)
    en_addr, zh_addr = _address_blocks(prem)
    score = (item.get("ValidationInformation") or {}).get("Score")
    return {
        "name": en_name,
        "name_zh": zh_name,
        "address": en_addr,
        "address_zh": zh_addr,
        "lat": lat,
        "lng": lng,
        "geoaddress": prem.get("GeoAddress"),
        "score": float(score) if isinstance(score, (int, float)) else None,
    }


def _cache_get(key: tuple[str, int]) -> dict | None:
    entry = _CACHE.get(key)
    if entry is None:
        return None
    ts, payload = entry
    if time.monotonic() - ts > _CACHE_TTL_S:
        _CACHE.pop(key, None)
        return None
    return payload


def _cache_put(key: tuple[str, int], payload: dict) -> None:
    now = time.monotonic()
    if len(_CACHE) >= _CACHE_MAX:
        for stale, (ts, _) in list(_CACHE.items()):
            if now - ts > _CACHE_TTL_S:
                _CACHE.pop(stale, None)
        while len(_CACHE) >= _CACHE_MAX:  # oldest first (insertion order)
            _CACHE.pop(next(iter(_CACHE)))
    _CACHE[key] = (now, payload)


def _match_tier(query_lower: str, r: dict) -> int:
    """Rank boost so an exact hit beats an ALS fuzzy guess.

    ALS scores street queries loosely (a `欽州街` query can rank `通州街`
    premises within a few points), so sort order must reward rows whose name
    or address actually contains what the user typed. Fields are tested one at
    a time so a query can never match across a field boundary.
    """
    for field in (r["name"], r["name_zh"]):
        if field and query_lower in field.lower():
            return 2
    for field in (r["address"], r["address_zh"]):
        if field and query_lower in field.lower():
            return 1
    return 0


def search(query: str, limit: int = DEFAULT_LIMIT) -> dict[str, Any]:
    """Search ALS and keep only hits inside the prototype district."""
    q = (query or "").strip()
    if not q:
        return {"ok": True, "query": q, "results": []}

    try:
        limit = max(1, min(int(limit), MAX_LIMIT))
    except (TypeError, ValueError):
        limit = DEFAULT_LIMIT

    key = (q, limit)
    cached = _cache_get(key)
    if cached is not None:
        return cached

    try:
        polygon = _polygon()
    except (OSError, StopIteration, KeyError, TypeError, ValueError):
        # data/district_boundary.geojson has not been fetched yet.
        return {
            "ok": False,
            "error": "District boundary data is missing — run `python -m backend.ingest`.",
        }

    try:
        resp = requests.get(
            config.ALS_LOOKUP_URL,
            params={"q": q},
            headers=_HEADERS,
            timeout=TIMEOUT_S,
        )
        resp.raise_for_status()
        payload = resp.json()
    except (requests.RequestException, ValueError):
        return {"ok": False, "error": "Address lookup is unavailable right now."}
    if not isinstance(payload, dict):
        return {"ok": False, "error": "Address lookup returned an unexpected response."}

    q_lower = q.lower()
    results = [
        r
        for r in (
            _to_result(item)
            for item in payload.get("SuggestedAddress") or []
            if isinstance(item, dict)
        )
        if r is not None and polygon.covers(Point(r["lng"], r["lat"]))
    ]
    # Exact name > exact address > ALS fuzzy, then by ALS relevance score.
    results.sort(
        key=lambda r: (
            _match_tier(q_lower, r),
            r["score"] is not None,
            r["score"] or 0,
        ),
        reverse=True,
    )

    out = {"ok": True, "query": q, "results": results[:limit]}
    _cache_put(key, out)
    return out


if __name__ == "__main__":
    import sys

    # Windows consoles default to cp1252, which cannot encode Chinese.
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    for term in ("sham shui po", "un chau street", "nothing matches this"):
        out = search(term, limit=4)
        print(f"\n== {term!r} -> {len(out['results'])} in district")
        for r in out["results"]:
            print(
                f"  {r['name']} | {r['name_zh']} | {r['address']} | "
                f"({r['lat']}, {r['lng']}) score={r['score']}"
            )
