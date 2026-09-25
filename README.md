# Walking Service-Area Prototype (Hong Kong)

Interactive walking-network service area analysis. Click a location on the map and see how many points are reachable within a given walking time (default 15 minutes).

Prototype scope: **Sham Shui Po** district, built on the official **LandsD 3D Pedestrian Network**. The pipeline is district-parameterised, so it can expand to all 18 districts / whole Hong Kong.

---

## Features

- Official **3D Pedestrian Network** (LandsD) — true 3D polylines (elevation-aware), cropped to a district via the 18-District boundary.
- Official **basemap** — LandsD Topographic Map API (WGS84 XYZ tiles), so the map face is the official HK topographic map.
- **Community-facility destinations** — the point layer is real data: LandsD iGeoCom community facilities (`CLASS=COM`, `TYPE=CMC` community centres/halls + `TYPE=FSC` family/IFS centres), not random points.
- **Service area**: click the map → the backend does a shortest-path search on the walk graph with a time cutoff and returns a concave-hull isochrone polygon + an accurate reachable-facility count.
- **Walking routes**: routes to *every* reachable facility are drawn from the click point; click any facility marker to highlight that single route with walk time & distance.
- **Accurate counting**: each facility is snapped to its nearest graph node and counted only if its walking cost ≤ cutoff minutes (not just "is it inside the polygon").
- Minutes slider (5–30, default 15) to explore how the reachable area/count changes.

## Tech Stack

- **Backend**: Python 3.14 + FastAPI + Uvicorn + NetworkX + GeoPandas / Shapely / SciPy / PyProj
- **Frontend**: Leaflet (single HTML page served by FastAPI)
- **Data**: LandsD 3D Pedestrian Network (public ArcGIS REST Feature Service), LandsD iGeoCom community facilities (public GeoJSON), LandsD Topographic Map basemap (public XYZ tiles), crop via Home Affairs Department 18-District boundary (public GeoJSON)

---

## Project Structure

```
pp-proj2-prototype/
  backend/
    ingest.py          # fetch district boundary + query 3D Pedestrian Network by bbox (paginated) -> data/*.geojson
    graph_builder.py   # merge edge endpoints in HK1980 Grid (EPSG:2326), build NetworkX graph, cache pickle
    points.py          # fetch LandsD iGeoCom, keep community facilities (CLASS=COM, TYPE=CMC/FSC), crop -> data/points.geojson
    service_area.py    # snap click -> dijkstra(cutoff) -> isochrone polygon + accurate count + routes to reachable facilities
    main.py            # FastAPI app: GET /api/points, POST /api/service-area + /api/route, serves frontend/
    run.py             # launcher that also works from inside backend/
  frontend/
    index.html         # Leaflet map, official basemap, district outline + facility toggles, minutes slider
    app.js             # service area, all-routes drawing, single-route highlight on marker click
  data/                # cached raw edges, graph, points (generated — not checked in)
  venv/                # Python virtual environment
  requirements.txt
  run.py               # root launcher (python run.py from anywhere)
  AGENTS.md            # project summary / conventions
```

---

## Setup

### 1. Prerequisites

- Python 3.14.x on PATH
- An internet connection (first run downloads district data)

### 2. Create and activate the virtual environment

```powershell
# create (only if venv/ does not exist yet)
python -m venv venv

# activate each session
.\venv\Scripts\Activate.ps1
```

### 3. Install dependencies

```powershell
pip install -r requirements.txt
```

### 4. Build the data pipeline (one-time, per district)

Run from the project root:

```powershell
python -m backend.ingest          # downloads 18-district boundary + Sham Shui Po 3D pedestrian edges -> data/
python -m backend.graph_builder   # builds & caches the walk graph -> data/
python -m backend.points          # fetches community facilities (iGeoCom) -> data/
```

> All of the above are cached in `data/` and re-run harmlessly to refresh.

---

## Running

```powershell
# The launchers below work from the project root OR from inside backend\.
# (The older error "No module named 'backend'" only happens when running
# uvicorn directly from inside backend\ without a launcher.)

# Option A — from the project root:
cd C:\work\pp-proj2-prototype
.\venv\Scripts\Activate.ps1
python run.py

# Option B — from inside backend\:
cd C:\work\pp-proj2-prototype\backend
..\venv\Scripts\Activate.ps1
python run.py
```

Open http://localhost:8000 in a browser.

> Startup is fast (~1–2 s): the graph is only *unpickled* at boot, never rebuilt.
> The slow ingest + graph-build steps run once and are cached in `data/`,
> so restarting the server never re-runs them.

### Usage

1. The map loads centred on Sham Shui Po with the district outline and its **28 community facilities** (iGeoCom `CMC`/`FSC`) on the official LandsD basemap.
2. **Click anywhere on the district** — the backend computes the service area for the cutoff shown on the slider.
3. A green isochrone polygon is drawn, a blue route to **every reachable facility** is drawn from the click point, and the panel reports **"N facilities reachable within X min"**.
4. **Click any facility marker** to highlight its single walking route (thicker blue line) with walk time & distance.
5. Drag the **minutes slider** (5–30) to recompute.

