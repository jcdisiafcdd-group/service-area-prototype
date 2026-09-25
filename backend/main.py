"""FastAPI app: serves the Leaflet frontend and the service-area API."""

from __future__ import annotations

import json
from contextlib import asynccontextmanager
from pathlib import Path

import geopandas as gpd
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import config, service_area


class ServiceAreaRequest(BaseModel):
    lat: float = Field(ge=-90, le=90)
    lng: float = Field(ge=-180, le=180)
    minutes: float = Field(ge=1, le=120, default=15)


class RouteRequest(BaseModel):
    lat: float = Field(ge=-90, le=90)
    lng: float = Field(ge=-180, le=180)
    point_id: int = Field(ge=1)


@asynccontextmanager
async def lifespan(app: FastAPI):
    service_area._load()
    yield


app = FastAPI(title="HK Walking Service Area", lifespan=lifespan)


@app.get("/api/health")
def health() -> dict:
    g, _ = service_area._load()
    return {
        "status": "ok",
        "district": config.DISTRICT,
        "nodes": g.number_of_nodes(),
        "edges": g.number_of_edges(),
    }


@app.get("/api/district")
def district() -> JSONResponse:
    gdf = gpd.read_file(config.DISTRICT_FILE)
    gdf = gdf[gdf["District"] == config.DISTRICT]
    return JSONResponse(json.loads(gdf.to_json()))


@app.get("/api/points")
def points() -> JSONResponse:
    with open(config.POINTS_FILE, encoding="utf-8") as fh:
        fc = json.load(fh)
    return JSONResponse(fc)


@app.post("/api/service-area")
def compute_service_area(req: ServiceAreaRequest) -> dict:
    result = service_area.service_area(req.lng, req.lat, req.minutes)
    status = 200 if result["ok"] else 422
    return JSONResponse(result, status_code=status)


@app.post("/api/route")
def get_route(req: RouteRequest) -> dict:
    result = service_area.route(req.lng, req.lat, req.point_id)
    status = 200 if result["ok"] else 422
    return JSONResponse(result, status_code=status)


app.mount("/", StaticFiles(directory=config.FRONTEND_DIR, html=True), name="frontend")


def main() -> None:
    import uvicorn

    uvicorn.run("backend.main:app", host="127.0.0.1", port=8000, reload=True)


if __name__ == "__main__":
    main()