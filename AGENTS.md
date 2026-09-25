# Project Summary

## Purpose

Interactive walking-network service area analysis for Hong Kong. Click a location on a map and see how many points are reachable within a given walking time (e.g. 15 minutes). Prototype scope is the **Sham Shui Po** district; architecture is designed to scale to all 18 districts / whole territory later.

## Tech Stack

- **Backend**: Python + FastAPI + Uvicorn (all currently installed in the local Python 3.14 environment)
- **Graph / geospatial**: NetworkX, Shapely, GeoPandas, SciPy, PyProj, OSMnx (OSM fallback only)
- **Frontend**: Leaflet (single HTML page served by FastAPI), LandsD Topographic Map API basemap tiles
- **Data**: Official LandsD **3D Pedestrian Network** (via public ArcGIS REST Feature Service), **iGeoCom** community facilities (public GeoJSON), **LandsD Topographic Map** basemap (public XYZ tiles), cropped with the 18 **District Boundary** polygons

## Data Sources

| Source | URL | Notes |
|---|---|---|
| 18 District boundaries | `https://www.had.gov.hk/psi/hong-kong-administrative-boundaries/hksar_18_district_boundary.json` | WGS84 GeoJSON FeatureCollection, 18 `Polygon` features; English district name in property `District` (e.g. `Sham Shui Po District`). |
| 3D Pedestrian Network (LandsD) | `https://services3.arcgis.com/6j1KwZfY2fZrfNMR/arcgis/rest/services/3DPN_LandsD_gdb/FeatureServer/0` | Public ArcGIS REST; `esriGeometryPolyline` with Z (true 3D), `maxRecordCount=2000` (paginate), query by bbox with `inSR/outSR=4326&f=geojson`. Fields include `Gradient`, `Direction`, `Feature_Type`, `Location`, `Wheelchair_*`, `Enabled`, `Floor_ID`, `Building_ID`, `Street_Name`. Integer code fields need the CSDI value-code data dictionary. |
| Geo-Community Database iGeoCom (LandsD) | `https://open.hkmapservice.gov.hk/OpenData/directDownload?productName=iGeoCom&sheetName=iGeoCom&productFormat=GEOJSON` | Whole-HK WGS84 GeoJSON inside a zip (quarterly), 37k+ POIs. `CLASS` taxonomy: `COM` = community facilities (822 in HK) with `TYPE` `CMC` (community centres/halls), `FSC` (family/IFS centres), `VOF`, `RCM`. Fields `ENGLISHNAME`, `CHINESENAME`, `E_ADDRESS`, `C_ADDRESS`, `E_DISTRICT`, `EASTING/NORTHING` (HK80). Needs `curl` download (gov host TLS cert fails Python `requests` chain). |
| LandsD Topographic Map (basemap) | `https://mapapi.geodata.gov.hk/gs/api/v1.0.0/xyz/basemap/WGS84/{z}/{x}/{y}.png` | Public XYZ PNG tiles (WGS84 = standard Web-Mercator scheme), zoom 10–20. Leaflet layer in `frontend/app.js`; LandsD attribution required (see CSDI Topographic Map API docs). |

## Project Structure

```
backend/
  ingest.py          # fetch district boundary + query 3D Pedestrian Network by bbox (paginated) -> data/*.geojson
  graph_builder.py   # merge edge endpoints in HK1980 Grid (EPSG:2326), build NetworkX graph, cache .gpickle
  points.py          # fetch LandsD iGeoCom Geo-Community Database (whole-HK GeoJSON), keep community facilities CLASS=COM + TYPE CMC/FSC, export bilingual names/addresses -> data/points.geojson
  service_area.py    # snap click -> dijkstra(cutoff) -> concave-hull polygon + accurate count + bilingual walking routes to reachable facilities
  main.py            # FastAPI app: GET /api/points & /api/district, POST /api/service-area & /api/route, serves frontend/
  run.py             # launcher that also works from inside backend/
frontend/
  index.html         # Leaflet map, 340px sidebar, bilingual facility popups, one-row layer toggles, minutes/speed sliders, reachable list, i-note popover
  app.js             # service area, map auto-fit, all-routes drawing, time-sorted reachable list, purple single-route highlight
data/                # cached raw edges, graph, points (generated, not checked in)
run.py               # root launcher (python run.py from anywhere)
README.md
```

## Core Behaviors / Rules

- **Walking cost**: at request time, edge `time_min = 3D length / selected walking speed`. 3D length uses Z (elevation). Default speed is **4.8 km/h**; the UI slider accepts **2–6 km/h**. Gradient / Tobler penalty is not applied.
- **Direction**: honour `Direction` code (one-way vs both ways).
- **Service area algorithm**: KDTree-snap click point to nearest node -> `networkx.single_source_dijkstra(G, node, cutoff=minutes)` with a request-specific time weight -> Shapely `concave_hull(ratio=0.8, allow_holes=False)` over reachable node coordinates for the display polygon.
- **Display-polygon limitation**: the green polygon is an approximate visualization envelope, not a true network-distance isochrone, and is not used for counting. It receives no normal outward buffer; only degenerate one-point/one-line hulls receive 25 m/10 m buffers. Sparse reachable nodes, original facility-marker coordinates not being hull inputs, and concavity bridging can create consistent-looking gaps or areas that do not exactly match the reachable network.
- **Bilingual facility details**: `points.py` exports `name_zh` and `address_zh` alongside English fields. Map popups and the reachable-facility list use Chinese as primary text and English as secondary text.
- **Map framing and route layers**: after each service-area response, the frontend fits the display polygon, snapped start marker, and all returned routes; automatic routes are blue, while a selected facility route is purple. Selecting a list row or marker refits and pans the target into a popup-safe area near map edges.
- **Walking-time omissions**: the constant-speed model does not add traffic-light or crossing delays, gradient/slope speed penalties, accessibility-barrier restrictions, or special speeds for stairs, escalators, lifts, and travelators. Click and facility coordinates are snapped to network nodes, so short access distances are excluded.
- **Counting**: accurate — snap each facility point to its nearest node and count points whose walk cost <= cutoff minutes (not just polygon containment).
- **Walking routes**: every service-area click returns a shortest-path LineString to each reachable facility (`routes` array, with `point_id`, bilingual `name`, `time_min`, `length_m`, and `path`); the frontend draws them all, populates a time-sorted sidebar list, and `/api/route` re-computes a single one for highlighting.
- **Sidebar interaction**: the left pane is 340px wide and scrollable; layer toggles share one row, the reachable-facility list is capped at 300px, and the walking-time note is opened from a small `i` popover that closes on outside click or Escape.
- **Sanity guard**: reject clicks farther than ~500 m from the network (e.g. clicks on water).
- Data source is swappable (`osm` fallback vs official network); `service_area.py` is source-agnostic.

## Roadmap (deferred / out of scope now)

- Whole Hong Kong performance (district-level subgraph caching or pgRouting-style setup).
- Indoor building links (3D Indoor Network), escalators/elevators via levels.
- Wheelchair-barrier filtering.
- Gradient/slope-aware walking speed (Tobler).