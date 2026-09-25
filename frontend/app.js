(() => {
  const map = L.map("map").setView([22.3308, 114.1621], 15);
  L.tileLayer(
    "https://mapapi.geodata.gov.hk/gs/api/v1.0.0/xyz/basemap/WGS84/{z}/{x}/{y}.png",
    {
      attribution:
        "Map from Lands Department. Basemap &copy; Lands Department, Government of the Hong Kong SAR.",
      maxZoom: 20,
      minZoom: 10,
    }
  ).addTo(map);

  const districtLayer = L.layerGroup().addTo(map);
  const pointsLayer = L.layerGroup();
  let polygonLayer = L.layerGroup().addTo(map);
  const allRoutesLayer = L.layerGroup();
  const focusRouteLayer = L.layerGroup();
  let clickMarker = null;
  let lastLat = null;
  let lastLng = null;

  const minutesLabel = document.getElementById("minutesLabel");
  const slider = document.getElementById("slider");
  const showPoints = document.getElementById("showPoints");
  const showNetwork = document.getElementById("showNetwork");

  // ---- data layers -----------------------------------------------------

  fetch("/api/district")
    .then((r) => r.json())
    .then((fc) => {
      L.geoJSON(fc, { interactive: false, style: { color: "#0b6bcb", weight: 2, fill: false } })
        .addTo(districtLayer);
      districtLayer.addTo(map);
    });

  fetch("/api/points")
    .then((r) => r.json())
    .then((fc) => {
      L.geoJSON(fc, {
        pointToLayer: (f, latlng) =>
          L.circleMarker(latlng, { radius: 4, color: "#d97706", fillOpacity: 0.9, weight: 1 }),
        onEachFeature: (f, layer) => {
          const p = f.properties;
          const type = p.type === "CMC" ? "Community centre / hall" : "Family service centre";
          layer.bindPopup(
            `<b>${p.name || "Unnamed"}</b><br/>${type}<br/>${p.address || ""}`
          );
          layer.on("click", () => showRoute(p.id, p.name));
        },
      }).addTo(pointsLayer);
      updateLayers();
    });

  function updateLayers() {
    if (showNetwork.checked && !map.hasLayer(districtLayer)) districtLayer.addTo(map);
    if (!showNetwork.checked && map.hasLayer(districtLayer)) districtLayer.remove();
    if (showPoints.checked && !map.hasLayer(pointsLayer)) pointsLayer.addTo(map);
    if (!showPoints.checked && map.hasLayer(pointsLayer)) pointsLayer.remove();
  }
  showNetwork.addEventListener("change", updateLayers);
  showPoints.addEventListener("change", updateLayers);

  // ---- walking route --------------------------------------------

  async function showRoute(pointId, name) {
    const err = document.getElementById("error");
    const routeInfo = document.getElementById("routeInfo");
    err.hidden = true;
    routeInfo.hidden = true;
    focusRouteLayer.clearLayers();
    if (lastLat === null) {
      err.textContent = "Click the map to set a start point first.";
      err.hidden = false;
      return;
    }
    try {
      const resp = await fetch("/api/route", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lat: lastLat, lng: lastLng, point_id: pointId }),
      });
      const data = await resp.json();
      if (!data.ok) {
        err.textContent = data.error || "Routing failed.";
        err.hidden = false;
        return;
      }
      const latlngs = data.path.coordinates.map(([lon, lat]) => [lat, lon]);
      const line = L.polyline(latlngs, {
        interactive: false,
        color: "#2563eb", weight: 5, opacity: 0.85,
      }).addTo(focusRouteLayer);
      focusRouteLayer.addTo(map);
      map.fitBounds(line.getBounds(), { padding: [40, 40] });
      routeInfo.innerHTML =
        `<b>Route to ${data.name || "facility"}</b>` +
        ` &middot; ${data.time_min} min` +
        ` &middot; ${Math.round(data.length_m).toLocaleString()} m`;
      routeInfo.hidden = false;
    } catch (e) {
      err.textContent = "Routing failed.";
      err.hidden = false;
    }
  }

  // ---- service area query ---------------------------------------------

  async function compute(lat, lng) {
    const minutes = parseInt(slider.value, 10);
    const err = document.getElementById("error");
    const res = document.getElementById("result");
    const routeInfo = document.getElementById("routeInfo");
    err.hidden = true;
    allRoutesLayer.clearLayers();
    focusRouteLayer.clearLayers();
    routeInfo.hidden = true;
    try {
      const resp = await fetch("/api/service-area", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lat, lng, minutes }),
      });
      const data = await resp.json();
      if (!data.ok) {
        err.textContent = data.error || "Request failed.";
        err.hidden = false;
        res.hidden = true;
        return;
      }
      polygonLayer.clearLayers();
      if (data.polygon) {
        L.geoJSON(data.polygon, {
          interactive: false,
          style: { color: "#16a34a", weight: 2, fillOpacity: 0.18 },
        }).addTo(polygonLayer);
      }
      if (clickMarker) clickMarker.remove();
      clickMarker = L.marker([data.snapped.lat, data.snapped.lon]).addTo(map);
      polygonLayer.addTo(map);

      allRoutesLayer.addTo(map);
      (data.routes || []).forEach((r) => {
        L.polyline(r.path.coordinates.map(([lon, lat]) => [lat, lon]), {
          interactive: false,
          color: "#3b82f6", weight: 2, opacity: 0.6,
        }).addTo(allRoutesLayer);
      });

      document.getElementById("count").textContent = `${data.count} / ${data.total_points}`;
      document.getElementById("detail").innerHTML =
        `${data.reachable_nodes.toLocaleString()} reachable network nodes` +
        ` &middot; snapped ${data.snapped.lat.toFixed(5)}, ${data.snapped.lon.toFixed(5)}` +
        ` &middot; ${data.ms.toFixed(0)} ms`;
      res.hidden = false;
    } catch (e) {
      err.textContent = "Request failed.";
      err.hidden = false;
    }
  }

  map.on("click", (e) => {
    lastLat = e.latlng.lat;
    lastLng = e.latlng.lng;
    compute(lastLat, lastLng);
  });

  slider.addEventListener("input", () => {
    minutesLabel.textContent = slider.value;
    if (lastLat !== null) compute(lastLat, lastLng);
  });
})();