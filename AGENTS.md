# Project Summary

## Purpose

Interactive walking-network service area analysis for Hong Kong. Click a location on a map and see how many points are reachable within a given walking time (e.g. 15 minutes). Prototype scope is the **Sham Shui Po** district; architecture is designed to scale to all 18 districts / whole territory later.

## Tech Stack

- **Backend**: Python + FastAPI + Uvicorn (all currently installed in the local Python 3.13 virtual environment)
- **Graph / geospatial**: NetworkX, Shapely, GeoPandas, SciPy, PyProj, OSMnx (OSM fallback only)
- **Frontend**: Leaflet (single HTML page served by FastAPI), LandsD Topographic Map API basemap tiles
- **Deployment**: Render Blueprint (`render.yaml`), free plan, Python from `.python-version` (3.13)
- **Data**: Official LandsD **3D Pedestrian Network** (via public ArcGIS REST Feature Service), **iGeoCom** community facilities (public GeoJSON), **LandsD Topographic Map** basemap (public XYZ tiles), **Address Lookup Service (ALS)** for place search, cropped with the 18 **District Boundary** polygons

## Data Sources

| Source | URL | Notes |
|---|---|---|
| 18 District boundaries | `https://www.had.gov.hk/psi/hong-kong-administrative-boundaries/hksar_18_district_boundary.json` | WGS84 GeoJSON FeatureCollection, 18 `Polygon` features; English district name in property `District` (e.g. `Sham Shui Po District`). |
| 3D Pedestrian Network (LandsD) | `https://services3.arcgis.com/6j1KwZfY2fZrfNMR/arcgis/rest/services/3DPN_LandsD_gdb/FeatureServer/0` | Public ArcGIS REST; `esriGeometryPolyline` with Z (true 3D), `maxRecordCount=2000` (paginate), query by bbox with `inSR/outSR=4326&f=geojson`. Fields include `Gradient`, `Direction`, `Feature_Type`, `Location`, `Wheelchair_*`, `Enabled`, `Floor_ID`, `Building_ID`, `Street_Name`. Integer code fields need the CSDI value-code data dictionary. |
| Geo-Community Database iGeoCom (LandsD) | `https://open.hkmapservice.gov.hk/OpenData/directDownload?productName=iGeoCom&sheetName=iGeoCom&productFormat=GEOJSON` | Whole-HK WGS84 GeoJSON inside a zip (quarterly), 37k+ POIs. `CLASS` taxonomy: `COM` = community facilities (822 in HK) with `TYPE` `CMC` (community centres/halls), `FSC` (family/IFS centres), `VOF`, `RCM`. Fields `ENGLISHNAME`, `CHINESENAME`, `E_ADDRESS`, `C_ADDRESS`, `E_DISTRICT`, `EASTING/NORTHING` (HK80). The host serves an **incomplete TLS chain**: Windows curl succeeds (OS cert store), Linux curl exits 60, so `backend/points.py` prefers curl and falls back to `requests` with `verify=False` (warning suppressed for that call only). |
| LandsD Topographic Map (basemap) | `https://mapapi.geodata.gov.hk/gs/api/v1.0.0/xyz/basemap/WGS84/{z}/{x}/{y}.png` | Public XYZ PNG tiles (WGS84 = standard Web-Mercator scheme), zoom 10–20. Leaflet layer in `frontend/app.js`; LandsD attribution required (see CSDI Topographic Map API docs). |
| Address Lookup Service (ALS, Digital Policy Office) | `https://www.als.gov.hk/lookup?q={query}` | Free-text place/address search, no API key. JSON via `Accept: application/json` (default is XML). Returns bilingual names, street/district, WGS84 lat/lon, GeoAddress ID, relevance `Score`. Used by `backend/search.py`; results filtered to the prototype district polygon. |

## Project Structure

```
backend/
  ingest.py          # fetch district boundary + query 3D Pedestrian Network by bbox (paginated) -> data/*.geojson
  graph_builder.py   # merge edge endpoints in HK1980 Grid (EPSG:2326), build NetworkX graph, cache .gpickle
  points.py          # fetch LandsD iGeoCom Geo-Community Database (whole-HK GeoJSON), keep community facilities CLASS=COM + TYPE CMC/FSC, export bilingual names/addresses -> data/points.geojson
  search.py          # ALS place search: normalize the nested schema -> {name, name_zh, address, address_zh, lat, lng, geoaddress, score}; keep only hits inside this district
  service_area.py    # snap click -> dijkstra(cutoff) -> concave-hull polygon + accurate count + bilingual walking routes to reachable facilities
  main.py            # FastAPI app: GET /api/points, /api/district & /api/search, POST /api/service-area & /api/route, serves frontend/
  run.py             # launcher that also works from inside backend/
frontend/
  index.html         # Leaflet map, 340px sidebar, search box, top-right facility details card, top-right layer toggles control, side-by-side minutes/speed sliders with the i-note button, reachable list, bottom-right map legend
  app.js             # service area, place search (debounced), map auto-fit, all-routes drawing, time-sorted reachable list, purple single-route highlight, top-right details card control, legend control, reachable-facility labels
data/                # cached raw edges, graph, points (generated, not checked in)
run.py               # root launcher (python run.py from anywhere)
render.yaml          # Render Blueprint: build = pipeline, start = uvicorn, health = /api/health
.python-version      # Python version for Render (3.13)
README.md
AGENTS.md            # project summary / conventions
```

