"""FastAPI app: serves the Leaflet frontend and the service-area API."""

from __future__ import annotations

import json
from contextlib import asynccontextmanager
from pathlib import Path

import geopandas as gpd
from fastapi import FastAPI, Query
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import config, search, service_area


class ServiceAreaRequest(BaseModel):
    lat: float = Field(ge=-90, le=90)
    lng: float = Field(ge=-180, le=180)
    minutes: float = Field(ge=1, le=120, default=15)
    walk_speed_kmh: float = Field(ge=2.0, le=6.0, default=config.WALK_SPEED_KMH)


class RouteRequest(BaseModel):
    lat: float = Field(ge=-90, le=90)
    lng: float = Field(ge=-180, le=180)
    point_id: int = Field(ge=1)
    walk_speed_kmh: float = Field(ge=2.0, le=6.0, default=config.WALK_SPEED_KMH)


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


@app.get("/health")
def health_alias() -> dict:
    """Alias for `/api/health`.

    Dev tools and agents that probe a project server conventionally ask for
    `/health`; without this alias they poll a path that does not exist and
    fill the access log with 404s.
    """
    return health()


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


@app.get("/api/search")
def search_places(
    q: str = Query("", max_length=200),
    limit: int = Query(search.DEFAULT_LIMIT, ge=1, le=search.MAX_LIMIT),
) -> JSONResponse:
    """Free-text place search via the ALS, restricted to this district."""
    result = search.search(q, limit)
    status = 200 if result["ok"] else 502
    return JSONResponse(result, status_code=status)


@app.post("/api/service-area")
def compute_service_area(req: ServiceAreaRequest) -> dict:
    result = service_area.service_area(
        req.lng, req.lat, req.minutes, req.walk_speed_kmh
    )
    status = 200 if result["ok"] else 422
    return JSONResponse(result, status_code=status)


@app.post("/api/route")
def get_route(req: RouteRequest) -> dict:
    result = service_area.route(
        req.lng, req.lat, req.point_id, req.walk_speed_kmh
    )
    status = 200 if result["ok"] else 422
    return JSONResponse(result, status_code=status)


app.mount("/", StaticFiles(directory=config.FRONTEND_DIR, html=True), name="frontend")


HOST = "127.0.0.1"
PORT = 8000


def _dual_stack_socket(host: str, port: int):
    """Bind one socket that answers IPv4 (127.0.0.1) and IPv6 (localhost / ::1).

    On Windows `localhost` resolves to `::1` first, so an IPv4-only listener
    would leave `http://localhost:8000` unanswered (or answered by whatever
    else happens to own `::1`). A single dual-stack `::` socket avoids that.
    """
    import socket

    sock = socket.socket(socket.AF_INET6, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        sock.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
    except OSError:  # pragma: no cover - platform dependent
        pass
    sock.bind((host, port))
    sock.listen(2048)
    return sock


def _report_bind_failure(exc: OSError) -> None:
    print(
        f"\n[run] Could not bind http://{HOST}:{PORT} ({exc}).\n"
        f"[run] Another program is probably already using port {PORT}.\n"
        f"[run] Find it with: Get-NetTCPConnection -LocalPort {PORT} -State Listen\n"
        f"[run] Stop that process and re-run. A stray `python -m http.server`\n"
        f"[run] (serving frontend/) is a common cause.\n"
        f"[run] Meanwhile the running app may be reachable at http://{HOST}:{PORT}.",
        flush=True,
    )


def main() -> None:
    import uvicorn
    from uvicorn import Config, Server

    config = Config("backend.main:app", host=HOST, port=PORT, reload=True)
    server = Server(config)

    # Bind one dual-stack socket so http://127.0.0.1, http://localhost and
    # http://[::1] all reach the app.
    try:
        sock = _dual_stack_socket("::", PORT)
    except OSError as exc:
        print(f"[run] Dual-stack bind on port {PORT} failed: {exc}", flush=True)
        print(f"[run] Falling back to IPv4 only (http://{HOST}:{PORT}).", flush=True)
        try:
            uvicorn.run("backend.main:app", host=HOST, port=PORT, reload=True)
        except OSError as fallback_exc:
            _report_bind_failure(fallback_exc)
        return

    print(
        f"[run] Serving on http://{HOST}:{PORT} and http://localhost:{PORT} "
        f"(Press CTRL+C to quit)",
        flush=True,
    )
    try:
        if config.should_reload:
            from uvicorn.supervisors import ChangeReload

            ChangeReload(config, target=server.run, sockets=[sock]).run()
        else:
            server.run(sockets=[sock])
    finally:
        sock.close()


if __name__ == "__main__":
    main()