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

  // Own pane below the overlay pane (routes, dots), so the service area never covers them.
  map.createPane("serviceAreaPane");
  map.getPane("serviceAreaPane").style.zIndex = 350;
  const districtLayer = L.layerGroup().addTo(map);
  const pointsLayer = L.layerGroup();
  let polygonLayer = L.layerGroup().addTo(map);
  const allRoutesLayer = L.layerGroup();
  const focusRouteLayer = L.layerGroup();
  const pointLayers = new Map();
  // Facility properties (name, name_zh, type, address, address_zh) by id,
  // taken from the /api/points GeoJSON that is loaded anyway.
  const pointProps = new Map();
  let clickMarker = null;
  let lastLat = null;
  let lastLng = null;

  // Labels for the reachable facilities live in their own overlay above the
  // map panes (below the pop-up pane) so they can be positioned freely.
  const reachLabels = document.createElement("div");
  reachLabels.className = "reach-labels";
  map.getContainer().appendChild(reachLabels);
  // Leader lines ("tails") from each facility dot to its label, drawn under the labels.
  const reachTails = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  reachTails.setAttribute("class", "reach-tails");
  const reachLabelTip = document.createElement("div");
  reachLabelTip.className = "reach-label-tip";
  reachLabelTip.hidden = true;
  reachLabels.appendChild(reachTails);
  reachLabels.appendChild(reachLabelTip);
  let reachLabelItems = [];
  let labelLayoutQueued = false;

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

  function facilityTypeLabel(type) {
    if (type === "CMC") return "Community centre / hall";
    if (type === "FSC") return "Family service centre";
    return "";
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
      return;
    }
    if (event.key === "Escape" && !facilityCard.hidden) {
      clearFacilityCard(); // dismiss the details, keep the selection
    }
  });

  // ---- data layers -----------------------------------------------------

  fetch("/api/district")
    .then((r) => r.json())
    .then((fc) => {
      L.geoJSON(fc, { interactive: false, style: { color: "#9ca3af", weight: 2, fill: false } })
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
          L.circleMarker(latlng, {
            radius: 4,
            color: "#d97706",
            fillOpacity: 0.9,
            weight: 1,
            // Selecting a facility must not start a new service-area
            // computation (that is what a click on the map background does).
            bubblingMouseEvents: false,
          }),
        onEachFeature: (f, layer) => {
          const p = f.properties;
          pointProps.set(p.id, p);
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
    err.hidden = true;
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
        color: "#7c3aed", weight: 5, opacity: 0.95,
      }).addTo(focusRouteLayer);
      // A thin moving light along the route gives the impression that it is
      // flowing from start to end.
      const flow = L.polyline(latlngs, {
        interactive: false,
        color: "#ffd93b", weight: 2, opacity: 1,
      }).addTo(focusRouteLayer);
      focusRouteLayer.addTo(map);
      const flowEl = flow.getElement ? flow.getElement() : null;
      if (flowEl) {
        flowEl.setAttribute("stroke-linecap", "round");
        flowEl.style.strokeDasharray = "10 18";
        flowEl.style.animation = "route-flow-light 0.5s linear infinite";
        flowEl.style.pointerEvents = "none";
      }
      const targetLatLng = targetLayer
        ? targetLayer.getLatLng()
        : latlngs[latlngs.length - 1];
      // Show the card first: the framed view has to take its footprint into
      // account, because the card floats over the map's top-right corner.
      renderFacilityCard(pointId, data);
      const bounds = line.getBounds();
      bounds.extend(targetLatLng);
      if (clickMarker) bounds.extend(clickMarker.getLatLng());
      map.fitBounds(bounds, {
        padding: [70, 70],
        maxZoom: 18,
        animate: false,
      });
      // A tight fit hides where the route sits in the district, so a selected
      // route is framed one zoom level further out.
      if (map.getZoom() > map.getMinZoom()) map.zoomOut(1, { animate: false });
      panClearOfCard(targetLatLng);
      markSelectedFacility(pointId);
    } catch (e) {
      err.textContent = "Routing failed.";
      err.hidden = false;
    }
  }

  // ---- selected-facility details (top-right map card) -------------------
  // The details float over the map's top-right corner, so no marker pop-up
  // ever covers the map points.

  const facilityCard = document.getElementById("facilityCard");
  const facilityCardBody = document.getElementById("facilityCardBody");
  const facilityCardClose = document.getElementById("facilityCardClose");

  // The card floats over the top-right corner of the map as a plain Leaflet
  // control, so clicks inside it never reach the map (no accidental
  // recompute) and it stacks with the other map overlays.
  const FacilityCardControl = L.Control.extend({
    options: { position: "topright" },
    onAdd: function () {
      L.DomEvent.disableClickPropagation(facilityCard);
      L.DomEvent.disableScrollPropagation(facilityCard);
      return facilityCard;
    },
  });
  map.addControl(new FacilityCardControl());

  function renderFacilityCard(pointId, data) {
    const p = pointProps.get(pointId) || {};
    const primaryName = p.name_zh || p.name || "Unnamed";
    const secondaryName = p.name_zh && p.name && p.name !== p.name_zh
      ? `<div class="facility-name-en">${escapeHtml(p.name)}</div>`
      : "";
    const type = facilityTypeLabel(p.type);
    const typeHtml = type ? `<div class="facility-type">${escapeHtml(type)}</div>` : "";
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
    facilityCardBody.innerHTML =
      `<div class="facility-name">${escapeHtml(primaryName)}</div>` +
      secondaryName +
      typeHtml +
      address +
      `<div class="facility-card-meta">` +
      `<strong>${data.time_min.toFixed(1)} min</strong>` +
      ` &middot; ${Math.round(data.length_m).toLocaleString()} m on foot` +
      `</div>`;
    facilityCard.hidden = false;
  }

  function clearFacilityCard() {
    facilityCard.hidden = true;
    facilityCardBody.replaceChildren();
  }

  // The card is pinned to the map's top-right corner. If the framed view put
  // the selected facility behind it, nudge the map so the dot stays visible.
  function panClearOfCard(latlng) {
    if (facilityCard.hidden || !map.panBy) return;
    const card = facilityCard.getBoundingClientRect();
    const box = map.getContainer().getBoundingClientRect();
    if (!card.width || !card.height || !box.width || !box.height) return;
    const p = map.latLngToContainerPoint(latlng);
    const left = card.left - box.left;
    const top = card.top - box.top;
    const right = left + card.width;
    const bottom = top + card.height;
    const gap = 20;
    if (p.x < left - gap || p.x > right + gap || p.y < top - gap || p.y > bottom + gap) return;
    // Push the facility below the card or left of it, whichever is closer.
    const below = bottom + gap - p.y;
    const toLeft = p.x - (left - gap);
    if (below <= toLeft) map.panBy([0, below], { animate: false });
    else map.panBy([-toLeft, 0], { animate: false });
  }

  let selectedPointId = null;

  function clearSelection() {
    // Resets the highlights only; the details card is cleared separately
    // (the x button keeps the selection, a new computation drops both).
    if (selectedPointId !== null) {
      const row = facilityListItems.querySelector(
        `.facility-row[data-point-id="${selectedPointId}"]`
      );
      if (row) row.classList.remove("is-selected");
      const label = reachLabelItems.find((i) => i.pointId === selectedPointId);
      if (label) label.el.classList.remove("is-active");
      const layer = pointLayers.get(selectedPointId);
      if (layer) {
        layer.setStyle({ color: "#d97706", weight: 1, fillOpacity: 0.9 });
        layer.setRadius(4);
      }
    }
    selectedPointId = null;
  }

  function markSelectedFacility(pointId) {
    clearSelection();
    selectedPointId = pointId;
    const row = facilityListItems.querySelector(
      `.facility-row[data-point-id="${pointId}"]`
    );
    if (row) {
      row.classList.add("is-selected");
      row.scrollIntoView({ block: "nearest" });
    }
    const label = reachLabelItems.find((i) => i.pointId === pointId);
    if (label) label.el.classList.add("is-active");
    const layer = pointLayers.get(pointId);
    if (layer) {
      layer.setStyle({ color: "#7c3aed", weight: 2, fillOpacity: 0.9 });
      layer.setRadius(5);
    }
  }

  facilityCardClose.addEventListener("click", () => {
    // Dismiss the details only: the facility stays selected, so the purple
    // route and the highlighted label/dot remain.
    clearFacilityCard();
  });

  function renderFacilityList(sortedRoutes) {
    // `sortedRoutes` arrives already sorted by walking time.
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
        row.dataset.pointId = String(r.point_id);
        row.innerHTML =
          `<span class="facility-row-names">` +
          `<span class="facility-row-name-zh">${escapeHtml(primaryName)}</span>` +
          secondaryName +
          `</span>` +
          `<span class="facility-row-meta">${r.time_min.toFixed(1)} min &middot; ${Math.round(r.length_m).toLocaleString()} m</span>`;
        row.addEventListener("click", () => {
          const layer = pointLayers.get(r.point_id);
          showRoute(r.point_id, layer);
        });
        facilityListItems.appendChild(row);
      });
    }
    facilityList.hidden = false;
  }

  // ---- reachable-facility labels ----------------------------------------
  // A name on every reachable facility covers the map, so the labels are
  // placed by a small greedy layout: each facility takes the first free slot
  // around its dot, closest facilities first, and a label that does not fit
  // is hidden rather than overlapping another one.

  const LABEL_GAP = 2;         // minimum space between two labels (px)
  const LABEL_RINGS = [10, 16, 22, 30, 40, 52, 66]; // distances tried from the dot (px)
  const LABEL_DOT_R = 6;       // clearance kept around every facility dot (px)
  const LABEL_ROUTE_CLEAR = 3; // clearance kept around every route line (px)
  // Candidate directions, most preferred first: right, above, left, below, diagonals.
  const LABEL_DIRS = [0, -90, 180, 90, -45, -135, 135, 45, -22.5, -67.5, -112.5, -157.5, 157.5, 112.5, 67.5, 22.5]
    .map((deg) => ({ x: Math.cos((deg * Math.PI) / 180), y: Math.sin((deg * Math.PI) / 180) }));

  function labelsOverlap(a, b) {
    return !(
      a.x + a.w + LABEL_GAP <= b.x ||
      b.x + b.w + LABEL_GAP <= a.x ||
      a.y + a.h + LABEL_GAP <= b.y ||
      b.y + b.h + LABEL_GAP <= a.y
    );
  }

  // Box = { x0, y0, x1, y1 } in container pixels.
  function boxOf(x, y, w, h, pad = 0) {
    return { x0: x - pad, y0: y - pad, x1: x + w + pad, y1: y + h + pad };
  }

  // Liang-Barsky: does the segment touch the box?
  function segmentHitsBox(s, box) {
    let t0 = 0;
    let t1 = 1;
    const dx = s.bx - s.ax;
    const dy = s.by - s.ay;
    const p = [-dx, dx, -dy, dy];
    const q = [s.ax - box.x0, box.x1 - s.ax, s.ay - box.y0, box.y1 - s.ay];
    for (let i = 0; i < 4; i++) {
      if (p[i] === 0) {
        if (q[i] < 0) return false;
        continue;
      }
      const t = q[i] / p[i];
      if (p[i] < 0) {
        if (t > t1) return false;
        if (t > t0) t0 = t;
      } else {
        if (t < t0) return false;
        if (t < t1) t1 = t;
      }
    }
    return true;
  }

  function countRouteHits(box, segs) {
    let n = 0;
    for (const s of segs) if (segmentHitsBox(s, box)) n++;
    return n;
  }

  function countDotHits(box, dots, radius) {
    let n = 0;
    for (const d of dots) {
      const cx = Math.max(box.x0, Math.min(d.x, box.x1));
      const cy = Math.max(box.y0, Math.min(d.y, box.y1));
      if ((d.x - cx) ** 2 + (d.y - cy) ** 2 < radius * radius) n++;
    }
    return n;
  }

  function collectRouteSegments() {
    const segs = [];
    getRouteScreenPolylines().forEach((pts) => {
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i];
        const b = pts[i + 1];
        segs.push({
          ax: a.x, ay: a.y, bx: b.x, by: b.y,
          minX: Math.min(a.x, b.x), minY: Math.min(a.y, b.y),
          maxX: Math.max(a.x, b.x), maxY: Math.max(a.y, b.y),
        });
      }
    });
    return segs;
  }

  function getRouteScreenPolylines() {
    const lines = [];
    const collect = (layer) => {
      if (!layer) return;
      layer.eachLayer((l) => {
        if (!l.getLatLngs) return;
        const latlngs = l.getLatLngs();
        const flatten = (arr) => {
          if (!Array.isArray(arr)) return;
          if (arr.length && arr[0] && typeof arr[0].lat === "number") {
            const pts = arr.map((ll) => map.latLngToContainerPoint(ll));
            if (pts.length > 1) lines.push(pts);
            return;
          }
          arr.forEach(flatten);
        };
        flatten(latlngs);
      });
    };
    collect(allRoutesLayer);
    collect(focusRouteLayer);
    return lines;
  }

  // Each label tries the closest clean spot around its dot: no overlap with
  // another label, no route line through it, no facility dot under it. If no
  // clean spot exists within the rings, the least-conflicting one is used so
  // the label is still shown.
  function layoutReachLabels() {
    const size = map.getSize();
    const placed = [];
    const segs = collectRouteSegments();
    const dots = [...pointLayers.values()].map((l) => map.latLngToContainerPoint(l.getLatLng()));
    reachLabelTip.hidden = true;
    reachTails.replaceChildren();
    reachLabelItems.forEach((item) => {
      const anchor = map.latLngToContainerPoint(item.latlng);
      if (anchor.x < -40 || anchor.y < -40 || anchor.x > size.x + 40 || anchor.y > size.y + 40) {
        item.el.style.visibility = "hidden"; // off-screen
        return;
      }
      if (!item.w) {
        item.w = item.el.offsetWidth;
        item.h = item.el.offsetHeight;
      }
      const w = item.w;
      const h = item.h;
      const reach = LABEL_RINGS[LABEL_RINGS.length - 1] + Math.max(w, h);
      const nearSegs = segs.filter((s) =>
        s.maxX > anchor.x - reach && s.minX < anchor.x + reach &&
        s.maxY > anchor.y - reach && s.minY < anchor.y + reach
      );
      let best = null;
      for (const dist of LABEL_RINGS) {
        LABEL_DIRS.forEach((u, order) => {
          const px = anchor.x + u.x * dist;
          const py = anchor.y + u.y * dist;
          const x = px + (u.x > 0.3 ? 0 : u.x < -0.3 ? -w : -w / 2);
          const y = py + (u.y > 0.3 ? 0 : u.y < -0.3 ? -h : -h / 2);
          const box = boxOf(x, y, w, h);
          const inside = x >= 2 && y >= 2 && x + w <= size.x - 2 && y + h <= size.y - 2;
          const overlaps = placed.filter((p) => labelsOverlap(p, { x, y, w, h })).length;
          const routeHits = countRouteHits(boxOf(x, y, w, h, LABEL_ROUTE_CLEAR), nearSegs);
          const dotHits = countDotHits(box, dots, LABEL_DOT_R);
          const cost = (inside ? 0 : 1000) + overlaps * 100 + dotHits * 30 + routeHits * 10;
          const score = cost * 1000 + dist + order * 0.1;
          if (!best || score < best.score) best = { score, rect: { x, y, w, h } };
        });
      }
      const rect = best.rect;
      item.el.style.visibility = "visible";
      item.el.style.transform = `translate3d(${Math.round(rect.x)}px, ${Math.round(rect.y)}px, 0)`;
      item.rect = rect;
      placed.push(rect);
      item.tail = null;
      // Tail: from the dot's centre to the nearest point of the label box.
      const nx = Math.max(rect.x, Math.min(anchor.x, rect.x + w));
      const ny = Math.max(rect.y, Math.min(anchor.y, rect.y + h));
      const len = Math.hypot(nx - anchor.x, ny - anchor.y);
      if (len > 0) {
        const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
        line.setAttribute("x1", anchor.x.toFixed(1));
        line.setAttribute("y1", anchor.y.toFixed(1));
        line.setAttribute("x2", nx.toFixed(1));
        line.setAttribute("y2", ny.toFixed(1));
        if (item.el.matches(":hover")) line.classList.add("is-hover");
        item.tail = line;
        reachTails.appendChild(line);
      }
    });
  }


  function scheduleLabelLayout() {
    if (labelLayoutQueued) return;
    labelLayoutQueued = true;
    const run = () => {
      labelLayoutQueued = false;
      layoutReachLabels();
    };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
    else setTimeout(run, 16);
  }

  function showLabelTip(item) {
    if (!item.rect) return;
    const size = map.getSize();
    reachLabelTip.textContent =
      `${item.name} · ${item.time.toFixed(1)} min · ${item.dist.toLocaleString()} m`;
    reachLabelTip.hidden = false;
    const w = reachLabelTip.offsetWidth;
    const h = reachLabelTip.offsetHeight;
    const segs = collectRouteSegments();
    const anchor = { x: item.rect.x + item.rect.w / 2, y: item.rect.y + item.rect.h / 2 };
    const candidates = [
      { x: anchor.x - w / 2, y: item.rect.y - h - 6 },
      { x: anchor.x - w / 2, y: item.rect.y + item.rect.h + 6 },
      { x: item.rect.x + item.rect.w + 6, y: anchor.y - h / 2 },
      { x: item.rect.x - w - 6, y: anchor.y - h / 2 },
      { x: item.rect.x + item.rect.w + 8, y: item.rect.y - h - 4 },
      { x: item.rect.x - w - 8, y: item.rect.y - h - 4 },
    ];
    let best = null;
    let bestScore = -Infinity;
    for (const c of candidates) {
      let cx = Math.max(2, Math.min(size.x - w - 2, c.x));
      let cy = Math.max(2, Math.min(size.y - h - 2, c.y));
      const rect = { x: cx, y: cy, w, h };
      let score = 0;
      if (c.y < item.rect.y) score += 2; // prefer above
      if (countRouteHits(boxOf(cx, cy, w, h, 4), segs) > 0) score -= 3;
      if (score > bestScore) { bestScore = score; best = { x: cx, y: cy }; }
    }
    const pos = best || { x: Math.max(2, Math.min(size.x - w - 2, item.rect.x + item.rect.w / 2 - w / 2)), y: item.rect.y - h - 6 < 2 ? item.rect.y + item.rect.h + 6 : item.rect.y - h - 6 };
    reachLabelTip.style.transform = `translate3d(${Math.round(pos.x)}px, ${Math.round(pos.y)}px, 0)`;
  }

  function selectFacility(pointId, facility) {
    // showRoute() draws the route, frames it and shows the details card.
    showRoute(pointId, facility);
  }

  function renderReachLabels(routes) {
    reachLabels.replaceChildren(reachTails, reachLabelTip);
    reachLabelItems = [];
    routes.forEach((r) => {
      const facility = pointLayers.get(r.point_id);
      if (!facility) return;
      const name = r.name_zh || r.name || "Facility";
      const el = document.createElement("button");
      el.type = "button";
      el.className = "reach-label";
      el.textContent = name;
      el.style.visibility = "hidden";
      el.setAttribute("aria-label", `${name} — ${r.time_min.toFixed(1)} minutes`);
      const item = {
        el,
        facility,
        pointId: r.point_id,
        latlng: facility.getLatLng(),
        name,
        time: r.time_min,
        dist: Math.round(r.length_m),
        w: 0,
        h: 0,
        rect: null,
      };
      el.addEventListener("mouseenter", () => {
        showLabelTip(item);
        if (item.tail) item.tail.classList.add("is-hover");
      });
      el.addEventListener("mouseleave", () => {
        reachLabelTip.hidden = true;
        if (item.tail) item.tail.classList.remove("is-hover");
      });
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        selectFacility(r.point_id, facility);
      });
      // Keep the click inside the label: it must not start a new
      // service-area computation.
      L.DomEvent.disableClickPropagation(el);
      reachLabels.appendChild(el);
      reachLabelItems.push(item);
    });
    reachLabels.appendChild(reachLabelTip); // keep the hover tooltip above the labels
    layoutReachLabels();
  }

  map.on("move zoom resize", scheduleLabelLayout);

  // ---- service area query ---------------------------------------------

  async function compute(lat, lng) {
    const minutes = parseInt(slider.value, 10);
    const walkSpeedKmh = parseFloat(speedSlider.value);
    const err = document.getElementById("error");
    const res = document.getElementById("result");
    err.hidden = true;
    allRoutesLayer.clearLayers();
    focusRouteLayer.clearLayers();
    // The previous selection (route, card, highlights) belongs to the old
    // result set -> drop it.
    clearSelection();
    clearFacilityCard();
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
          pane: "serviceAreaPane",
          style: { color: "#16a34a", weight: 2, fillColor: "#16a34a", fillOpacity: 0.08 },
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
          color: "#3b82f6", weight: 2, opacity: 0.45,
        }).addTo(allRoutesLayer);
        const routeBounds = route.getBounds();
        if (routeBounds.isValid()) areaBounds.extend(routeBounds);
      });
      if (areaBounds.isValid()) {
        map.fitBounds(areaBounds, { padding: [70, 70], maxZoom: 17 });
      }

      document.getElementById("count").textContent = data.count;
      document.getElementById("totalPoints").textContent = ` / ${data.total_points}`;
      const routes = [...(data.routes || [])].sort((a, b) => a.time_min - b.time_min);
      renderFacilityList(routes);
      renderReachLabels(routes);
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