## Core Behaviors / Rules

- **Walking cost**: at request time, edge `time_min = 3D length / selected walking speed`. 3D length uses Z (elevation). Default speed is **4.8 km/h**; the UI slider accepts **2–6 km/h**. Gradient / Tobler penalty is not applied.
- **Direction**: honour `Direction` code (one-way vs both ways).
- **Service area algorithm**: KDTree-snap click point to nearest node -> `networkx.single_source_dijkstra(G, node, cutoff=minutes)` with a request-specific time weight -> Shapely `concave_hull(ratio=0.8, allow_holes=False)` over reachable node coordinates for the display polygon.
- **Display-polygon limitation**: the green polygon is an approximate visualization envelope, not a true network-distance isochrone, and is not used for counting. It receives no normal outward buffer; only degenerate one-point/one-line hulls receive 25 m/10 m buffers. Sparse reachable nodes, original facility-marker coordinates not being hull inputs, and concavity bridging can create consistent-looking gaps or areas that do not exactly match the reachable network.
- **Bilingual facility details**: `points.py` exports `name_zh` and `address_zh` alongside English fields. The details card and the reachable-facility list use Chinese as primary text and English as secondary text.
- **Map framing and route layers**: after each service-area response, the frontend fits the display polygon, snapped start marker, and all returned routes; automatic routes are blue, while a selected facility route is purple. Selecting a facility (label, dot or sidebar row) draws the purple route and frames it together with the facility it ends at (`fitBounds` on route + facility + start marker, `padding: [70,70]`, `maxZoom: 18`) and then zooms out one level (`map.zoomOut(1)`, no animation) so the route is seen in the context of its surroundings rather than filling the map. The zoom-out runs **before** `panClearOfCard()`, so the clearance check uses the final projection. The view is always framed explicitly — Leaflet never pans the map on its own; the single deliberate exception is `panClearOfCard()`, which nudges the map right after a fit if the selected facility would otherwise sit behind the top-right details card.
- **Facility details live in a top-right map card, not in a marker pop-up**: a pop-up covers map points and forced the route framing to measure the pop-up footprint. Instead, `frontend/index.html` places a **details card** (`#facilityCard`) that `frontend/app.js` registers as a plain **Leaflet control** (`L.Control.extend`, `position: "topright"`, `onAdd` returns the existing element and calls `L.DomEvent.disableClickPropagation` + `disableScrollPropagation`), so it floats over the map's top-right corner, stacks with the other overlays, and a click inside it can never start a new computation. The card is filled from the `/api/points` properties the frontend already loaded (`pointProps` map: `name`, `name_zh`, `type`, `address`, `address_zh`) plus the `/api/route` time and distance — no backend change was needed. `renderFacilityCard()` shows it, `clearFacilityCard()` hides it (the `×` button and `Escape`; the purple route and the selection highlights stay). Because the card overlays the map, `showRoute()` renders the card **before** `fitBounds` and then calls `panClearOfCard(targetLatLng)`, which nudges the map (`map.panBy`, no animation) only if the framed facility dot would fall behind the card's rect (+20 px). No `bindPopup` is used anywhere any more.
- **Reachable-facility labels**: a name on every reachable facility covers the map, so the names are placed by a small greedy layout instead. The labels live in their own overlay (`reach-labels`, appended to the map container) and are positioned in screen space with `map.latLngToContainerPoint()`. For each facility — closest first — the layout tries eight slots around its dot (right / left / above / below + diagonals) and takes the first that does not intersect an already-placed label (2 px gap); a label that does not fit is **hidden** rather than overlapping another one. Chip sizes are measured once, so the layout is cheap enough to re-run on every `move`/`zoom`/`resize` (rAF-debounced) and the names stay glued to their dots. Chips are real `<button>`s (Chinese name, `aria-label` with the walking time); hovering shows a tooltip with the name, time and distance; clicking selects that facility (purple route + details card). A chip's click is confined with `L.DomEvent.disableClickPropagation`, so it never starts a new service-area computation. Labels are never suppressed — the selected facility's label is **highlighted** (`.is-active`), next to a highlighted sidebar row (`.is-selected`) and a restyled purple dot, so the corner card still has a clear on-map anchor. Facility dots also set `bubblingMouseEvents: false` — selecting a facility highlights its route instead of recomputing.
- **Walking-time omissions**: the constant-speed model does not add traffic-light or crossing delays, gradient/slope speed penalties, accessibility-barrier restrictions, or special speeds for stairs, escalators, lifts, and travelators. Click and facility coordinates are snapped to network nodes, so short access distances are excluded.
- **Counting**: accurate — snap each facility point to its nearest node and count points whose walk cost <= cutoff minutes (not just polygon containment).
- **Walking routes**: every service-area click returns a shortest-path LineString to each reachable facility (`routes` array, with `point_id`, bilingual `name`, `time_min`, `length_m`, and `path`); the frontend draws them all, populates a time-sorted sidebar list, and `/api/route` re-computes a single one for highlighting.
- **Place search**: `backend/search.py` proxies the ALS `lookup` endpoint (`Accept: application/json`), normalizes the nested schema, and keeps only hits whose WGS84 point falls inside this district's polygon (Shapely `covers`). Results are ranked exact-first (query appears in name > in address > ALS fuzzy) and then by ALS relevance score, because street queries come back loosely scored. The frontend search box calls `/api/search` with a ~300 ms debounce and an `AbortController`; each row shows name, English name, and Chinese + English address with the matched text highlighted; picking a result sets the start point and triggers the same `compute()` flow as a map click. ALS fails soft to `{ok: false, error}`.
- **Sidebar interaction**: the left pane is 340px wide and not scrollable as a whole (flex column, `overflow: hidden`); the title, search and sliders stay pinned at their natural height, and only the reachable-facility list (`.facility-list-items`) scrolls inside the remaining space. The minutes and speed sliders sit side by side in one row with a small `i` button; it opens the walking-time note as a popover that closes on outside click or Escape.
- **Clear results**: a "× Clear" button in the reachable-list heading (shown only with results) removes the service area, routes, list, labels, details card, selection and the start marker, and resets the stored start coordinates.
- **Layer toggles**: the "Community facilities" and "District boundary" checkboxes live in a custom top-right `L.Control` (`.layer-control`, built in `app.js`), not in the sidebar. The control stops click and scroll propagation, and `updateLayers()` reads its checkboxes.
- **Map legend**: a bottom-right Leaflet control (`L.Control` custom class in `app.js`, no plugin) explains the symbols — service-area polygon, all routes (blue), selected route (purple), community facility, snapped start pin, and district boundary. Swatches use a fixed 18px column so all symbols share one centre line; the start swatch reuses the real Leaflet default marker icon (`new L.Icon.Default().createIcon()`), with its native size and anchor margins reset inline because `createIcon()` overrides CSS.
- **Sanity guard**: reject clicks farther than ~500 m from the network (e.g. clicks on water).
- Data source is swappable (`osm` fallback vs official network); `service_area.py` is source-agnostic.

