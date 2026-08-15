// app.js — UI orchestration: search -> fetch nodes -> terrain -> analysis -> render.

(() => {
  // ---- map setup ------------------------------------------------------------

  // zoom control bottom-right: top-left is occupied by the floating search box
  const map = L.map('map', { zoomControl: false }).setView([39.5, -98.35], 5);
  L.control.zoom({ position: 'bottomright' }).addTo(map);
  window.__map = map; // debugging hook

  const baseDark = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    maxZoom: 20, subdomains: 'abcd',
    attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
  }).addTo(map);
  const baseOsm = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '&copy; OpenStreetMap contributors',
  });
  const baseTopo = L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
    maxZoom: 17,
    attribution: '&copy; OpenStreetMap contributors, SRTM | &copy; OpenTopoMap (CC-BY-SA)',
  });
  const baseSat = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 19, attribution: 'Tiles &copy; Esri',
  });
  const hillshade = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Elevation/World_Hillshade/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 16, opacity: 0.35, attribution: 'Hillshade &copy; Esri',
  });

  const viewshedLayer = L.layerGroup().addTo(map);
  const linksLayer = L.layerGroup().addTo(map);
  const reportedLayer = L.layerGroup().addTo(map);
  const nodesLayer = L.layerGroup().addTo(map);
  const suggestLayer = L.layerGroup().addTo(map);
  const areaLayer = L.layerGroup().addTo(map);
  const whatifLayer = L.layerGroup().addTo(map);
  const measureLayer = L.layerGroup().addTo(map);

  L.control.layers(
    { 'Dark (CARTO)': baseDark, 'Streets (OSM)': baseOsm, 'Terrain (OpenTopoMap)': baseTopo, 'Satellite (Esri)': baseSat },
    {
      'Hillshade overlay': hillshade,
      'Coverage viewsheds': viewshedLayer,
      'Computed LOS links': linksLayer,
      'Reported RF neighbours': reportedLayer,
      'Nodes': nodesLayer,
      'Suggestions': suggestLayer,
    },
    { collapsed: true }
  ).addTo(map);

  // ---- dom ------------------------------------------------------------------

  const $ = (id) => document.getElementById(id);
  const statusEl = $('status');
  const progressWrap = $('progress-wrap');
  const progressBar = $('progress-bar');

  function setStatus(msg) { statusEl.textContent = msg; }
  function setProgress(frac) {
    if (frac == null) { progressWrap.classList.add('hidden'); return; }
    progressWrap.classList.remove('hidden');
    progressBar.style.width = `${Math.round(frac * 100)}%`;
  }

  // ---- geocoding ------------------------------------------------------------

  async function geocode(query) {
    // direct "lat, lon" input
    const m = query.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
    if (m) {
      const lat = parseFloat(m[1]), lon = parseFloat(m[2]);
      if (Math.abs(lat) <= 90 && Math.abs(lon) <= 180)
        return [{ lat, lon, label: `${lat.toFixed(5)}, ${lon.toFixed(5)}` }];
    }
    const res = await fetch(`/api/geocode?q=${encodeURIComponent(query)}`);
    if (!res.ok) throw new Error(`geocoder HTTP ${res.status}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    return data.results;
  }

  // ---- analysis pipeline ----------------------------------------------------

  let currentRun = 0;
  let lastResult = null;
  let lastQuery = null; // {bbox, label} for re-analysis after node edits
  let nodeMarkers = [];
  let siteMarkers = [];
  let linkLines = []; // [{link, line}] parallel to lastResult.links
  // key 'n<idx>' (node) or 's<idx>' (suggested site) ->
  //   { overlay, visible, bounds, imgData, name, lat, lon, marker }
  const activeViewsheds = new Map();

  // ---- per-node corrections (synced to the server, with history) ------------
  // { [nodeId]: { alt?: meters ASL, lat?, lon?, updatedAt } }

  const OV_KEY = 'meshplanner-node-overrides'; // legacy localStorage key, migrated once
  let overridesCache = {};

  function loadOverrides() { return overridesCache; }

  async function refreshOverrides() {
    try {
      const res = await fetch('/api/overrides');
      if (res.ok) overridesCache = await res.json();
    } catch (e) {
      console.warn('overrides fetch failed:', e);
    }
  }

  async function migrateLegacyOverrides() {
    let legacy = null;
    try { legacy = JSON.parse(localStorage.getItem(OV_KEY) || 'null'); } catch {}
    if (!legacy || !Object.keys(legacy).length) return;
    for (const [id, o] of Object.entries(legacy)) {
      try {
        await fetch(`/api/overrides/${id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(o),
        });
      } catch {}
    }
    localStorage.removeItem(OV_KEY);
    console.log(`migrated ${Object.keys(legacy).length} local corrections to the server`);
  }

  async function setOverride(id, o) {
    const res = o
      ? await fetch(`/api/overrides/${id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(o),
        })
      : await fetch(`/api/overrides/${id}`, { method: 'DELETE' });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `save failed (HTTP ${res.status})`);
    }
    await refreshOverrides();
  }

  function applyOverrides(nodes) {
    const all = loadOverrides();
    for (const n of nodes) {
      const o = all[n.id];
      if (!o) continue;
      if (o.lat != null && o.lon != null) { n.lat = o.lat; n.lon = o.lon; }
      if (o.alt != null) n.altOverride = o.alt;
      if (o.mobile === true) { n.mobile = true; n.mobileManual = true; }
      if (o.txp != null) n.txpOverride = o.txp;
      if (o.gain != null) n.gainOverride = o.gain;
      n.adjusted = true;
    }
  }

  function bboxAround(lat, lon, radiusKm) {
    const dLat = radiusKm / 111.32;
    const dLon = radiusKm / (111.32 * Math.cos((lat * Math.PI) / 180));
    return { minLat: lat - dLat, maxLat: lat + dLat, minLon: lon - dLon, maxLon: lon + dLon };
  }

  let currentNodeSource = 'public';
  async function runAnalysis(bbox, label, keepView = false) {
    lastQuery = { bbox, label, keepView };
    closeEditor();
    const runId = ++currentRun;
    const alive = () => runId === currentRun;
    const antenna = parseFloat($('antenna-select').value);
    const maxRange = parseFloat($('range-select').value) * 1000;
    const maxAgeDays = parseFloat($('age-select').value);

    try {
      // 1) nodes
      setStatus(currentNodeSource === 'local-tcp'
        ? `Fetching mesh nodes for ${label}…`
        : `Fetching mesh nodes for ${label}… (first fetch downloads the global DB, ~10 s)`);
      setProgress(0.05);
      const qs = new URLSearchParams({
        minLat: bbox.minLat, maxLat: bbox.maxLat,
        minLon: bbox.minLon, maxLon: bbox.maxLon, maxAgeDays,
      });
      const res = await fetch(`/api/nodes?${qs}`);
      if (!res.ok) throw new Error(`node API HTTP ${res.status}`);
      let { nodes } = await res.json();
      if (!alive()) return;
      applyOverrides(nodes);

      // keep it tractable in very dense metros: newest positions first
      const CAP = 350;
      let capped = false;
      if (nodes.length > CAP) {
        nodes.sort((a, b) => Date.parse(b.posAt || 0) - Date.parse(a.posAt || 0));
        nodes = nodes.slice(0, CAP);
        capped = true;
      }

      if (nodes.length === 0) {
        drawArea(bbox);
        renderEmpty(label);
        setProgress(null);
        return;
      }

      // 2) terrain
      setStatus(`Loading terrain tiles for ${nodes.length} nodes…`);
      const zoom = Elevation.pickZoom(bbox);
      await Elevation.prefetch(bbox, zoom, (d, t) => alive() && setProgress(0.1 + 0.25 * (d / t)));
      if (!alive()) return;

      // 3) LOS links
      const regionCounts = {}, presetCounts = {};
      nodes.forEach((n) => {
        if (n.region) regionCounts[n.region] = (regionCounts[n.region] || 0) + 1;
        if (n.preset) presetCounts[n.preset] = (presetCounts[n.preset] || 0) + 1;
      });
      const topRegion = Object.entries(regionCounts).sort((a, b) => b[1] - a[1])[0]?.[0];
      const topPreset = Object.entries(presetCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'LONG_FAST';
      const fGHz = Analysis.freqGHzForRegion(topRegion);
      const opts = { maxRange, antenna, zoom, fGHz, sens: Analysis.sensForPreset(topPreset), topPreset };
      // effective antenna height AGL: corrected height ASL minus terrain, else global default;
      // TX power from community override or hardware-model default; antenna gain from override
      nodes.forEach((n) => {
        n.ant = n.altOverride != null
          ? Math.max(1, n.altOverride - Elevation.elevationAt(n.lat, n.lon, zoom))
          : antenna;
        n.txDbm = n.txpOverride ?? Analysis.defaultTxDbm(n.hw, n.region);
        n.antGain = n.gainOverride ?? 0;
      });

      setStatus('Computing line-of-sight between node pairs…');
      const links = await Analysis.buildLinks(nodes, opts,
        (d, t) => alive() && setProgress(0.35 + 0.35 * (d / Math.max(t, 1))));
      if (!alive()) return;

      // per-link SNR observations recorded by the server's MQTT listener
      let linkObs = [];
      try {
        const or = await fetch('/api/linkobs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids: nodes.map((n) => n.id) }),
        });
        if (or.ok) linkObs = (await or.json()).obs || [];
      } catch {}
      if (!alive()) return;

      // calibrate the model against RF ground truth: reported neighbour links
      // plus accumulated gateway-reception observations
      const calibration = Analysis.calibrate(nodes, opts, linkObs);
      opts.envLoss = calibration.envLoss ?? 0;
      const heightEstimates = Analysis.estimateHeights(nodes, calibration.disagreements, opts);

      // 4) placement + role suggestions
      setStatus('Scoring candidate sites and roles…');
      const { placements, nComponents, compOf } =
        await Analysis.suggestPlacements(nodes, links, bbox, opts,
          (d, t) => alive() && setProgress(0.7 + 0.28 * (d / Math.max(t, 1))));
      if (!alive()) return;
      const roles = Analysis.suggestRoles(nodes, links, compOf, opts);

      lastResult = {
        nodes, links, placements, roles, nComponents, compOf, bbox, opts,
        capped, topRegion, calibration, keepView, heightEstimates,
        obsByPair: new Map(linkObs.map((o) => [`${o.a}-${o.b}`, o])),
      };
      render(lastResult, label);
      setProgress(null);
    } catch (e) {
      if (!alive()) return;
      console.error(e);
      setStatus(`Error: ${e.message}`);
      setProgress(null);
    }
  }

  // ---- rendering ------------------------------------------------------------

  const roleColor = (roleName) => {
    if (/ROUTER|REPEATER/.test(roleName)) return '#b06ef0';
    if (/MUTE|HIDDEN/.test(roleName)) return '#7d8794';
    if (roleName === 'CLIENT') return '#37c871';
    return '#4da3ff';
  };

  function drawArea(bbox) {
    areaLayer.clearLayers();
    L.rectangle([[bbox.minLat, bbox.minLon], [bbox.maxLat, bbox.maxLon]], {
      color: '#4da3ff', weight: 1, fill: false, dashArray: '6 6', opacity: 0.6,
    }).addTo(areaLayer);
  }

  function fmtAgo(iso) {
    if (!iso) return 'unknown';
    const d = (Date.now() - Date.parse(iso)) / 86400000;
    if (d < 1) return `${Math.round(d * 24)} h ago`;
    return `${Math.round(d)} d ago`;
  }

  const SLIDERS_SVG = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M3 6h18M3 12h18M3 18h18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="9" cy="6" r="2.7" fill="#171c25" stroke="currentColor" stroke-width="2"/><circle cx="15.5" cy="12" r="2.7" fill="#171c25" stroke="currentColor" stroke-width="2"/><circle cx="7" cy="18" r="2.7" fill="#171c25" stroke="currentColor" stroke-width="2"/></svg>';
  const POWER_SVG = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 3v9" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><path d="M6.6 6.6a8 8 0 1 0 10.8 0" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>';
  const PIN_SVG = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 21s-7-7.1-7-11.5a7 7 0 1 1 14 0C19 13.9 12 21 12 21z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M12 6.5v6M9 9.5h6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
  const RADIO_SVG = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="13" r="2" fill="currentColor"/><path d="M8.5 9.5a5 5 0 0 1 7 0M6 7a8.5 8.5 0 0 1 12 0" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M12 15v5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';

  // Popup card for a suggested new-node site — same style as node popups.
  function sitePopup(p, idx) {
    const key = 's' + idx;
    const vsOn = activeViewsheds.has(key);
    const tiles = [
      { v: `${p.elev} m`, k: 'Elevation', tip: 'Terrain elevation at the site' },
      { v: p.visibleNodes, k: 'Reaches', tip: `Existing nodes with terrain LOS from a ~10 m mast (${p.clearLinks ?? '?'} clear)` },
      { v: p.componentsSeen > 1 ? p.componentsSeen : '&mdash;', k: 'Bridges', tip: 'Disconnected clusters this site would join together' },
      { v: `${p.gapCoveredPct}%`, k: 'New cover', tip: 'Share of the sampled currently-uncovered nearby area this site would reach' },
    ];
    return `<div class="np">
      <div class="np-head"><span class="np-name">Suggested site #${idx + 1}</span></div>
      <div class="np-sub">${p.lat.toFixed(5)}, ${p.lon.toFixed(5)} &middot; assumes ~10 m mast &middot; ideal role: ROUTER</div>
      <div class="np-tiles cols-2">${tiles.map((t) =>
        `<div class="np-tile" title="${t.tip}"><div class="v">${t.v}</div><div class="k">${t.k}</div></div>`).join('')}</div>
      <div class="np-actions">
        <button class="np-icon vs-btn${vsOn ? ' on' : ''}" data-key="${key}" title="${vsOn ? 'Hide' : 'Show'} coverage viewshed">${EYE_SVG}</button>
        <button class="np-icon plan-btn" data-lat="${p.lat}" data-lon="${p.lon}" title="Open in the node planner — drag it around, try mast heights">${PIN_SVG}</button>
      </div>
    </div>`;
  }

  function nodePopup(n, i, deg) {
    const asl = n.altOverride ?? n.alt;
    const corrected = n.altOverride != null;
    const tiles = [
      { v: asl != null ? `${Math.round(asl)} m` : '&mdash;', k: 'ASL', hl: corrected, tip: corrected ? 'Corrected height above sea level' : 'Reported GPS altitude' },
      { v: n.ant != null ? `${Math.round(n.ant)} m` : '&mdash;', k: 'HAAT', hl: corrected, tip: 'Height above terrain used in the LOS model' },
      { v: deg != null ? deg : '&mdash;', k: 'LOS links', tip: 'Modelled line-of-sight neighbours' },
      { v: n.util != null ? n.util.toFixed(1) + '%' : '&mdash;', k: 'Ch util', tip: 'Channel utilization' },
      { v: n.battery != null ? (n.battery > 100 ? 'PWR' : n.battery + '%') : '&mdash;', k: 'Battery', tip: 'Battery level (PWR = externally powered)' },
      { v: fmtAgo(n.posAt).replace(' ago', ''), k: 'Pos age', tip: 'Time since last position report' },
    ];
    if (n.uptime != null) {
      tiles.push({
        v: `${Math.round(n.uptime * 100)}%`, k: 'Uptime',
        hl: n.uptime < 0.5,
        tip: 'Fraction of recent server samples where this node was actively reporting',
      });
    }
    if (n.txDbm != null) {
      tiles.push({
        v: `${n.txDbm}${n.antGain ? '+' + n.antGain : ''} dBm`, k: 'TX est',
        hl: n.txpOverride != null,
        tip: n.txpOverride != null
          ? 'TX power set by the community (Adjust)'
          : `TX power inferred from hardware model${n.hw ? ` (${n.hw})` : ''} — override in Adjust if known`,
      });
    }
    const vsOn = activeViewsheds.has('n' + i);
    const rfOn = activeViewsheds.has('r' + i);
    return `<div class="np">
      <div class="np-head">
        <span class="np-name">${escapeHtml(n.name)}</span>
        <span class="mono">${n.hex}</span>
        ${/live/.test(n.src || '') ? '<span class="live-dot" title="Fresh data from the live MQTT feed"></span>' : ''}
        ${n.adjusted ? '<span class="adj-badge">adjusted</span>' : ''}
        ${n.mobile || /TRACKER/.test(n.roleName || '') ? '<span class="mob-badge" title="Position changes frequently — excluded from calibration and role suggestions">mobile</span>' : ''}
      </div>
      <div class="np-sub">${n.roleName}${n.hw ? ' &middot; ' + escapeHtml(n.hw) : ''}${n.preset ? ' &middot; ' + escapeHtml(n.preset) : ''}${n.region ? ' &middot; ' + escapeHtml(n.region) : ''}</div>
      <div class="np-tiles">${tiles.map((t) =>
        `<div class="np-tile${t.hl ? ' hl' : ''}" title="${t.tip}"><div class="v">${t.v}</div><div class="k">${t.k}</div></div>`).join('')}</div>
      <div class="np-actions">
        <button class="np-icon vs-btn${vsOn ? ' on' : ''}" data-key="n${i}" title="${vsOn ? 'Hide' : 'Show'} line-of-sight viewshed">${EYE_SVG}</button>
        <button class="np-icon vs-btn${rfOn ? ' on' : ''}" data-key="r${i}" title="${rfOn ? 'Hide' : 'Show'} RF signal coverage (predicted margin bands)">${RADIO_SVG}</button>
        <button class="np-icon adj-btn" data-i="${i}" title="Adjust height / position / radio">${SLIDERS_SVG}</button>
        <button class="np-icon danger sim-btn${offlineSet.has(i) ? ' on' : ''}" data-i="${i}" title="${offlineSet.has(i) ? 'Restore node in simulation' : 'Simulate this node going offline'}">${POWER_SVG}</button>
      </div>
    </div>`;
  }

  // ---- failure simulation ---------------------------------------------------

  const offlineSet = new Set(); // node indices simulated offline

  function nodeBaseStyle(i) {
    const n = lastResult.nodes[i];
    if (offlineSet.has(i)) {
      return { color: '#ff5f56', weight: 1.5, radius: 7, dashArray: '2 3', fillOpacity: 0.25 };
    }
    if (i === selectedNode) return NODE_STYLE_SELECTED;
    if (i === prevSelectedNode) return NODE_STYLE_PREV;
    return { ...NODE_STYLE_DEFAULT, fillColor: roleColor(n.roleName) };
  }

  function toggleOffline(i) {
    if (!lastResult) return;
    if (offlineSet.has(i)) offlineSet.delete(i);
    else offlineSet.add(i);
    styleNode(i, nodeBaseStyle(i));
    applyFailureSim();
  }

  function applyFailureSim() {
    const banner = $('sim-banner');
    const { nodes, links, nComponents } = lastResult;
    if (offlineSet.size === 0) {
      linkLines.forEach(({ line }) => { if (!linksLayer.hasLayer(line)) linksLayer.addLayer(line); });
      banner.classList.add('hidden');
      return;
    }
    const online = (l) => !offlineSet.has(l.i) && !offlineSet.has(l.j);
    linkLines.forEach(({ link, line }) => {
      const show = online(link);
      if (show && !linksLayer.hasLayer(line)) linksLayer.addLayer(line);
      if (!show && linksLayer.hasLayer(line)) linksLayer.removeLayer(line);
    });
    const activeLinks = links.filter(online);
    const { compOf } = Analysis.components(nodes.length, activeLinks);
    const comps = new Set();
    const deg = new Array(nodes.length).fill(0);
    activeLinks.forEach((l) => { deg[l.i]++; deg[l.j]++; });
    const baseDeg = new Array(nodes.length).fill(0);
    links.forEach((l) => { baseDeg[l.i]++; baseDeg[l.j]++; });
    let newlyIsolated = 0;
    nodes.forEach((n, i) => {
      if (offlineSet.has(i)) return;
      comps.add(compOf[i]);
      if (deg[i] === 0 && baseDeg[i] > 0) newlyIsolated++;
    });
    const names = [...offlineSet].map((i) => escapeHtml(nodes[i].name)).slice(0, 3).join(', ');
    banner.innerHTML = `<b>Simulating offline:</b> ${names}${offlineSet.size > 3 ? ` +${offlineSet.size - 3} more` : ''}.
      Mesh splits into <b>${comps.size}</b> clusters (baseline ${nComponents});
      ${newlyIsolated} node${newlyIsolated === 1 ? '' : 's'} newly isolated.
      <a id="sim-reset">Reset simulation</a>`;
    banner.classList.remove('hidden');
    banner.querySelector('#sim-reset').addEventListener('click', resetFailureSim);
  }

  function resetFailureSim() {
    const had = [...offlineSet];
    offlineSet.clear();
    if (lastResult) had.forEach((i) => styleNode(i, nodeBaseStyle(i)));
    applyFailureSim();
  }

  // distinct per-viewshed colors (colorblind-aware ordering); freed on remove
  const VS_COLORS = ['#3ddc84', '#35d0e0', '#c290ff', '#ffb347', '#ff6ea8', '#f5e663'];

  function hexToRgba(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
  }

  function nextViewshedColor() {
    const used = new Set([...activeViewsheds.values()].map((v) => v.color));
    return VS_COLORS.find((c) => !used.has(c)) || VS_COLORS[activeViewsheds.size % VS_COLORS.length];
  }

  const EYE_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><circle cx="12" cy="12" r="2.5" stroke="currentColor" stroke-width="2"/></svg>';
  const EYE_OFF_SVG = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6z" stroke="currentColor" stroke-width="2" stroke-linejoin="round" opacity="0.45"/><path d="M4 3.5 20.5 20" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';

  // % of the analysis bbox covered by at least one *visible* viewshed
  function combinedCoveragePct() {
    if (!lastResult) return null;
    const vs = [...activeViewsheds.values()].filter((v) => v.visible && v.imgData);
    if (!vs.length) return null;
    const { bbox } = lastResult;
    const G = 64;
    let covered = 0;
    for (let gy = 0; gy < G; gy++) {
      for (let gx = 0; gx < G; gx++) {
        const lat = bbox.minLat + ((gy + 0.5) / G) * (bbox.maxLat - bbox.minLat);
        const lon = bbox.minLon + ((gx + 0.5) / G) * (bbox.maxLon - bbox.minLon);
        for (const v of vs) {
          const [[sLat, wLon], [nLat, eLon]] = v.bounds;
          if (lat < sLat || lat > nLat || lon < wLon || lon > eLon) continue;
          const W = v.imgData.width, H = v.imgData.height;
          const px = Math.floor(((lon - wLon) / (eLon - wLon)) * (W - 1));
          const py = Math.floor(((nLat - lat) / (nLat - sLat)) * (H - 1));
          if (v.imgData.data[(py * W + px) * 4 + 3] > 0) { covered++; break; }
        }
      }
    }
    return Math.round((covered / (G * G)) * 100);
  }

  // Hovering a viewshed row isolates it: full opacity for the hovered one,
  // heavy dim for the rest. key=null restores everyone.
  function isolateViewshed(key) {
    for (const [k, v] of activeViewsheds) {
      if (!v.visible) continue;
      v.overlay.setOpacity(key == null || k === key ? 1 : 0.12);
      if (k === key) v.overlay.bringToFront();
    }
  }

  function renderViewshedList() {
    const panel = $('viewshed-panel');
    const list = $('viewshed-list');
    const cov = $('vs-coverage');
    if (!lastResult || activeViewsheds.size === 0) {
      panel.classList.add('hidden');
      list.innerHTML = '';
      cov.classList.add('hidden');
      return;
    }
    panel.classList.remove('hidden');
    panel.open = true;
    const pct = combinedCoveragePct();
    if (pct != null) {
      cov.innerHTML = `Combined coverage: <b>${pct}%</b> of the analysis area (visible viewsheds, receiver at 2 m)`;
      cov.classList.remove('hidden');
    } else {
      cov.classList.add('hidden');
    }
    list.innerHTML = [...activeViewsheds.entries()].map(([key, v]) =>
      `<div class="vs-row ${v.visible ? '' : 'off'}" data-key="${key}">
        <span class="vs-color" style="background:${v.rf ? 'linear-gradient(90deg,#3ddc84,#ffb347,#ff5f56)' : (v.color || '#1e9e50')}"></span>
        <span class="nm" title="${escapeHtml(v.name)}">${escapeHtml(v.name)}</span>
        <button class="icon-btn vs-eye" title="${v.visible ? 'Hide' : 'Show'}">${v.visible ? EYE_SVG : EYE_OFF_SVG}</button>
        <button class="icon-btn vs-x" title="Remove">&#10005;</button>
      </div>`).join('');
    list.querySelectorAll('.vs-row').forEach((row) => {
      const key = row.dataset.key;
      row.addEventListener('mouseenter', () => isolateViewshed(key));
      row.addEventListener('mouseleave', () => isolateViewshed(null));
      row.querySelector('.nm').addEventListener('click', () => {
        const v = activeViewsheds.get(key);
        if (!v) return;
        map.setView([v.lat, v.lon], Math.max(map.getZoom(), 11));
        if (v.marker) v.marker.openPopup();
      });
      row.querySelector('.vs-eye').addEventListener('click', () => {
        const v = activeViewsheds.get(key);
        if (!v) return;
        if (v.visible) viewshedLayer.removeLayer(v.overlay);
        else v.overlay.addTo(viewshedLayer);
        v.visible = !v.visible;
        renderViewshedList();
      });
      row.querySelector('.vs-x').addEventListener('click', () => {
        const v = activeViewsheds.get(key);
        if (v) viewshedLayer.removeLayer(v.overlay);
        activeViewsheds.delete(key);
        renderViewshedList();
      });
    });
  }

  // Resolve a viewshed key ('n<idx>' node / 's<idx>' suggested site) to its
  // location, antenna height, display name, and marker.
  function viewshedTarget(key) {
    if (!lastResult) return null;
    const idx = parseInt(key.slice(1), 10);
    if (key[0] === 'n' || key[0] === 'r') {
      const n = lastResult.nodes[idx];
      if (!n) return null;
      return {
        lat: n.lat, lon: n.lon, ant: n.ant ?? lastResult.opts.antenna,
        name: key[0] === 'r' ? `${n.name} (RF)` : n.name,
        marker: nodeMarkers[idx],
        rf: key[0] === 'r',
        txDbm: (n.txDbm ?? 22) + (n.antGain || 0),
      };
    }
    if (key[0] === 's') {
      const p = lastResult.placements[idx];
      return p && { lat: p.lat, lon: p.lon, ant: 10, name: `Suggested site ${idx + 1}`, marker: siteMarkers[idx] };
    }
    return null;
  }

  async function toggleViewshed(key) {
    if (!lastResult) return;
    const existing = activeViewsheds.get(key);
    if (existing) {
      viewshedLayer.removeLayer(existing.overlay);
      activeViewsheds.delete(key);
      renderViewshedList();
      return;
    }
    const t = viewshedTarget(key);
    if (!t) return;
    const { opts } = lastResult;
    const mLat = 111320;
    const mLon = 111320 * Math.cos((t.lat * Math.PI) / 180);
    const vb = {
      minLat: t.lat - opts.maxRange / mLat, maxLat: t.lat + opts.maxRange / mLat,
      minLon: t.lon - opts.maxRange / mLon, maxLon: t.lon + opts.maxRange / mLon,
    };
    setStatus(`Computing ${t.rf ? 'RF signal coverage' : 'coverage viewshed'} for ${t.name}…`);
    // finer terrain zoom over the (smaller) viewshed circle than the area pass
    const vz = Elevation.pickZoom(vb, 110, 13);
    const color = t.rf ? null : nextViewshedColor();
    await Elevation.prefetch(vb, vz, (d, t2) => setProgress(0.5 * (d / t2)));
    const vs = t.rf
      ? await Analysis.rfCoverage(t.lat, t.lon, t.ant, 2,
          { ...opts, zoom: vz, txDbm: t.txDbm },
          (d, t2) => setProgress(0.5 + 0.5 * (d / t2)))
      : await Analysis.viewshed(t.lat, t.lon, t.ant, 2,
          { ...opts, zoom: vz, vsColor: hexToRgba(color, 0.55) },
          (d, t2) => setProgress(0.5 + 0.5 * (d / t2)));
    const overlay = L.imageOverlay(vs.url, vs.bounds, { opacity: 1, interactive: false });
    overlay.addTo(viewshedLayer);
    const vctx = vs.canvas.getContext('2d');
    activeViewsheds.set(key, {
      overlay, visible: true, bounds: vs.bounds,
      imgData: vctx.getImageData(0, 0, vs.canvas.width, vs.canvas.height),
      name: t.name, lat: t.lat, lon: t.lon, marker: t.marker, color, rf: !!t.rf,
    });
    renderViewshedList();
    setProgress(null);
    setStatus(t.rf
      ? `RF coverage for ${t.name}: green ≥20 dB margin, amber usable, red fringe (2 m receiver, ${t.txDbm} dBm TX, ` +
        `${opts.envLoss > 0 ? `${opts.envLoss.toFixed(0)} dB calibrated` : 'assumed 10 dB'} clutter loss).`
      : `Viewshed for ${t.name}: terrain-clear line of sight to a receiver at 2 m.`);
  }

  map.on('popupopen', (e) => {
    const el = e.popup.getElement();
    if (!el) return;
    el.querySelectorAll('.vs-btn[data-key]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const key = btn.dataset.key;
        btn.disabled = true;
        await toggleViewshed(key);
        btn.disabled = false;
        btn.classList.toggle('on', activeViewsheds.has(key));
      });
    });
    const plan = el.querySelector('.plan-btn');
    if (plan) {
      plan.addEventListener('click', () => {
        map.closePopup();
        placeWhatif(L.latLng(parseFloat(plan.dataset.lat), parseFloat(plan.dataset.lon)));
      });
    }
    const adj = el.querySelector('.adj-btn');
    if (adj) adj.addEventListener('click', () => openEditor(parseInt(adj.dataset.i, 10)));
    const sim = el.querySelector('.sim-btn');
    if (sim) {
      sim.addEventListener('click', () => {
        const i = parseInt(sim.dataset.i, 10);
        toggleOffline(i);
        const on = offlineSet.has(i);
        sim.classList.toggle('on', on);
        sim.title = on ? 'Restore node in simulation' : 'Simulate this node going offline';
      });
    }
  });

  // ---- node adjustment editor ----------------------------------------------

  let editState = null; // { i, marker, origLat, origLon, posDirty }

  function setCoordsInput(lat, lon) {
    $('edit-coords').value = `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
  }

  function heightFieldMeters() {
    const v = parseFloat($('edit-height').value);
    if (Number.isNaN(v)) return null;
    return $('edit-unit').value === 'ft' ? v * 0.3048 : v;
  }

  function openEditor(i) {
    if (!lastResult) return;
    closeEditor();
    const n = lastResult.nodes[i];
    map.closePopup();
    const marker = L.marker([n.lat, n.lon], {
      draggable: true,
      zIndexOffset: 2000,
      icon: L.divIcon({ className: '', html: '<div class="edit-pin"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }),
    }).addTo(map);
    editState = { i, marker, origLat: n.lat, origLon: n.lon, posDirty: false };
    $('edit-name').textContent = n.name;
    const altM = n.altOverride ?? n.alt;
    $('edit-unit').value = 'm';
    $('edit-height').value = altM != null ? Math.round(altM) : '';
    $('edit-mobile').checked = loadOverrides()[n.id]?.mobile === true;
    const ov = loadOverrides()[n.id] || {};
    $('edit-txp').value = ov.txp ?? '';
    $('edit-txp').placeholder = `auto (${Analysis.defaultTxDbm(n.hw, n.region)})`;
    $('edit-gain').value = ov.gain ?? '';
    setCoordsInput(n.lat, n.lon);
    marker.on('drag', () => {
      editState.posDirty = true;
      const p = marker.getLatLng();
      setCoordsInput(p.lat, p.lng);
    });
    $('edit-panel').classList.remove('hidden');
    loadEditHistory(n.id);
  }

  async function loadEditHistory(nodeId) {
    const wrap = $('edit-history');
    const list = $('edit-history-list');
    wrap.classList.add('hidden');
    list.innerHTML = '';
    let history = [];
    try {
      const res = await fetch(`/api/overrides/${nodeId}/history`);
      if (res.ok) history = (await res.json()).history || [];
    } catch {}
    if (!editState || lastResult.nodes[editState.i].id !== nodeId || !history.length) return;
    list.innerHTML = history.slice(0, 6).map((e, k) => {
      const when = fmtAgo(e.at).replace(' ago', '');
      if (e.action === 'clear') return `<div class="eh-row muted" data-k="${k}">${when} &middot; cleared</div>`;
      const parts = [];
      if (e.alt != null) parts.push(`${Math.round(e.alt)} m`);
      if (e.lat != null) parts.push(`${e.lat.toFixed(4)}, ${e.lon.toFixed(4)}`);
      if (e.mobile) parts.push('mobile');
      if (e.txp != null) parts.push(`${e.txp} dBm`);
      if (e.gain != null) parts.push(`${e.gain} dBi`);
      return `<div class="eh-row" data-k="${k}" title="Click to restore these values into the form">${when} &middot; ${parts.join(' &middot; ')}</div>`;
    }).join('');
    list.querySelectorAll('.eh-row:not(.muted)').forEach((row) => {
      row.addEventListener('click', () => {
        const e = history[parseInt(row.dataset.k, 10)];
        if (!editState || !e) return;
        if (e.alt != null) {
          $('edit-unit').value = 'm';
          $('edit-height').value = Math.round(e.alt);
        }
        if (e.lat != null) {
          editState.posDirty = true;
          editState.marker.setLatLng([e.lat, e.lon]);
          setCoordsInput(e.lat, e.lon);
        }
      });
    });
    wrap.classList.remove('hidden');
  }

  function closeEditor() {
    if (!editState) return;
    map.removeLayer(editState.marker);
    editState = null;
    $('edit-panel').classList.add('hidden');
  }

  $('edit-coords').addEventListener('input', () => {
    if (!editState) return;
    const m = $('edit-coords').value.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
    if (!m) return;
    const lat = parseFloat(m[1]), lon = parseFloat(m[2]);
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return;
    editState.posDirty = true;
    editState.marker.setLatLng([lat, lon]);
  });

  $('edit-unit').addEventListener('change', () => {
    // convert the displayed value in place
    const v = parseFloat($('edit-height').value);
    if (Number.isNaN(v)) return;
    $('edit-height').value = $('edit-unit').value === 'ft'
      ? Math.round(v / 0.3048) : Math.round(v * 0.3048);
  });

  $('edit-save').addEventListener('click', async () => {
    if (!editState || !lastResult) return;
    const n = lastResult.nodes[editState.i];
    const alt = heightFieldMeters();
    const p = editState.marker.getLatLng();
    const o = {};
    if (alt != null) o.alt = alt;
    if ($('edit-mobile').checked) o.mobile = true;
    const txp = parseFloat($('edit-txp').value);
    if (Number.isFinite(txp)) o.txp = txp;
    const gain = parseFloat($('edit-gain').value);
    if (Number.isFinite(gain)) o.gain = gain;
    if (editState.posDirty) { o.lat = p.lat; o.lon = p.lng; }
    else if (n.adjusted) {
      // keep a previously saved position override
      const prev = loadOverrides()[n.id];
      if (prev && prev.lat != null) { o.lat = prev.lat; o.lon = prev.lon; }
    }
    try {
      await setOverride(n.id, Object.keys(o).length ? o : null);
    } catch (e) {
      setStatus(`Could not save correction: ${e.message}`);
      return;
    }
    closeEditor();
    if (lastQuery) runAnalysis(lastQuery.bbox, lastQuery.label, lastQuery.keepView);
  });

  $('edit-clear').addEventListener('click', async () => {
    if (!editState || !lastResult) return;
    try {
      await setOverride(lastResult.nodes[editState.i].id, null);
    } catch (e) {
      setStatus(`Could not clear correction: ${e.message}`);
      return;
    }
    closeEditor();
    if (lastQuery) runAnalysis(lastQuery.bbox, lastQuery.label, lastQuery.keepView);
  });

  $('edit-cancel').addEventListener('click', closeEditor);

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function render(r, label) {
    const { nodes, links, placements, roles, nComponents, bbox, opts } = r;

    drawArea(bbox);
    nodesLayer.clearLayers();
    linksLayer.clearLayers();
    reportedLayer.clearLayers();
    suggestLayer.clearLayers();
    viewshedLayer.clearLayers();
    activeViewsheds.clear();
    renderViewshedList();
    clearSelection();
    offlineSet.clear();
    $('sim-banner').classList.add('hidden');
    removeWhatif();
    clearMeasure();

    // computed LOS links (refs kept for the failure simulation)
    linkLines = links.map((l) => {
      const a = nodes[l.i], b = nodes[l.j];
      const line = L.polyline([[a.lat, a.lon], [b.lat, b.lon]], {
        color: l.status === 'clear' ? '#3ddc84' : '#ffb347',
        weight: l.status === 'clear' ? 2.2 : 1.8,
        opacity: l.status === 'clear' ? 0.75 : 0.7,
        dashArray: l.status === 'clear' ? null : '6 6',
      }).bindPopup(
        `<b>${escapeHtml(a.name)} ↔ ${escapeHtml(b.name)}</b><br>` +
        `${(l.dist / 1000).toFixed(1)} km — ${l.status === 'clear' ? 'clear LOS + Fresnel' : 'LOS clear, Fresnel obstructed'}`
      ).addTo(linksLayer);
      return { link: l, line };
    });

    // reported RF neighbours (ground truth from neighbour_info packets)
    const byId = new Map(nodes.map((n, i) => [n.id, i]));
    const seenPairs = new Set();
    for (const n of nodes) {
      if (!n.neighbours) continue;
      for (const nb of n.neighbours) {
        const j = byId.get(nb.id);
        if (j == null) continue;
        const key = [Math.min(n.id, nb.id), Math.max(n.id, nb.id)].join('-');
        if (seenPairs.has(key)) continue;
        seenPairs.add(key);
        const b = nodes[j];
        L.polyline([[n.lat, n.lon], [b.lat, b.lon]], {
          color: '#4da3ff', weight: 1.8, opacity: 0.8, dashArray: '2 7',
        }).bindPopup(
          `<b>Reported RF link</b><br>${escapeHtml(n.name)} heard ${escapeHtml(b.name)}<br>SNR ${nb.snr} dB`
        ).addTo(reportedLayer);
      }
    }

    // nodes
    nodeMarkers = nodes.map((n, i) => {
      const deg = roles.degree ? roles.degree[i] : 0;
      return L.circleMarker([n.lat, n.lon], {
        radius: 7,
        color: '#e6ebf2',
        weight: 1.5,
        fillColor: roleColor(n.roleName),
        fillOpacity: 1,
      // content as a function so the viewshed button label is fresh on each open
      }).bindPopup(() => nodePopup(n, i, deg))
        .on('click', () => selectNode(i))
        .addTo(nodesLayer);
    });

    // placement suggestions
    siteMarkers = placements.map((p, idx) => {
      return L.marker([p.lat, p.lon], {
        icon: L.divIcon({
          className: '',
          html: `<div style="width:22px;height:22px;background:#ffd84d;border:2px solid #14181f;border-radius:4px;display:flex;align-items:center;justify-content:center;font-weight:700;color:#14181f;font-size:12px;box-shadow:0 1px 6px #000a">${idx + 1}</div>`,
          iconSize: [22, 22], iconAnchor: [11, 11],
        }),
      // content as a function so the viewshed button state is fresh on open
      }).bindPopup(() => sitePopup(p, idx)).addTo(suggestLayer);
    });

    renderStats(r, label);
    renderSuggestions(r);
    $('node-panel').classList.remove('hidden');

    if (!r.keepView) map.fitBounds([[bbox.minLat, bbox.minLon], [bbox.maxLat, bbox.maxLon]]);
    const utilNodes = nodes.filter((n) => n.util != null);
    const meanUtil = utilNodes.length
      ? utilNodes.reduce((s, n) => s + n.util, 0) / utilNodes.length : null;
    setStatus(`${label}: ${nodes.length} nodes, ${links.length} modelled links, ` +
      `${nComponents > 1 ? nComponents + ' disconnected clusters' : 'fully connected'}` +
      (meanUtil != null ? `, ${meanUtil.toFixed(1)}% avg channel util` : '') +
      (r.calibration && r.calibration.observed > 0
        ? `. Model matched ${r.calibration.agree}/${r.calibration.observed} observed RF links` +
          (r.calibration.excludedMobile ? ` (${r.calibration.excludedMobile} mobile pair${r.calibration.excludedMobile === 1 ? '' : 's'} excluded)` : '') +
          (r.calibration.envLoss != null ? `; ~${r.calibration.envLoss.toFixed(0)} dB local clutter loss applied to link budgets` : '')
        : '') +
      (r.capped ? ' (dense area — capped to 350 newest nodes)' : ''));
  }

  function renderEmpty(label) {
    $('stats-panel').classList.add('hidden');
    $('node-panel').classList.add('hidden');
    $('quality-panel').classList.add('hidden');
    $('suggestions-panel').classList.remove('hidden');
    nodesLayer.clearLayers(); linksLayer.clearLayers();
    reportedLayer.clearLayers(); suggestLayer.clearLayers();
    setStatus(`${label}: no positioned nodes reported via MQTT in this area/age window.`);
    $('suggestions').innerHTML =
      `<div class="sugg issue"><div class="t">No nodes found</div>
       <div class="why">No Meshtastic nodes with public positions were reported here recently.
       Try a larger radius or longer node-age window. Note: only nodes that publish
       position over MQTT appear in this dataset — a quiet map doesn't mean an empty mesh.</div></div>`;
  }

  function renderStats(r, label) {
    const { nodes, links, nComponents, roles } = r;
    const clear = links.filter((l) => l.status === 'clear').length;
    const utilNodes = nodes.filter((n) => n.util != null);
    const meanUtil = utilNodes.length
      ? utilNodes.reduce((s, n) => s + n.util, 0) / utilNodes.length : null;
    const routers = nodes.filter((n) => /ROUTER|REPEATER/.test(n.roleName)).length;
    const muted = nodes.filter((n) => /MUTE|HIDDEN/.test(n.roleName)).length;

    const stats = [
      { k: 'Nodes', v: nodes.length },
      { k: 'Modelled links', v: `${clear} clear / ${links.length - clear} marginal` },
      { k: 'Clusters', v: nComponents, cls: nComponents > 1 ? 'warn' : '' },
      { k: 'Isolated nodes', v: roles.isolated.length, cls: roles.isolated.length ? 'warn' : '' },
      { k: 'Routers', v: routers },
      { k: 'Muted clients', v: muted },
    ];
    if (meanUtil != null) {
      stats.push({
        k: 'Avg ch. util', v: meanUtil.toFixed(1) + '%',
        cls: meanUtil > 25 ? 'bad' : meanUtil > 15 ? 'warn' : '',
      });
    }
    const cal = r.calibration;
    if (cal && cal.observed > 0) {
      stats.push({
        k: 'Obs. links match', v: `${cal.agree}/${cal.observed}`,
        cls: cal.agree / cal.observed < 0.7 ? 'warn' : '',
      });
    }
    if (cal && cal.envLoss != null) {
      stats.push({ k: `Env. loss (${cal.snrSamples} SNR)`, v: `~${cal.envLoss.toFixed(0)} dB` });
    }
    $('stats').innerHTML = stats.map((s) =>
      `<div class="stat ${s.cls || ''}"><div class="v">${s.v}</div><div class="k">${s.k}</div></div>`).join('');
    $('stats-panel').classList.remove('hidden');
  }

  function renderSuggestions(r) {
    const { nodes, placements, roles, nComponents } = r;
    const items = [];
    const zoomTo = (lat, lon) => `data-lat="${lat}" data-lon="${lon}"`;
    const nodeRef = (i) => `data-lat="${nodes[i].lat}" data-lon="${nodes[i].lon}" data-node="${i}"`;

    const utilNodes = nodes.filter((n) => n.util != null);
    const meanUtil = utilNodes.length
      ? utilNodes.reduce((s, n) => s + n.util, 0) / utilNodes.length : null;
    if (meanUtil != null && meanUtil > 25) {
      items.push(`<div class="sugg congestion"><div class="t"><span class="tag">AIRTIME</span>Channel is congested (${meanUtil.toFixed(0)}% avg utilization)</div>
        <div class="why">Above ~25% utilization the mesh drops packets. Prioritize the CLIENT_MUTE suggestions below, reduce telemetry/position intervals, and avoid adding ROUTER roles.</div></div>`);
    }

    if (nComponents > 1) {
      items.push(`<div class="sugg issue"><div class="t"><span class="tag">TOPOLOGY</span>${nComponents} disconnected clusters</div>
        <div class="why">Terrain splits this mesh into ${nComponents} groups that likely can't hear each other. The starred sites below are chosen to bridge them.</div></div>`);
    }

    // observation-driven height estimates take precedence over raw
    // disagreement cards — they carry an actionable fix
    const estimated = new Set((r.heightEstimates || []).map((e) => e.i));
    (r.heightEstimates || []).forEach((e) => {
      const n = nodes[e.i];
      items.push(`<div class="sugg role-up" ${nodeRef(e.i)} data-est-asl="${e.asl}">
        <div class="t"><span class="tag">HEIGHT EST</span>${escapeHtml(n.name)}: antenna likely ~${e.height} m above terrain</div>
        <div class="why">Modeling this node at ${e.height} m AGL (&asymp;${e.asl} m ASL) makes ${e.fixes} of ${e.of} observed-but-model-blocked links viable (evidence: ${e.evidence} weighted receptions — the estimate sharpens as more accumulate). Click to open Adjust prefilled with the estimate, then Save to apply it for everyone.</div></div>`);
    });

    const cal = r.calibration;
    if (cal) {
      cal.disagreements
        .filter((d) => !estimated.has(d.i) && !estimated.has(d.j))
        .slice(0, 4).forEach((d) => {
          const a = nodes[d.i], b = nodes[d.j];
          items.push(`<div class="sugg congestion" ${nodeRef(d.i)}>
            <div class="t"><span class="tag">CALIBRATE</span>${escapeHtml(a.name)} &harr; ${escapeHtml(b.name)}: heard, but model says blocked</div>
            <div class="why">These nodes ${d.nObs ? `were directly heard by each other ${d.nObs} times` : 'report hearing each other'}${d.snr != null ? ` (SNR ${d.snr.toFixed ? d.snr.toFixed(1) : d.snr} dB)` : ''} over ${(d.dist / 1000).toFixed(1)} km, but the terrain model says the path is blocked. One of them is probably higher (or elsewhere) than assumed — open it and use Adjust to correct its height/position.</div></div>`);
        });
    }

    placements.forEach((p, idx) => {
      items.push(`<div class="sugg place" ${zoomTo(p.lat, p.lon)} data-site="${idx}">
        <div class="t"><span class="tag">SITE ${idx + 1}</span>New node at ${p.lat.toFixed(4)}, ${p.lon.toFixed(4)} (${p.elev} m)</div>
        <div class="why">${p.bridges > 0 ? `<b>Bridges ${p.componentsSeen} clusters.</b> ` : ''}LOS to ${p.visibleNodes} existing nodes (${p.clearLinks} clear)${p.gapCoveredPct ? `; newly covers ~${p.gapCoveredPct}% of the mesh's current dead zones` : ''}. Assumes ~10 m mast. Ideal role: ROUTER (solar + flat-window omni).</div></div>`);
    });

    roles.routerUp.forEach(({ i, degree, elev }) => {
      const n = nodes[i];
      items.push(`<div class="sugg role-up" ${nodeRef(i)}>
        <div class="t"><span class="tag">ROLE</span>${escapeHtml(n.name)}: CLIENT &rarr; consider ROUTER</div>
        <div class="why">This node is a cut-point — if it goes quiet, parts of the mesh separate. It's elevated (${elev} m) with ${degree} modelled links.${n.uptime != null ? ` Observed uptime ${Math.round(n.uptime * 100)}%.` : ''} If it's stationary with good power, ROUTER makes its rebroadcasts reliable. (Don't add more than 1–2 routers per area.)</div></div>`);
    });

    roles.muteDown.forEach(({ i, degree, nearby }) => {
      const n = nodes[i];
      items.push(`<div class="sugg role-mute" ${nodeRef(i)}>
        <div class="t"><span class="tag">ROLE</span>${escapeHtml(n.name)}: CLIENT &rarr; CLIENT_MUTE</div>
        <div class="why">${nearby} nodes within 3 km and ${degree} redundant links — its rebroadcasts add airtime without extending coverage (it sits low relative to neighbours). Muting it frees channel capacity.</div></div>`);
    });

    roles.routerExcess.forEach((c) => {
      const lowest = nodes[c.lowest];
      items.push(`<div class="sugg congestion" ${zoomTo(c.centerLat, c.centerLon)} data-node="${c.lowest}">
        <div class="t"><span class="tag">ROLE</span>${c.members.length} routers within 5 km</div>
        <div class="why">Multiple ROUTER-role nodes close together multiply rebroadcasts. Consider demoting the lowest-elevation one (${escapeHtml(lowest.name)}) to CLIENT.</div></div>`);
    });

    roles.isolated.slice(0, 5).forEach(({ i, nearest }) => {
      const n = nodes[i];
      items.push(`<div class="sugg issue" ${nodeRef(i)}>
        <div class="t"><span class="tag">ISOLATED</span>${escapeHtml(n.name)} has no modelled links</div>
        <div class="why">${nearest ? `Nearest node (${escapeHtml(nearest.name)}) is ${nearest.distKm.toFixed(1)} km away — terrain-blocked or out of range.` : 'No other nodes in the area.'} Raising the antenna or relocating uphill may help; otherwise it depends on a new relay site.</div></div>`);
    });

    if (items.length === 0) {
      items.push(`<div class="sugg"><div class="t">Network looks healthy</div>
        <div class="why">Single connected cluster, no congestion signals, no obviously redundant or missing nodes at this radius. Try a larger radius to check regional connectivity.</div></div>`);
    }

    if (placements.length) {
      items.push(`<button id="gpx-btn" class="secondary wide">Export suggested sites (GPX)</button>`);
    }

    const el = $('suggestions');
    el.innerHTML = items.join('');
    $('suggestions-panel').classList.remove('hidden');
    const gpxBtn = el.querySelector('#gpx-btn');
    if (gpxBtn) gpxBtn.addEventListener('click', () => exportSitesGpx(placements));
    el.querySelectorAll('[data-lat]').forEach((div) => {
      div.addEventListener('click', () => {
        map.setView([parseFloat(div.dataset.lat), parseFloat(div.dataset.lon)], 13);
        const marker = div.dataset.node != null ? nodeMarkers[+div.dataset.node]
          : div.dataset.site != null ? siteMarkers[+div.dataset.site] : null;
        if (marker) marker.openPopup();
        if (div.dataset.node != null) selectNode(+div.dataset.node);
        // height-estimate cards open the editor prefilled with the estimate
        if (div.dataset.estAsl != null && div.dataset.node != null) {
          openEditor(+div.dataset.node);
          $('edit-unit').value = 'm';
          $('edit-height').value = div.dataset.estAsl;
        }
      });
    });
  }

  function exportSitesGpx(placements) {
    const wpts = placements.map((p, i) =>
      `  <wpt lat="${p.lat.toFixed(6)}" lon="${p.lon.toFixed(6)}">
    <ele>${p.elev}</ele>
    <name>Mesh site ${i + 1}</name>
    <desc>Elevation ${p.elev} m; LOS to ${p.visibleNodes} nodes${p.bridges ? `; bridges ${p.componentsSeen} clusters` : ''}; assumes ~10 m mast</desc>
  </wpt>`).join('\n');
    const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Mesh Planner" xmlns="http://www.topografix.com/GPX/1/1">
${wpts}
</gpx>\n`;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([gpx], { type: 'application/gpx+xml' }));
    a.download = 'mesh-planner-sites.gpx';
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // ---- node data quality card -----------------------------------------------

  // Position precision bits -> approximate error radius in meters
  // (coords are int32 1e-7 degrees; masking to `bits` gives step 2^(32-bits))
  function precisionErrM(bits) {
    return (2 ** (32 - bits)) * 1e-7 * 111320 / 2;
  }

  function renderQuality(i) {
    const { nodes, opts, calibration, heightEstimates } = lastResult;
    const n = nodes[i];
    const checks = [];
    let suspicion = 0;
    // scored=true rows feed the verdict (data-correctness signals);
    // informational rows (uptime, freshness) show but don't score
    const add = (level, title, detail, scored = true) => {
      checks.push({ level, title, detail });
      if (scored && level === 'bad') suspicion += 2;
      if (scored && level === 'warn') suspicion += 1;
    };

    if (n.adjusted) {
      add('ok', 'Community corrected',
        'This node’s height/position has been manually corrected — the corrected values are used for all modeling below.', false);
    }

    // position precision
    if (n.prec != null && n.prec > 0 && n.prec < 32) {
      const err = Math.round(precisionErrM(n.prec));
      if (err >= 800) {
        add('bad', 'Position truncated for privacy',
          `Broadcast at reduced precision — the true location is anywhere within ~±${(err / 1000).toFixed(1)} km. Terrain modeling against this position is unreliable.`);
      } else if (err >= 150) {
        add('warn', 'Position slightly truncated',
          `~±${err} m broadcast precision — fine for area modeling, may matter on ridgelines.`);
      } else {
        add('ok', 'Position precision', `~±${err} m — effectively exact for RF modeling.`);
      }
    } else if (n.prec === 32) {
      add('ok', 'Position precision', 'Full precision broadcast.');
    } else {
      add('unk', 'Position precision unknown', 'This node’s data source doesn’t report a precision setting.', false);
    }

    // altitude plausibility vs terrain
    const terrain = Elevation.elevationAt(n.lat, n.lon, opts.zoom);
    if (n.altOverride != null) {
      add('ok', 'Height corrected', `Community-set ${Math.round(n.altOverride)} m ASL (${Math.round(n.ant)} m above terrain).`, false);
    } else if (n.alt == null) {
      add('unk', 'Altitude not reported', `Modeled at the global default ${opts.antenna} m above terrain.`, false);
    } else {
      const diff = n.alt - terrain;
      if (diff < -30) {
        add('bad', 'GPS altitude below ground',
          `Reports ${Math.round(n.alt)} m ASL but the terrain here is ${Math.round(terrain)} m — GPS altitude is off by ${Math.round(-diff)} m. Worth correcting via Adjust.`);
      } else if (diff > 120) {
        add('warn', 'Altitude far above terrain',
          `Reports ${Math.round(diff)} m above ground — genuine tower/high-rise, or GPS error.`);
      } else {
        add('ok', 'Altitude plausible',
          `${Math.round(n.alt)} m ASL, ${diff >= 0 ? '+' : ''}${Math.round(diff)} m vs local terrain.`);
      }
    }

    // movement / stability
    if (n.mobile || /TRACKER/.test(n.roleName || '')) {
      add('warn', 'Mobile node',
        n.mobileManual
          ? 'Flagged as mobile by the community — the shown location is a snapshot. Excluded from calibration and role suggestions.'
          : 'Position hops between server samples — the shown location is a snapshot. Excluded from calibration and role suggestions.');
    } else if ((n.relSamples || 0) >= 5) {
      add('ok', 'Position stable', `No significant movement across ${n.relSamples} server samples.`);
    } else {
      add('unk', 'Stability unknown', 'Still accumulating movement samples (a few hours of tracking needed).', false);
    }

    // RF evidence from observed links
    const detail = (calibration && calibration.pairsDetail) || [];
    const mine = detail.filter((p) => p.i === i || p.j === i);
    const contradicting = mine.filter((p) => p.status === 'blocked');
    if (mine.length === 0) {
      add('unk', 'No RF observations yet',
        'No direct receptions involving this node recorded so far — evidence accumulates as gateways hear it.', false);
    } else if (contradicting.length === 0) {
      const totObs = mine.reduce((s, p) => s + p.nObs, 0);
      add('ok', 'RF evidence consistent',
        `${mine.length} observed link${mine.length === 1 ? '' : 's'}${totObs ? ` (${totObs} receptions)` : ''} all compatible with the terrain model.`);
    } else {
      const est = (heightEstimates || []).find((e) => e.i === i);
      add(contradicting.length > mine.length / 2 ? 'bad' : 'warn', 'RF evidence contradicts model',
        `${contradicting.length} of ${mine.length} observed links shouldn’t work according to the terrain model` +
        (est ? ` — observations suggest the antenna is really ~${est.height} m above terrain (see the HEIGHT EST suggestion).` : ' — reported height or position is likely wrong.'));
    }

    // informational rows: freshness + uptime
    const ageDays = n.posAt ? (Date.now() - Date.parse(n.posAt)) / 86400000 : null;
    if (ageDays != null && ageDays > 7) {
      add('warn', 'Stale position', `Last position report ${Math.round(ageDays)} days ago.`, false);
    } else if (ageDays != null) {
      add('ok', 'Position fresh', `Updated ${fmtAgo(n.posAt)}.`, false);
    }
    if (n.uptime != null) {
      add(n.uptime < 0.5 ? 'warn' : 'ok', 'Uptime',
        `Online ${Math.round(n.uptime * 100)}% of recent server samples.`, false);
    }

    const verdict = $('q-verdict');
    if (suspicion === 0) {
      verdict.className = 'link-status ok';
      verdict.textContent = 'Reported data looks trustworthy';
    } else if (suspicion <= 2) {
      verdict.className = 'link-status warn';
      verdict.textContent = 'Some reported data is suspect';
    } else {
      verdict.className = 'link-status bad';
      verdict.textContent = 'Reported data likely inaccurate';
    }

    const IC = { ok: '✓', warn: '!', bad: '✕', unk: '?' };
    $('q-name').textContent = n.name;
    $('q-checks').innerHTML = checks.map((c) =>
      `<div class="q-row"><span class="q-ic ${c.level}">${IC[c.level]}</span>
        <div><div class="q-t">${c.title}</div><div class="q-d">${c.detail}</div></div></div>`).join('');
    const panel = $('quality-panel');
    panel.classList.remove('hidden');
    panel.open = true;
  }

  // ---- point-to-point link panel --------------------------------------------

  let selectedNode = null;
  let prevSelectedNode = null;
  let nodeLinkRows = [];

  const NODE_STYLE_DEFAULT = { color: '#e6ebf2', weight: 1.5, radius: 7, dashArray: null, fillOpacity: 1 };
  const NODE_STYLE_SELECTED = { color: '#67ea94', weight: 5, radius: 13, dashArray: null, fillOpacity: 1 };
  const NODE_STYLE_PREV = { color: '#67ea94', weight: 2.5, radius: 8, dashArray: '3 4', fillOpacity: 1 };

  function styleNode(i, style) {
    if (i != null && nodeMarkers[i]) nodeMarkers[i].setStyle(style);
  }

  function clearSelection() {
    styleNode(selectedNode, NODE_STYLE_DEFAULT);
    styleNode(prevSelectedNode, NODE_STYLE_DEFAULT);
    selectedNode = null;
    prevSelectedNode = null;
    nodeLinkRows = [];
    $('node-panel-sub').textContent =
      'Select a node on the map to list every potential link and inspect terrain & Fresnel clearance.';
    $('link-list').innerHTML = '';
    $('link-list').classList.remove('has-items');
    $('link-detail').classList.add('hidden');
    $('quality-panel').classList.add('hidden');
  }

  function selectNode(i) {
    if (!lastResult) return;
    if (i !== selectedNode) {
      styleNode(prevSelectedNode, NODE_STYLE_DEFAULT);
      if (selectedNode != null) prevSelectedNode = selectedNode;
      styleNode(prevSelectedNode, NODE_STYLE_PREV);
      selectedNode = i;
    }
    styleNode(i, NODE_STYLE_SELECTED);
    if (nodeMarkers[i]) nodeMarkers[i].bringToFront();
    renderQuality(i);
    const { nodes, opts } = lastResult;
    const n = nodes[i];
    const panel = $('node-panel');
    panel.classList.remove('hidden');
    panel.open = true;
    $('link-detail').classList.add('hidden');

    const rows = [];
    for (let j = 0; j < nodes.length; j++) {
      if (j === i) continue;
      const d = Analysis.haversine(n.lat, n.lon, nodes[j].lat, nodes[j].lon);
      if (d > opts.maxRange) continue;
      const r = Analysis.los(n.lat, n.lon, n.ant ?? opts.antenna,
        nodes[j].lat, nodes[j].lon, nodes[j].ant ?? opts.antenna, opts.zoom, opts.fGHz);
      const obKey = `${Math.min(n.id, nodes[j].id)}-${Math.max(n.id, nodes[j].id)}`;
      rows.push({
        j, los: r,
        budget: Analysis.linkBudget(r, opts.fGHz, opts.envLoss || 0, opts.sens,
          n.txDbm ?? 22, (n.antGain || 0) + (nodes[j].antGain || 0)),
        ob: lastResult.obsByPair.get(obKey) || null,
      });
    }
    const order = { clear: 0, marginal: 1, blocked: 2 };
    rows.sort((a, b) => order[a.los.status] - order[b.los.status] || a.los.dist - b.los.dist);
    nodeLinkRows = rows;

    const list = $('link-list');
    if (!rows.length) {
      $('node-panel-sub').innerHTML =
        `No other nodes within ${(opts.maxRange / 1000).toFixed(0)} km of <b>${escapeHtml(n.name)}</b>.`;
      list.innerHTML = '';
      list.classList.remove('has-items');
      return;
    }
    $('node-panel-sub').innerHTML =
      `${rows.length} potential links from <b>${escapeHtml(n.name)}</b> (within ${(opts.maxRange / 1000).toFixed(0)} km):`;
    list.classList.add('has-items');
    list.innerHTML = rows.map((r, k) =>
      `<div class="link-row" data-k="${k}">
        <span class="chip ${r.los.status}"></span>
        <span class="nm">${escapeHtml(nodes[r.j].name)}</span>
        ${r.ob ? `<span class="obs-n" title="${r.ob.n} direct receptions observed, avg SNR ${r.ob.avgSnr.toFixed(1)} dB">${r.ob.n}&times;</span>` : ''}
        <span class="d">${(r.los.dist / 1000).toFixed(1)} km &middot; ${r.budget.margin >= 0 ? '+' : ''}${r.budget.margin.toFixed(0)} dB</span>
      </div>`).join('');
    list.scrollTop = 0;
    list.querySelectorAll('.link-row').forEach((row) => {
      row.addEventListener('click', () => showLinkDetail(parseInt(row.dataset.k, 10), row));
    });
    showLinkDetail(0, list.querySelector('.link-row'));
  }

  async function showLinkDetail(k, rowEl) {
    if (!lastResult || selectedNode == null) return;
    const { nodes, opts } = lastResult;
    const r = nodeLinkRows[k];
    if (!r) return;
    const a = nodes[selectedNode], b = nodes[r.j];
    $('link-list').querySelectorAll('.link-row').forEach((el) => el.classList.remove('active'));
    if (rowEl) rowEl.classList.add('active');
    await renderPairDetail(
      { name: a.name, short: a.short, lat: a.lat, lon: a.lon, ant: a.ant ?? opts.antenna, txDbm: a.txDbm, gain: a.antGain },
      { name: b.name, short: b.short, lat: b.lat, lon: b.lon, ant: b.ant ?? opts.antenna, gain: b.antGain },
      opts, r.ob);
  }

  // Shared detail renderer: works for node pairs and arbitrary map points.
  async function renderPairDetail(a, b, opts, ob = null) {
    // fetch fine-grained tiles for just this corridor (up to ~10-20 m/px) and
    // compute the link at that resolution — sharper than the area-wide pass
    const pb = {
      minLat: Math.min(a.lat, b.lat) - 0.02, maxLat: Math.max(a.lat, b.lat) + 0.02,
      minLon: Math.min(a.lon, b.lon) - 0.02, maxLon: Math.max(a.lon, b.lon) + 0.02,
    };
    const pz = Elevation.pickZoom(pb, 110, 14);
    await Elevation.prefetch(pb, pz);
    const los = Analysis.los(a.lat, a.lon, a.ant, b.lat, b.lon, b.ant, pz, opts.fGHz);
    const budget = Analysis.linkBudget(los, opts.fGHz, opts.envLoss || 0, opts.sens,
      a.txDbm ?? 22, (a.gain || 0) + (b.gain || 0));
    const prof = Analysis.profile(a.lat, a.lon, a.ant, b.lat, b.lon, b.ant, pz, opts.fGHz);
    const st = $('link-status');
    st.className = 'link-status ' +
      (budget.verdict === 'likely' ? 'ok' : budget.verdict === 'marginal' ? 'warn' : 'bad');
    st.textContent = budget.verdict === 'likely' ? 'Link likely'
      : budget.verdict === 'marginal' ? 'Link marginal'
      : 'Link unlikely (below sensitivity)';

    const fresRatio = (los.worstClearance / los.worstR1) * 100;
    const fresPct = Number.isFinite(fresRatio) ? Math.min(100, Math.max(-99, Math.round(fresRatio))) : 100;
    $('link-stats').innerHTML = [
      ['Distance', `${(los.dist / 1000).toFixed(2)} km`],
      ['Received (est)', `${budget.rx.toFixed(1)} dBm`],
      ['Margin', `${budget.margin >= 0 ? '+' : ''}${budget.margin.toFixed(1)} dB`],
      ['Line of sight', los.status === 'blocked' ? 'Blocked' : 'Clear'],
      ['Fresnel (worst)', `${fresPct}% clear`],
      ['Diffraction loss', `${budget.diff.toFixed(1)} dB`],
      ...(budget.envLoss ? [['Env. loss (calibrated)', `${budget.envLoss.toFixed(1)} dB`]] : []),
      ...(ob ? [
        ['Observed receptions', `${ob.n} (90 d)`],
        ['Observed SNR', `${ob.avgSnr.toFixed(1)} dB avg (${Math.round(ob.minSnr)}&hellip;${Math.round(ob.maxSnr)})`],
      ] : []),
    ].map(([key, v]) => `<div class="kv-row"><span class="k">${key}</span><span class="v">${v}</span></div>`).join('');

    drawProfile($('profile-canvas'), prof, los.status);
    const brg = Math.round(Analysis.bearing(a.lat, a.lon, b.lat, b.lon));
    $('profile-caption').innerHTML =
      `<span>TX: ${escapeHtml(a.short || a.name)}</span>` +
      `<span>${(los.dist / 1000).toFixed(1)} km &middot; ${brg}&deg;</span>` +
      `<span>${escapeHtml(b.short || b.name)}</span>`;
    const panel = $('node-panel');
    panel.classList.remove('hidden');
    panel.open = true;
    $('link-detail').classList.remove('hidden');
  }

  function drawProfile(canvas, prof, status) {
    const dpr = window.devicePixelRatio || 1;
    const W = canvas.clientWidth || 300, H = canvas.clientHeight || 130;
    canvas.width = W * dpr; canvas.height = H * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, W, H);
    const pts = prof.pts;
    let ymin = Infinity, ymax = -Infinity;
    for (const p of pts) {
      ymin = Math.min(ymin, p.terrain, p.ray - p.r1);
      ymax = Math.max(ymax, p.terrain, p.ray + p.r1);
    }
    const pad = (ymax - ymin) * 0.12 + 5;
    ymin -= pad; ymax += pad;
    const X = (d) => (d / prof.dist) * (W - 8) + 4;
    const Y = (h) => H - 4 - ((h - ymin) / (ymax - ymin)) * (H - 8);

    // terrain silhouette
    ctx.beginPath();
    ctx.moveTo(X(0), Y(pts[0].terrain));
    for (const p of pts) ctx.lineTo(X(p.d), Y(p.terrain));
    ctx.lineTo(X(prof.dist), H); ctx.lineTo(X(0), H); ctx.closePath();
    ctx.fillStyle = '#2b3646';
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(X(0), Y(pts[0].terrain));
    for (const p of pts) ctx.lineTo(X(p.d), Y(p.terrain));
    ctx.strokeStyle = '#49586d'; ctx.lineWidth = 1; ctx.stroke();

    const col = status === 'clear' ? '#3ddc84' : status === 'marginal' ? '#ffb347' : '#ff5f56';

    // first Fresnel zone envelope
    ctx.beginPath();
    pts.forEach((p, i) => { const x = X(p.d), y = Y(p.ray + p.r1); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    for (let i = pts.length - 1; i >= 0; i--) ctx.lineTo(X(pts[i].d), Y(pts[i].ray - pts[i].r1));
    ctx.closePath();
    ctx.fillStyle = col + '1f';
    ctx.fill();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = col + '77'; ctx.lineWidth = 1; ctx.stroke();
    ctx.setLineDash([]);

    // the ray (sags with earth curvature)
    ctx.beginPath();
    pts.forEach((p, i) => { const x = X(p.d), y = Y(p.ray); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.strokeStyle = col; ctx.lineWidth = 1.8; ctx.stroke();

    // endpoints
    ctx.fillStyle = col;
    ctx.beginPath(); ctx.arc(X(0), Y(prof.hA), 3, 0, 7); ctx.fill();
    ctx.beginPath(); ctx.arc(X(prof.dist), Y(prof.hB), 3, 0, 7); ctx.fill();
  }

  // ---- what-if node placement -----------------------------------------------

  let whatif = null; // { marker, vsOverlay }
  let placingWhatif = false;

  function removeWhatif() {
    whatifLayer.clearLayers();
    whatif = null;
    placingWhatif = false;
    map.getContainer().classList.remove('crosshair');
    $('whatif-btn').classList.remove('armed');
    $('whatif-panel').classList.add('hidden');
  }

  function placeWhatif(latlng) {
    closeEditor();
    whatifLayer.clearLayers();
    const marker = L.marker(latlng, {
      draggable: true,
      zIndexOffset: 2500,
      icon: L.divIcon({ className: '', html: '<div class="wi-pin"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }),
    }).addTo(whatifLayer);
    whatif = { marker, vsOverlay: null };
    marker.on('drag', () => {
      const p = marker.getLatLng();
      $('wi-coords').textContent = `${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`;
    });
    marker.on('dragend', () => updateWhatif());
    $('whatif-panel').classList.remove('hidden');
    updateWhatif();
  }

  async function updateWhatif() {
    if (!whatif || !lastResult) return;
    const { nodes, opts, compOf } = lastResult;
    const p = whatif.marker.getLatLng();
    const mast = parseFloat($('wi-height').value);
    $('wi-coords').textContent = `${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`;
    $('wi-stats').innerHTML = 'Computing…';
    if (whatif.vsOverlay) {
      whatifLayer.removeLayer(whatif.vsOverlay);
      whatif.vsOverlay = null;
      $('wi-viewshed').textContent = 'Coverage';
    }
    whatifLayer.eachLayer((l) => { if (l !== whatif.marker) whatifLayer.removeLayer(l); });
    await Elevation.prefetch(bboxAround(p.lat, p.lng, opts.maxRange / 1000), opts.zoom);
    if (!whatif) return;
    let clear = 0, marginal = 0;
    const comps = new Set();
    let farthest = null;
    for (let j = 0; j < nodes.length; j++) {
      const n = nodes[j];
      const d = Analysis.haversine(p.lat, p.lng, n.lat, n.lon);
      if (d > opts.maxRange) continue;
      const r = Analysis.los(p.lat, p.lng, mast, n.lat, n.lon, n.ant ?? opts.antenna, opts.zoom, opts.fGHz);
      if (r.status === 'blocked') continue;
      if (r.status === 'clear') { clear++; if (!farthest || d > farthest.d) farthest = { j, d }; }
      else marginal++;
      comps.add(compOf ? compOf[j] : 0);
      L.polyline([[p.lat, p.lng], [n.lat, n.lon]], {
        color: '#35d0e0',
        weight: r.status === 'clear' ? 2 : 1.4,
        opacity: r.status === 'clear' ? 0.8 : 0.5,
        dashArray: r.status === 'clear' ? null : '5 5',
      }).addTo(whatifLayer);
    }
    const total = clear + marginal;
    $('wi-stats').innerHTML = total === 0
      ? 'No reachable nodes from here at this mast height.'
      : `Would reach <b>${total}</b> nodes (${clear} clear, ${marginal} Fresnel-marginal)` +
        (comps.size > 1 ? `<br><b>Bridges ${comps.size} disconnected clusters</b>` : '') +
        (farthest ? `<br>Farthest clear link: ${(farthest.d / 1000).toFixed(1)} km — ${escapeHtml(nodes[farthest.j].name)}` : '');
  }

  $('wi-viewshed').addEventListener('click', async () => {
    if (!whatif || !lastResult) return;
    if (whatif.vsOverlay) {
      whatifLayer.removeLayer(whatif.vsOverlay);
      whatif.vsOverlay = null;
      $('wi-viewshed').textContent = 'Coverage';
      return;
    }
    const { opts } = lastResult;
    const p = whatif.marker.getLatLng();
    const mast = parseFloat($('wi-height').value);
    const mLat = 111320, mLon = 111320 * Math.cos((p.lat * Math.PI) / 180);
    const vb = {
      minLat: p.lat - opts.maxRange / mLat, maxLat: p.lat + opts.maxRange / mLat,
      minLon: p.lng - opts.maxRange / mLon, maxLon: p.lng + opts.maxRange / mLon,
    };
    setStatus('Computing coverage for the hypothetical node…');
    const vz = Elevation.pickZoom(vb, 110, 13);
    await Elevation.prefetch(vb, vz, (d, t) => setProgress(0.5 * (d / t)));
    // cyan to match the hypothetical-node pin
    const vs = await Analysis.viewshed(p.lat, p.lng, mast, 2,
      { ...opts, zoom: vz, vsColor: 'rgba(53, 208, 224, 0.5)' },
      (d, t) => setProgress(0.5 + 0.5 * (d / t)));
    setProgress(null);
    if (!whatif) return;
    whatif.vsOverlay = L.imageOverlay(vs.url, vs.bounds, { opacity: 1, interactive: false }).addTo(whatifLayer);
    $('wi-viewshed').textContent = 'Hide coverage';
    setStatus('Hypothetical node coverage shown (receiver at 2 m).');
  });

  $('wi-height').addEventListener('change', () => updateWhatif());
  $('wi-remove').addEventListener('click', removeWhatif);

  $('whatif-btn').addEventListener('click', () => {
    if (!lastResult) { setStatus('Run an analysis first, then place a hypothetical node.'); return; }
    clearMeasure();
    placingWhatif = true;
    $('whatif-btn').classList.add('armed');
    map.getContainer().classList.add('crosshair');
    setStatus('Click the map where you would place the new node.');
  });

  // ---- point-to-point measure tool ------------------------------------------

  let measureArmed = false;
  let measurePts = []; // markers A and B

  function clearMeasure() {
    measureLayer.clearLayers();
    measurePts = [];
    measureArmed = false;
    $('measure-btn').classList.remove('armed');
    if (!placingWhatif) map.getContainer().classList.remove('crosshair');
  }

  function measureOpts() {
    const o = lastResult ? lastResult.opts : null;
    return {
      fGHz: o?.fGHz ?? 0.915,
      envLoss: o?.envLoss ?? 0,
      sens: o?.sens ?? -134,
      antenna: parseFloat($('antenna-select').value),
    };
  }

  async function measureCompute() {
    if (measurePts.length < 2) return;
    const [A, B] = measurePts.map((m) => m.getLatLng());
    measureLayer.eachLayer((l) => { if (!measurePts.includes(l)) measureLayer.removeLayer(l); });
    L.polyline([[A.lat, A.lng], [B.lat, B.lng]], {
      color: '#35d0e0', weight: 2, dashArray: '4 5', opacity: 0.8,
    }).addTo(measureLayer);
    const o = measureOpts();
    setStatus('Measuring point-to-point link…');
    await renderPairDetail(
      { name: 'Point A', short: 'A', lat: A.lat, lon: A.lng, ant: o.antenna },
      { name: 'Point B', short: 'B', lat: B.lat, lon: B.lng, ant: o.antenna },
      o);
    setStatus(`Point-to-point: ${A.lat.toFixed(4)}, ${A.lng.toFixed(4)} ↔ ${B.lat.toFixed(4)}, ${B.lng.toFixed(4)} at ${o.antenna} m antennas. Drag A/B to refine; details in the sidebar.`);
  }

  $('measure-btn').addEventListener('click', () => {
    if (measureArmed || measurePts.length) { clearMeasure(); return; }
    placingWhatif = false;
    $('whatif-btn').classList.remove('armed');
    measureArmed = true;
    $('measure-btn').classList.add('armed');
    map.getContainer().classList.add('crosshair');
    setStatus('Click two points on the map to check the link between them. Click "Measure LOS" again to exit.');
  });

  map.on('click', (e) => {
    if (placingWhatif) {
      placingWhatif = false;
      $('whatif-btn').classList.remove('armed');
      map.getContainer().classList.remove('crosshair');
      placeWhatif(e.latlng);
      return;
    }
    if (measureArmed) {
      const label = measurePts.length === 0 ? 'A' : 'B';
      const m = L.marker(e.latlng, {
        draggable: true,
        zIndexOffset: 2500,
        icon: L.divIcon({ className: '', html: `<div class="measure-pin">${label}</div>`, iconSize: [18, 18], iconAnchor: [9, 9] }),
      }).addTo(measureLayer);
      m.on('dragend', measureCompute);
      measurePts.push(m);
      if (measurePts.length === 2) {
        measureArmed = false;
        $('measure-btn').classList.remove('armed');
        map.getContainer().classList.remove('crosshair');
        measureCompute();
      }
    }
  });

  // ---- cursor terrain readout -----------------------------------------------

  const ciBox = $('cursor-info');
  let ciRaf = null;
  let ciLast = null;
  let ciFetchTimer = null;

  // Height above average terrain: cursor elevation minus the mean of ring
  // samples 1.5–6 km out (16 azimuths x 4 distances). Positive = local high spot.
  function haatAt(lat, lon, zoom) {
    const e = Elevation.elevationAt(lat, lon, zoom);
    const mLat = 111320, mLon = 111320 * Math.cos((lat * Math.PI) / 180);
    let sum = 0, n = 0;
    for (let k = 0; k < 16; k++) {
      const az = (2 * Math.PI * k) / 16;
      for (const d of [1500, 3000, 4500, 6000]) {
        const la = lat + (Math.cos(az) * d) / mLat;
        const lo = lon + (Math.sin(az) * d) / mLon;
        if (!Elevation.tileCached(la, lo, zoom)) continue;
        sum += Elevation.elevationAt(la, lo, zoom);
        n++;
      }
    }
    return n >= 24 ? e - sum / n : null; // demand decent ring coverage
  }

  let ciLastRun = 0;

  function refreshCursorInfo() {
    ciRaf = null;
    if (!ciLast) return;
    const { lat, lng } = ciLast;
    $('ci-coords').textContent = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
    const zoom = lastResult ? lastResult.opts.zoom : 12;
    if (Elevation.tileCached(lat, lng, zoom)) {
      $('ci-asl').textContent = `${Math.round(Elevation.elevationAt(lat, lng, zoom))} m`;
      const h = haatAt(lat, lng, zoom);
      $('ci-haat').textContent = h != null ? `${h >= 0 ? '+' : ''}${Math.round(h)} m` : '—';
    } else {
      $('ci-asl').textContent = '—';
      $('ci-haat').textContent = '—';
      // hovering outside loaded terrain: fetch that tile after a short pause
      clearTimeout(ciFetchTimer);
      ciFetchTimer = setTimeout(async () => {
        await Elevation.ensureTile(lat, lng, zoom);
        refreshCursorInfo();
      }, 250);
    }
  }

  map.on('mousemove', (e) => {
    ciBox.classList.remove('hidden');
    ciLast = e.latlng;
    // synchronous with a light throttle (the lookup is microseconds); a
    // trailing rAF catches the final resting position
    const now = performance.now();
    if (now - ciLastRun > 40) {
      ciLastRun = now;
      refreshCursorInfo();
    } else if (!ciRaf) {
      ciRaf = requestAnimationFrame(refreshCursorInfo);
    }
  });
  map.on('mouseout', () => ciBox.classList.add('hidden'));

  // ---- events ---------------------------------------------------------------

  const resultsEl = $('search-results');

  $('search-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = $('search-input').value.trim();
    if (!q) return;
    resultsEl.classList.add('hidden');
    setStatus('Searching…');
    try {
      const hits = await geocode(q);
      if (hits.length === 0) { setStatus('No matches — try a different query.'); return; }
      if (hits.length === 1) { startAt(hits[0]); return; }
      resultsEl.innerHTML = '';
      hits.forEach((h) => {
        const d = document.createElement('div');
        d.textContent = h.label;
        d.addEventListener('click', () => { resultsEl.classList.add('hidden'); startAt(h); });
        resultsEl.appendChild(d);
      });
      resultsEl.classList.remove('hidden');
      setStatus('Select a match.');
    } catch (err) {
      setStatus(`Search failed: ${err.message}`);
    }
  });

  function startAt(hit, viewZoom) {
    const radiusKm = parseFloat($('radius-select').value);
    const bbox = bboxAround(hit.lat, hit.lon, radiusKm);
    // viewZoom: start closer in on the center instead of fitting the whole
    // analysis bbox (the analysis still covers the full radius)
    if (viewZoom) map.setView([hit.lat, hit.lon], viewZoom);
    else map.fitBounds([[bbox.minLat, bbox.minLon], [bbox.maxLat, bbox.maxLon]]);
    // shareable permalink: #lat,lon,radiusKm
    try {
      history.replaceState(null, '', `#${hit.lat.toFixed(5)},${hit.lon.toFixed(5)},${radiusKm}`);
    } catch {}
    runAnalysis(bbox, hit.label.split(',')[0], !!viewZoom);
  }

  function parseHash() {
    const m = location.hash.match(/^#(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)(?:,(\d+(?:\.\d+)?))?$/);
    if (!m) return null;
    const lat = parseFloat(m[1]), lon = parseFloat(m[2]);
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
    return { lat, lon, radius: m[3] ? parseFloat(m[3]) : null };
  }

  $('analyze-view-btn').addEventListener('click', () => {
    const b = map.getBounds();
    const bbox = {
      minLat: b.getSouth(), maxLat: b.getNorth(),
      minLon: b.getWest(), maxLon: b.getEast(),
    };
    const spanKm = Analysis.haversine(bbox.minLat, bbox.minLon, bbox.maxLat, bbox.minLon) / 1000;
    if (spanKm > 250) { setStatus('Zoom in first — analysis view is limited to ~250 km.'); return; }
    runAnalysis(bbox, 'Current view');
  });

  // ---- startup: permalink hash > local mesh (auto) > server DEFAULT_LOCATION > Sioux Falls fallback

  async function fetchConfig() {
    try { return await (await fetch('/api/config')).json(); } catch { return { nodeSource: 'public', defaultLocation: null }; }
  }

  async function fetchLocalBounds() {
    try {
      const r = await fetch('/api/bounds');
      return r.ok ? await r.json() : null;
    } catch { return null; }
  }

  // A single node (or several tightly clustered ones) gives a zero/near-zero
  // area bbox — pad it out to something a human can actually see, with a
  // floor so it never collapses to a dot.
  function boundsToBbox(b) {
    const spanKm = Math.max(
      Analysis.haversine(b.minLat, b.minLon, b.maxLat, b.minLon) / 1000,
      Analysis.haversine(b.minLat, b.minLon, b.minLat, b.maxLon) / 1000,
    );
    const radiusKm = Math.max((spanKm / 2) * 1.3, 3);
    return bboxAround(b.centerLat, b.centerLon, radiusKm);
  }

  async function goToLocalBounds(b) {
    const bbox = boundsToBbox(b);
    map.fitBounds([[bbox.minLat, bbox.minLon], [bbox.maxLat, bbox.maxLon]]);
    runAnalysis(bbox, 'Local mesh');
  }

  async function startLocalMesh(cfg) {
    const bounds = await fetchLocalBounds();
    if (bounds && bounds.available) { await goToLocalBounds(bounds); return; }

    // No positioned nodes yet (TCP connection/NodeDB dump still in
    // progress) — park somewhere sensible while we wait rather than
    // showing a blank world map.
    if (cfg.defaultLocation) {
      try {
        const hits = await geocode(cfg.defaultLocation);
        if (hits.length) startAt(hits[0], 11);
        else setStatus('Waiting for local node data…');
      } catch { setStatus('Waiting for local node data…'); }
    } else {
      setStatus('Waiting for local node data…');
    }

    // Poll until the local mesh reports positioned nodes, then snap the
    // view to it automatically — no page reload needed.
    let tries = 0;
    const timer = setInterval(async () => {
      if (++tries > 40) { clearInterval(timer); return; } // ~2.5 min ceiling
      const b = await fetchLocalBounds();
      if (b && b.available) { clearInterval(timer); await goToLocalBounds(b); }
    }, 4000);
  }

  (async () => {
    await migrateLegacyOverrides();
    await refreshOverrides();
    const h = parseHash();
    if (h) {
      if (h.radius && [...$('radius-select').options].some((o) => +o.value === h.radius)) {
        $('radius-select').value = String(h.radius);
      }
      startAt({ lat: h.lat, lon: h.lon, label: `${h.lat.toFixed(4)}, ${h.lon.toFixed(4)}` });
      return;
    }

    const cfg = await fetchConfig();
    currentNodeSource = cfg.nodeSource;
    if (cfg.nodeSource === 'local-tcp') { await startLocalMesh(cfg); return; }

    if (cfg.defaultLocation) {
      try {
        const hits = await geocode(cfg.defaultLocation);
        if (hits.length) { startAt(hits[0], 12); return; }
      } catch { /* fall through to hardcoded default */ }
    }
    startAt({ lat: 43.53569, lon: -96.69025, label: 'Sioux Falls (57103)' }, 12);
  })();
})();