### API

| Endpoint | Method | Body / Params | Returns |
|---|---|---|---|
| `/` | GET | — | Leaflet frontend |
| `/api/health` | GET | — | `{status, district, nodes, edges}` |
| `/api/district` | GET | — | selected district boundary (GeoJSON) |
| `/api/points` | GET | — | GeoJSON of community facilities (CMC/FSC) |
| `/api/service-area` | POST | `{"lat": 22.33, "lng": 114.16, "minutes": 15}` | `{ok, count, total_points, reachable_nodes, snapped, polygon, routes}` |
| `/api/service-area` | POST | click far from network | `{ok: false, error: "..."}` (HTTP 422) |
| `/api/route` | POST | `{"lat": 22.33, "lng": 114.16, "point_id": 1}` | `{ok, name, time_min, length_m, snapped, path}` (LineString) |

---

## Configuration

| Setting | Where | Default |
|---|---|---|
| Walking speed | `backend/graph_builder.py` (`WALK_SPEED_KMH`) | 4.8 km/h |
| Prototype district | `backend/config.py` (or ingest CLI arg) | `Sham Shui Po District` |
| Facility points | `backend/points.py` (`CLASS`/`TYPES`) | iGeoCom `COM` + `CMC`/`FSC` (28 in SSP) |
| Minutes slider range | `frontend/app.js` | 5–30 |

---

## Data Sources

| Source | URL | Notes |
|---|---|---|
| 18 District boundaries | `https://www.had.gov.hk/psi/hong-kong-administrative-boundaries/hksar_18_district_boundary.json` | WGS84 GeoJSON, 18 `Polygon` features; `District` property = English name. |
| 3D Pedestrian Network (LandsD) | `https://services3.arcgis.com/6j1KwZfY2fZrfNMR/arcgis/rest/services/3DPN_LandsD_gdb/FeatureServer/0` | Public ArcGIS REST; 3D polylines (Z), `maxRecordCount=2000` (paginated); fields incl. `Gradient`, `Direction`, `Feature_Type`, `Wheelchair_*`, `Enabled`. |
| Geo-Community Database (iGeoCom, LandsD) | `https://open.hkmapservice.gov.hk/OpenData/directDownload?productName=iGeoCom&sheetName=iGeoCom&productFormat=GEOJSON` | Whole-HK WGS84 GeoJSON (zip, quarterly). `CLASS=COM` community facilities; `TYPE=CMC` (community centres/halls), `FSC` (family/IFS centres). Also `VOF`, `RCM`. |
| LandsD Topographic Map (basemap) | `https://mapapi.geodata.gov.hk/gs/api/v1.0.0/xyz/basemap/WGS84/{z}/{x}/{y}.png` | Public XYZ PNG tiles (WGS84 Web-Mercator scheme), zoom 10–20; LandsD attribution shown on map. |
| OSM (fallback only) | via OSMnx | Used only if the official network is unavailable. |

## How the service area works

1. **Snap** — the clicked point is snapped to its nearest graph node (scipy `cKDTree`). Clicks > ~500 m from the network are rejected (e.g. water).
2. **Search** — `networkx.single_source_dijkstra(G, node, cutoff=minutes)` finds every node reachable within the cutoff *and* the shortest path to each.
3. **Polygon** — a Shapely `concave_hull` over the reachable node coordinates produces the display isochrone.
4. **Count** — each facility is snapped to its nearest node and counted when its walk cost ≤ cutoff.
5. **Routes** — the path to every reachable facility is returned as a LineString (the frontend draws them all; `/api/route` exposes any single one).

Walking cost per edge: `time_min = 3D length / walking speed`. Because the network carries real Z values, slopes are priced with true surface distance. (Gradient/Tobler speed penalties and wheelchair-barrier filtering are deferred.)

### Performance (measured, Sham Shui Po)

| Step | Time |
|---|---|
| Ingest (3D network crop, ~21 API pages) | ~1 min (network-bound, cached) |
| Graph build (23.6k edges → 35.5k nodes, 78k directed edges) | ~1.2 s (cached) |
| Server startup (graph unpickle) | ~0.15 s |
| One service-area click (snap + Dijkstra + hull + count + routes) | ~200–300 ms |

The graph, points and raw edges are cached in `data/` — rebuilds only happen when
you delete the cache or run with `--force`.

---

## Roadmap (not yet implemented)

- Whole-Hong Kong performance (district subgraph caching or pgRouting-style setup).
- Indoor building links (3D Indoor Network), escalators/lifts via levels.
- Wheelchair-barrier filtering.
- Slope-aware walking speed (Tobler).