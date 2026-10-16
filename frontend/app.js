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
      (function addLegend() {
        const Legend = L.Control.extend({
          options: { position: "bottomright" },
          onAdd: function () {
            const container = L.DomUtil.create("div", "legend");
            container.innerHTML = `
              <h4>Legend</h4>
              <div class="legend-row">
                <span class="legend-swatch legend-poly"></span>
                <span>Service area (reachable envelope)</span>
              </div>
              <div class="legend-row">
                <span class="legend-swatch legend-line-blue"></span>
                <span>Routes (all reachable)</span>
              </div>
              <div class="legend-row">
                <span class="legend-swatch legend-line-purple"></span>
                <span>Selected route</span>
              </div>
              <div class="legend-row">
                <span class="legend-swatch legend-dot-facility"></span>
                <span>Community facility</span>
              </div>
              <div class="legend-row">
                <span class="legend-swatch legend-start"></span>
                <span>Start (snapped)</span>
              </div>
              <div class="legend-row">
                <span class="legend-swatch legend-outline"></span>
                <span>District Boundary</span>
              </div>
            `;
            // Use the real Leaflet default marker icon (same image as the map
            // start pin) instead of an approximated CSS circle. createIcon()
            // injects inline styles that override CSS: native 25x41 size plus
            // negative anchor margins (-12px/-41px, which pin the marker tip
            // to its lat/lng on the map). Reset all of them so the icon just
            // sits centred in its 18px legend slot.
            const startSlot = container.querySelector(".legend-start");
            if (startSlot) {
              const startImg = new L.Icon.Default().createIcon();
              startImg.className = "legend-start-img";
              startImg.alt = "";
              startImg.style.width = "auto";
              startImg.style.height = "14px"; // ~8.5px wide, comparable to the 12px facility dot
              startImg.style.margin = "0";
              startSlot.appendChild(startImg);
            }
            L.DomEvent.disableClickPropagation(container);
            L.DomEvent.disableScrollPropagation(container);
            return container;
          },
        });
        map.addControl(new Legend());
      })();
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
          style: { color: "#16a34a", weight: 2, fillOpacity: 0.18, fillColor: "#16a34a" },
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

  // ---- place search (ALS) ----------------------------------------------

  const placeSearch = document.getElementById("placeSearch");
  const searchResults = document.getElementById("searchResults");
  const SEARCH_MIN_CHARS = 2;
  const SEARCH_DEBOUNCE_MS = 300;
  const SEARCH_LIMIT = 8;
  let searchTimer = null;
  let searchController = null;
  let searchItems = [];

  function closeSearch() {
    searchResults.replaceChildren();
    searchResults.hidden = true;
    searchItems = [];
    placeSearch.setAttribute("aria-expanded", "false");
  }

  function setActiveSearchItem(index) {
    if (!searchItems.length) return;
    const size = searchItems.length;
    const next = ((index % size) + size) % size;
    searchItems.forEach((el, i) => {
      el.classList.toggle("is-active", i === next);
      el.setAttribute("aria-selected", String(i === next));
    });
    searchItems[next].scrollIntoView({ block: "nearest" });
  }

  function highlightText(text, query) {
    const raw = String(text ?? "");
    const q = String(query ?? "").trim();
    if (!q) return escapeHtml(raw);
    const idx = raw.toLowerCase().indexOf(q.toLowerCase());
    if (idx < 0) return escapeHtml(raw);
    // Escape each slice separately so injected markup can never be revived.
    return (
      escapeHtml(raw.slice(0, idx)) +
      "<mark class=\"search-mark\">" +
      escapeHtml(raw.slice(idx, idx + q.length)) +
      "</mark>" +
      escapeHtml(raw.slice(idx + q.length))
    );
  }

  function searchRowHtml(r, query) {
    const primary = r.name_zh || r.name || r.address_zh || r.address || "Unnamed";
    const lines = [`<span class="search-row-name-zh">${highlightText(primary, query)}</span>`];
    if (r.name && r.name !== primary) {
      lines.push(`<span class="search-row-name-en">${highlightText(r.name, query)}</span>`);
    }
    if (r.address_zh && r.address_zh !== primary) {
      lines.push(`<span class="search-row-address-zh">${highlightText(r.address_zh, query)}</span>`);
    }
    if (r.address && r.address !== primary && r.address !== r.address_zh) {
      lines.push(`<span class="search-row-address-en">${highlightText(r.address, query)}</span>`);
    }
    return lines.join("");
  }

  function renderSearchResults(data, query) {
    searchResults.replaceChildren();
    searchItems = [];
    const empty = document.createElement("div");
    empty.className = "search-empty";

    if (!data.ok) {
      empty.textContent = data.error || "Search failed.";
      searchResults.appendChild(empty);
      searchResults.hidden = false;
      return;
    }
    const results = data.results || [];
    if (!results.length) {
      empty.textContent = `No results in Sham Shui Po for “${query}”.`;
      searchResults.appendChild(empty);
      searchResults.hidden = false;
      return;
    }
    results.forEach((r, i) => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "search-row";
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", "false");
      row.dataset.index = String(i);
      row.innerHTML = searchRowHtml(r, query);
      row.addEventListener("click", () => pickSearchResult(r));
      searchResults.appendChild(row);
      searchItems.push(row);
    });
    searchResults.hidden = false;
    placeSearch.setAttribute("aria-expanded", "true");
  }

  async function runSearch(query) {
    if (searchController) searchController.abort();
    searchController = new AbortController();
    try {
      const resp = await fetch(
        `/api/search?q=${encodeURIComponent(query)}&limit=${SEARCH_LIMIT}`,
        { signal: searchController.signal }
      );
      const data = await resp.json();
      if (placeSearch.value.trim() !== query) return; // stale response
      renderSearchResults(data, query);
    } catch (e) {
      if (e.name !== "AbortError") closeSearch();
    }
  }

  function pickSearchResult(result) {
    if (searchController) searchController.abort();
    placeSearch.value = result.name_zh || result.name || placeSearch.value;
    closeSearch();
    lastLat = result.lat;
    lastLng = result.lng;
    compute(lastLat, lastLng);
  }

  placeSearch.addEventListener("input", () => {
    clearTimeout(searchTimer);
    const query = placeSearch.value.trim();
    if (query.length < SEARCH_MIN_CHARS) {
      closeSearch();
      return;
    }
    searchTimer = setTimeout(() => runSearch(query), SEARCH_DEBOUNCE_MS);
  });

  placeSearch.addEventListener("keydown", (event) => {
    const open = !searchResults.hidden;
    const activeIndex = searchItems.findIndex((el) =>
      el.classList.contains("is-active")
    );
    if (event.key === "ArrowDown" && open && searchItems.length) {
      event.preventDefault();
      setActiveSearchItem(activeIndex < 0 ? 0 : activeIndex + 1);
    } else if (event.key === "ArrowUp" && open && searchItems.length) {
      event.preventDefault();
      setActiveSearchItem(activeIndex < 0 ? searchItems.length - 1 : activeIndex - 1);
    } else if (event.key === "Enter" && open && activeIndex >= 0) {
      event.preventDefault();
      searchItems[activeIndex].click();
    } else if (event.key === "Escape") {
      closeSearch();
    }
  });

  document.addEventListener("click", (event) => {
    if (event.target.closest && event.target.closest(".search")) return;
    closeSearch();
  });
})();