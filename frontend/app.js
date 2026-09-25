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
  const pointLayers = new Map();
  let clickMarker = null;
  let lastLat = null;
  let lastLng = null;

  const minutesLabel = document.getElementById("minutesLabel");
  const slider = document.getElementById("slider");
  const speedLabel = document.getElementById("speedLabel");
  const speedSlider = document.getElementById("speedSlider");
  const showPoints = document.getElementById("showPoints");
  const showNetwork = document.getElementById("showNetwork");
  const infoButton = document.getElementById("walkingTimeInfo");
  const infoPopover = document.getElementById("walkingTimePopover");
  const facilityList = document.getElementById("facilityList");
  const facilityListItems = document.getElementById("facilityListItems");

  function escapeHtml(value) {
    const entities = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
    return String(value).replace(/[&<>"']/g, (char) => entities[char]);
  }

  function bilingualName(name, nameZh) {
    return [...new Set([name, nameZh].filter(Boolean))]
      .map(escapeHtml)
      .join("<br/>");
  }

  function setInfoOpen(open) {
    infoPopover.hidden = !open;
    infoButton.setAttribute("aria-expanded", String(open));
  }

  infoButton.addEventListener("click", (event) => {
    event.stopPropagation();
    setInfoOpen(infoPopover.hidden);
  });
  infoPopover.addEventListener("click", (event) => event.stopPropagation());
  document.addEventListener("click", () => setInfoOpen(false));
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !infoPopover.hidden) {
      setInfoOpen(false);
      infoButton.focus();
    }
  });

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
          const primaryName = p.name_zh || p.name || "Unnamed";
          const secondaryName = p.name_zh && p.name && p.name !== p.name_zh
            ? `<div class="facility-name-en">${escapeHtml(p.name)}</div>`
            : "";
          const address = p.address_zh || p.address
            ? `<div class="facility-address">` +
              (p.address_zh
                ? `<div><span class="facility-address-label">地址:</span> ${escapeHtml(p.address_zh)}</div>`
                : "") +
              (p.address
                ? `<div class="facility-address-en"><span class="facility-address-label">Address:</span> ${escapeHtml(p.address)}</div>`
                : "") +
              `</div>`
            : "";
          layer.bindPopup(
            `<div class="facility-popup">` +
            `<div class="facility-name">${escapeHtml(primaryName)}</div>` +
            secondaryName +
            `<div class="facility-type">${type}</div>` +
            address +
            `</div>`,
            { autoPan: true, autoPanPadding: [80, 80] }
          );
          layer.on("click", () => showRoute(p.id, layer));
          pointLayers.set(p.id, layer);
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

  async function showRoute(pointId, targetLayer) {
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
        body: JSON.stringify({
          lat: lastLat,
          lng: lastLng,
          point_id: pointId,
          walk_speed_kmh: parseFloat(speedSlider.value),
        }),
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
        color: "#7c3aed", weight: 5, opacity: 0.9,
      }).addTo(focusRouteLayer);
      focusRouteLayer.addTo(map);
      const targetLatLng = targetLayer
        ? targetLayer.getLatLng()
        : latlngs[latlngs.length - 1];
      map.fitBounds(line.getBounds(), {
        padding: [90, 90],
        maxZoom: 18,
        animate: false,
      });
      map.panInside(targetLatLng, {
        padding: [160, 140],
        animate: false,
      });
      const name = bilingualName(data.name, data.name_zh) || "facility";
      routeInfo.innerHTML =
        `<b>Route to ${name}</b>` +
        ` &middot; ${data.time_min} min` +
        ` &middot; ${Math.round(data.length_m).toLocaleString()} m`;
      routeInfo.hidden = false;
    } catch (e) {
      err.textContent = "Routing failed.";
      err.hidden = false;
    }
  }

  function renderFacilityList(routes) {
    const sortedRoutes = [...routes].sort((a, b) => a.time_min - b.time_min);
    facilityListItems.replaceChildren();
    if (!sortedRoutes.length) {
      const empty = document.createElement("div");
      empty.className = "facility-list-empty";
      empty.textContent = "No facilities reachable within this walking time.";
      facilityListItems.appendChild(empty);
    } else {
      sortedRoutes.forEach((r) => {
        const row = document.createElement("button");
        const primaryName = r.name_zh || r.name || "Unnamed";
        const secondaryName = r.name_zh && r.name && r.name !== r.name_zh
          ? `<span class="facility-row-name-en">${escapeHtml(r.name)}</span>`
          : "";
        row.type = "button";
        row.className = "facility-row";
        row.innerHTML =
          `<span class="facility-row-names">` +
          `<span class="facility-row-name-zh">${escapeHtml(primaryName)}</span>` +
          secondaryName +
          `</span>` +
          `<span class="facility-row-meta">${r.time_min.toFixed(1)} min &middot; ${Math.round(r.length_m).toLocaleString()} m</span>`;
        row.addEventListener("click", () => showRoute(r.point_id, pointLayers.get(r.point_id)));
        facilityListItems.appendChild(row);
      });
    }
    facilityList.hidden = false;
  }

  // ---- service area query ---------------------------------------------

  async function compute(lat, lng) {
    const minutes = parseInt(slider.value, 10);
    const walkSpeedKmh = parseFloat(speedSlider.value);
    const err = document.getElementById("error");
    const res = document.getElementById("result");
    const routeInfo = document.getElementById("routeInfo");
    err.hidden = true;
    allRoutesLayer.clearLayers();
    focusRouteLayer.clearLayers();
    routeInfo.hidden = true;
    facilityList.hidden = true;
    facilityListItems.replaceChildren();
    try {
      const resp = await fetch("/api/service-area", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lat, lng, minutes, walk_speed_kmh: walkSpeedKmh }),
      });
      const data = await resp.json();
      if (!data.ok) {
        err.textContent = data.error || "Request failed.";
        err.hidden = false;
        res.hidden = true;
        return;
      }
      const areaBounds = L.latLngBounds([]);
      polygonLayer.clearLayers();
      if (data.polygon) {
        const areaLayer = L.geoJSON(data.polygon, {
          interactive: false,
          style: { color: "#16a34a", weight: 2, fillOpacity: 0.18 },
        }).addTo(polygonLayer);
        const polygonBounds = areaLayer.getBounds();
        if (polygonBounds.isValid()) areaBounds.extend(polygonBounds);
      }
      if (clickMarker) clickMarker.remove();
      const clickLatLng = [data.snapped.lat, data.snapped.lon];
      clickMarker = L.marker(clickLatLng).addTo(map);
      areaBounds.extend(clickLatLng);
      polygonLayer.addTo(map);

      allRoutesLayer.addTo(map);
      (data.routes || []).forEach((r) => {
        const route = L.polyline(r.path.coordinates.map(([lon, lat]) => [lat, lon]), {
          interactive: false,
          color: "#3b82f6", weight: 2, opacity: 0.6,
        }).addTo(allRoutesLayer);
        const routeBounds = route.getBounds();
        if (routeBounds.isValid()) areaBounds.extend(routeBounds);
      });
      if (areaBounds.isValid()) {
        map.fitBounds(areaBounds, { padding: [70, 70], maxZoom: 17 });
      }

      document.getElementById("count").textContent = data.count;
      document.getElementById("totalPoints").textContent = ` / ${data.total_points}`;
      renderFacilityList(data.routes || []);
      document.getElementById("detail").innerHTML =
        `${data.reachable_nodes.toLocaleString()} reachable network nodes` +
        ` &middot; ${data.walk_speed_kmh.toFixed(1)} km/h` +
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
  speedSlider.addEventListener("input", () => {
    speedLabel.textContent = Number(speedSlider.value).toFixed(1);
    if (lastLat !== null) compute(lastLat, lastLng);
  });
})();