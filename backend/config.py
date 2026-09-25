from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
FRONTEND_DIR = ROOT / "frontend"


def slugify(name: str) -> str:
    return name.lower().replace(" ", "_")


DISTRICT = "Sham Shui Po District"

WALK_SPEED_KMH = 4.8
WALK_SPEED_MPM = WALK_SPEED_KMH * 1000 / 60  # metres per minute

SNAP_MAX_M = 500.0

# Data source URLs
DISTRICT_BOUNDARY_URL = (
    "https://www.had.gov.hk/psi/"
    "hong-kong-administrative-boundaries/hksar_18_district_boundary.json"
)
PED_NETWORK_URL = (
    "https://services3.arcgis.com/6j1KwZfY2fZrfNMR/arcgis/"
    "rest/services/3DPN_LandsD_gdb/FeatureServer/0"
)
PED_NETWORK_QUERY_URL = PED_NETWORK_URL + "/query"

# HK1980 Grid (metres)
GRID_CRS = 2326
WGS84_CRS = 4326

DISTRICT_FILE = DATA_DIR / "district_boundary.geojson"
EDGES_FILE = DATA_DIR / f"{slugify(DISTRICT)}_edges.geojson"
GRAPH_FILE = DATA_DIR / f"{slugify(DISTRICT)}_graph.gpickle"
POINTS_FILE = DATA_DIR / "points.geojson"

IGEOCOM_URL = (
    "https://open.hkmapservice.gov.hk/OpenData/directDownload"
    "?productName=iGeoCom&sheetName=iGeoCom&productFormat=GEOJSON"
)
IGEOCOM_RAW_FILE = DATA_DIR / "iGeoCom_POI.geojson"