## Deployment

- **Platform**: Render Blueprint (`render.yaml`) — free plan, Python version from `.python-version` (3.13). No environment variables or secrets: every data source and the ALS are public.
- **Build** (`buildCommand`): `pip install -r requirements.txt` then `python -m backend.ingest` → `python -m backend.graph_builder` → `python -m backend.points`. All three steps are **idempotent** — each skips when its output already exists in `data/`.
- **Start** (`startCommand`): `uvicorn backend.main:app --host 0.0.0.0 --port $PORT`. This bypasses the local `run.py` launcher (dev-only: reload + dual-stack bind).
- **Health**: `healthCheckPath: /api/health` → `{status, district, nodes, edges}`; it loads the cached graph pickle, so the first call warms the instance. `/health` is also exposed as an alias, because dev tools/agents that probe a project server conventionally request `/health` (without it they fill the access log with 404s).
- **`data/` is gitignored** (~81 MB of derived artefacts: district boundary, 3D edges, graph pickle, iGeoCom raw, points). It exists only inside the build image, so a deploy **must** run the pipeline. Render does not cache repository directories, so every deploy re-downloads the 48 MB iGeoCom file and re-runs the ~1 min ingest.
- **Static frontend**: `backend/main.py` mounts `frontend/` at `/` via `StaticFiles(html=True)`; the API routes are registered *before* the mount, so they take precedence over it.
- **Free plan caveat**: the instance spins down when idle; the next request re-reads the cached graph (~0.2 s), so the first request after an idle period is slightly slower. The ALS search cache is per-instance and in-memory (TTL 900 s), so it is empty again after a spin-down.
- `backend/__init__.py` exists so `backend` is a real package (`python -m backend.*` works on any Python 3.3+; the empty file also keeps relative imports explicit).

## Roadmap (deferred / out of scope now)

- Whole Hong Kong performance (district-level subgraph caching or pgRouting-style setup).
- Indoor building links (3D Indoor Network), escalators/elevators via levels.
- Wheelchair-barrier filtering.
- Gradient/slope-aware walking speed (Tobler).