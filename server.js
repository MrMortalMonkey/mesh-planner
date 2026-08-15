// Mesh Planner — local/VPS server
// - Serves the static frontend
// - Proxies/caches the Meshtastic node databases (bbox filtering server-side)
// - Stores node corrections (height/position) with full edit history
// - Caches terrain tiles on disk and geocoding results (rate-limited) so a
//   deployment is polite to the upstream public services
//
// Run:  node server.js   then open http://localhost:8620
// Requires Node 18+ (built-in fetch). No npm dependencies.
// Env: PORT (default 8620), DATA_DIR (default ./data)

const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const MqttLive = require('./mqtt-live');
const LinkStore = require('./linkstore');

const PORT = process.env.PORT || 8620;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const TILE_DIR = path.join(DATA_DIR, 'tiles');
const UPSTREAM = 'https://meshtastic.liamcottle.net/api/v1/nodes';
const UPSTREAM_MESHMAP = 'https://meshmap.net/nodes.json'; // official-broker aggregate, fills regional gaps
const UPSTREAM_TILES = (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
const UPSTREAM_GEOCODE = 'https://nominatim.openstreetmap.org/search';
const CACHE_TTL_MS = 5 * 60 * 1000; // refetch node DBs at most every 5 min
const GEO_TTL_MS = 30 * 24 * 3600 * 1000;
const UA = 'MeshPlanner/1.0 (self-hosted mesh analysis; github-less personal deployment)';

// NODE_SOURCE=public (default) keeps the original liamcottle/meshmap.net
// blend. NODE_SOURCE=local-tcp replaces it entirely with a live pull from a
// local Meshtastic device/virtual node's TCP Stream API (LOCAL_NODE_HOST,
// LOCAL_NODE_PORT — see localnode-tcp.js) — no public service contacted for
// node data at all.
const NODE_SOURCE = (process.env.NODE_SOURCE || 'public').trim();
const LocalNodeTcp = NODE_SOURCE === 'local-tcp' ? require('./localnode-tcp') : null;
// The local NodeDB is already live in memory (reading it is an O(1) Map
// filter), so there's no reason to hold a stale cache the way the public
// HTTP fetch needs to be polite about. TTL 0 means every /api/nodes call
// re-reads current state instead of risking a snapshot from before the TCP
// handshake finished.
const NODE_CACHE_TTL_MS = LocalNodeTcp ? 0 : CACHE_TTL_MS;

fs.mkdirSync(TILE_DIR, { recursive: true });

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// ---- helpers ----------------------------------------------------------------

function sendJson(req, res, obj, status = 200) {
  const body = Buffer.from(JSON.stringify(obj));
  const headers = { 'Content-Type': 'application/json; charset=utf-8' };
  if ((req.headers['accept-encoding'] || '').includes('gzip') && body.length > 1024) {
    headers['Content-Encoding'] = 'gzip';
    const gz = zlib.gzipSync(body);
    res.writeHead(status, headers);
    return res.end(gz);
  }
  res.writeHead(status, headers);
  res.end(body);
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// ---- upstream node cache ----------------------------------------------------

let cache = { at: 0, nodes: null };
let inflight = null;

function slimNode(n) {
  return {
    id: Number(n.node_id),
    hex: n.node_id_hex,
    name: n.long_name || n.node_id_hex,
    short: n.short_name || '',
    role: n.role,
    roleName: n.role_name || 'CLIENT',
    lat: n.latitude / 1e7,
    lon: n.longitude / 1e7,
    alt: n.altitude,
    prec: n.position_precision ?? null,
    hw: n.hardware_model_name,
    fw: n.firmware_version,
    region: n.region_name,
    preset: n.modem_preset_name,
    util: n.channel_utilization != null ? parseFloat(n.channel_utilization) : null,
    airTx: n.air_util_tx != null ? parseFloat(n.air_util_tx) : null,
    battery: n.battery_level,
    neighbours: Array.isArray(n.neighbours)
      ? n.neighbours.map((nb) => ({ id: nb.node_id, snr: nb.snr }))
      : null,
    posAt: n.position_updated_at,
    updAt: n.updated_at,
    src: 'liamcottle',
  };
}

function slimMeshmapNode(id, n) {
  const lastSeen = n.seenBy ? Math.max(...Object.values(n.seenBy)) : null;
  const iso = lastSeen ? new Date(lastSeen * 1000).toISOString() : null;
  const num = Number(id);
  return {
    id: num,
    hex: '!' + (num >>> 0).toString(16).padStart(8, '0'),
    name: n.longName || id,
    short: n.shortName || '',
    role: null,
    roleName: n.role || 'CLIENT',
    lat: n.latitude / 1e7,
    lon: n.longitude / 1e7,
    alt: n.altitude ?? null,
    prec: n.precision ?? null,
    hw: n.hwModel || null,
    fw: null,
    region: null,
    preset: null,
    util: n.chUtil ?? null,
    airTx: n.airUtilTx ?? null,
    battery: n.batteryLevel ?? null,
    neighbours: null,
    posAt: iso,
    updAt: iso,
    src: 'meshmap',
  };
}

async function fetchUpstream() {
  if (LocalNodeTcp) {
    const nodes = LocalNodeTcp.getNodes();
    cache = { at: Date.now(), nodes };
    const st = LocalNodeTcp.stats();
    console.log(`[nodes] local TCP NodeDB: ${nodes.length} positioned ` +
      `(${st.nodeCount} known, connected=${st.connected}, configComplete=${st.configComplete})`);
    sampleReliability(nodes);
    return nodes;
  }

  console.log('[nodes] fetching upstream node databases...');
  const t0 = Date.now();
  const headers = { 'User-Agent': UA };

  const [liam, meshmap] = await Promise.allSettled([
    fetch(UPSTREAM, { headers }).then((r) => {
      if (!r.ok) throw new Error(`liamcottle HTTP ${r.status}`);
      return r.json();
    }),
    fetch(UPSTREAM_MESHMAP, { headers }).then((r) => {
      if (!r.ok) throw new Error(`meshmap HTTP ${r.status}`);
      return r.json();
    }),
  ]);

  const byId = new Map();
  if (meshmap.status === 'fulfilled') {
    for (const [id, n] of Object.entries(meshmap.value)) {
      if (n.latitude == null || n.longitude == null) continue;
      if (n.latitude === 0 && n.longitude === 0) continue;
      byId.set(Number(id), slimMeshmapNode(id, n));
    }
  } else {
    console.warn('[nodes] meshmap fetch failed:', meshmap.reason?.message);
  }
  if (liam.status === 'fulfilled') {
    // liamcottle records are richer (neighbours, region, firmware) — they win.
    for (const n of liam.value.nodes || []) {
      if (n.latitude == null || n.longitude == null) continue;
      if (n.latitude === 0 && n.longitude === 0) continue;
      byId.set(Number(n.node_id), slimNode(n));
    }
  } else {
    console.warn('[nodes] liamcottle fetch failed:', liam.reason?.message);
  }
  if (byId.size === 0) throw new Error('both upstream node sources failed');

  const nodes = [...byId.values()];
  cache = { at: Date.now(), nodes };
  console.log(`[nodes] cached ${nodes.length} positioned nodes ` +
    `(liamcottle ${liam.status}, meshmap ${meshmap.status}) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  sampleReliability(nodes);
  return nodes;
}

// ---- node reliability sampling ----------------------------------------------
// Every upstream refresh, record whether each node looked "alive" (updated in
// the last 15 min). Over days this yields an uptime fraction used to temper
// ROUTER-role suggestions ("great spot, but it's only up 40% of the time").

const REL_FILE = path.join(DATA_DIR, 'reliability.json');
let reliability = {};
try { reliability = JSON.parse(fs.readFileSync(REL_FILE, 'utf8')); } catch { reliability = {}; }
let lastRelSample = 0;

function haversineM(lat1, lon1, lat2, lon2) {
  const toR = Math.PI / 180;
  const dLat = (lat2 - lat1) * toR, dLon = (lon2 - lon1) * toR;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toR) * Math.cos(lat2 * toR) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(a));
}

function sampleReliability(nodes) {
  const now = Date.now();
  if (now - lastRelSample < 4 * 60 * 1000) return; // one sample per refresh cycle
  lastRelSample = now;
  for (const n of nodes) {
    const up = n.updAt && now - Date.parse(n.updAt) < 15 * 60 * 1000;
    const r = reliability[n.id] || (reliability[n.id] = { s: 0, u: 0 });
    r.s++;
    if (up) r.u++;
    // movement tracking: nodes that hop >500 m between samples are mobile —
    // their stale broadcast positions poison model calibration
    if (r.lat != null && haversineM(r.lat, r.lon, n.lat, n.lon) > 500) {
      r.mv = (r.mv || 0) + 1;
    }
    r.lat = n.lat;
    r.lon = n.lon;
  }
  try {
    const tmp = REL_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(reliability));
    fs.renameSync(tmp, REL_FILE);
  } catch (e) { console.warn('[reliability] save failed:', e.message); }
}

async function getNodes() {
  if (cache.nodes && Date.now() - cache.at < NODE_CACHE_TTL_MS) return cache.nodes;
  if (!inflight) inflight = fetchUpstream().finally(() => { inflight = null; });
  try {
    return await inflight;
  } catch (e) {
    if (cache.nodes) {
      console.warn('[nodes] upstream refresh failed, serving stale cache:', e.message);
      return cache.nodes;
    }
    throw e;
  }
}

// Blend the aggregate databases with the live MQTT map-report feed: live data
// freshens position/role/preset for known nodes and adds nodes the aggregate
// databases haven't picked up yet.
function mergeLive(baseNodes) {
  const live = MqttLive.getLive();
  if (live.size === 0) return baseNodes;
  const now = Date.now();
  const seen = new Set();
  const out = baseNodes.map((n) => {
    const ln = live.get(n.id);
    if (!ln || now - ln.at > MqttLive.LIVE_TTL_MS) return n;
    seen.add(n.id);
    if (n.posAt && Date.parse(n.posAt) >= ln.at) return n; // aggregate is fresher
    return {
      ...n,
      lat: ln.lat, lon: ln.lon,
      alt: ln.alt ?? n.alt,
      prec: ln.prec ?? n.prec,
      roleName: ln.roleName ?? n.roleName,
      preset: ln.preset ?? n.preset,
      region: ln.region ?? n.region,
      fw: ln.fw ?? n.fw,
      posAt: new Date(ln.at).toISOString(),
      updAt: new Date(ln.at).toISOString(),
      src: n.src + '+live',
    };
  });
  for (const [id, ln] of live) {
    if (seen.has(id) || now - ln.at > MqttLive.LIVE_TTL_MS) continue;
    const iso = new Date(ln.at).toISOString();
    out.push({
      id,
      hex: '!' + (id >>> 0).toString(16).padStart(8, '0'),
      name: ln.name || '!' + (id >>> 0).toString(16).padStart(8, '0'),
      short: ln.short || '',
      role: null,
      roleName: ln.roleName || 'CLIENT',
      lat: ln.lat, lon: ln.lon, alt: ln.alt, prec: ln.prec ?? null,
      hw: null, fw: ln.fw, region: ln.region, preset: ln.preset,
      util: null, airTx: null, battery: null, neighbours: null,
      posAt: iso, updAt: iso,
      src: 'mqtt-live',
    });
  }
  return out;
}

async function handleApiNodes(req, res, url) {
  const q = url.searchParams;
  const minLat = parseFloat(q.get('minLat'));
  const maxLat = parseFloat(q.get('maxLat'));
  const minLon = parseFloat(q.get('minLon'));
  const maxLon = parseFloat(q.get('maxLon'));
  const maxAgeDays = parseFloat(q.get('maxAgeDays') || '30');

  if ([minLat, maxLat, minLon, maxLon].some(Number.isNaN)) {
    return sendJson(req, res, { error: 'minLat, maxLat, minLon, maxLon are required' }, 400);
  }

  const all = mergeLive(await getNodes());
  const cutoff = Date.now() - maxAgeDays * 86400_000;
  const out = all
    .filter((n) =>
      n.lat >= minLat && n.lat <= maxLat &&
      n.lon >= minLon && n.lon <= maxLon &&
      (!n.posAt || Date.parse(n.posAt) >= cutoff))
    .map((n) => {
      const r = reliability[n.id];
      if (!r) return n;
      const out = { ...n };
      out.relSamples = r.s;
      // require half a day of samples before claiming an uptime figure
      if (r.s >= 12) out.uptime = r.u / r.s;
      // moved >500 m in over 20% of samples -> treat as a mobile node
      if (r.s >= 5 && (r.mv || 0) / r.s > 0.2) out.mobile = true;
      return out;
    });
  sendJson(req, res, { fetchedAt: cache.at, total: all.length, nodes: out });
}

// ---- corrections store (synced overrides + history) -------------------------

const OV_FILE = path.join(DATA_DIR, 'overrides.json');
const HIST_FILE = path.join(DATA_DIR, 'history.jsonl');
let overrides = {};
try { overrides = JSON.parse(fs.readFileSync(OV_FILE, 'utf8')); } catch { overrides = {}; }

function saveOverridesFile() {
  const tmp = OV_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(overrides, null, 1));
  fs.renameSync(tmp, OV_FILE);
}

function appendHistory(entry) {
  fs.appendFileSync(HIST_FILE, JSON.stringify(entry) + '\n');
}

function readHistory(id, limit = 20) {
  let lines = [];
  try { lines = fs.readFileSync(HIST_FILE, 'utf8').split('\n').filter(Boolean); } catch {}
  const out = [];
  for (let k = lines.length - 1; k >= 0 && out.length < limit; k--) {
    try {
      const e = JSON.parse(lines[k]);
      if (String(e.id) === String(id)) out.push(e);
    } catch {}
  }
  return out;
}

function validOverride(o) {
  const out = {};
  if (o.alt != null) {
    const alt = Number(o.alt);
    if (!Number.isFinite(alt) || alt < -500 || alt > 9000) return null;
    out.alt = alt;
  }
  if (o.lat != null || o.lon != null) {
    const lat = Number(o.lat), lon = Number(o.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) ||
      Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
    out.lat = lat; out.lon = lon;
  }
  if (o.mobile === true) out.mobile = true; // community "this node moves" flag
  if (o.txp != null) {
    const txp = Number(o.txp);
    if (!Number.isFinite(txp) || txp < 1 || txp > 40) return null;
    out.txp = txp;
  }
  if (o.gain != null) {
    const gain = Number(o.gain);
    if (!Number.isFinite(gain) || gain < -10 || gain > 20) return null;
    out.gain = gain;
  }
  return Object.keys(out).length ? out : null;
}

// Write rate limiting: corrections are open-edit (wiki-style), so bound the
// damage a spammer can do. Per-IP and global sliding windows.
const writeLog = new Map(); // key -> [timestamps]

function allowWrite(key, limit, windowMs) {
  const now = Date.now();
  let arr = writeLog.get(key);
  if (!arr) { arr = []; writeLog.set(key, arr); }
  while (arr.length && arr[0] < now - windowMs) arr.shift();
  if (arr.length >= limit) return false;
  arr.push(now);
  return true;
}

function clientIp(req) {
  return req.headers['cf-connecting-ip'] ||
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket.remoteAddress || 'unknown';
}

async function handleOverrides(req, res, url) {
  if (url.pathname === '/api/overrides' && req.method === 'GET') {
    return sendJson(req, res, overrides);
  }
  const m = url.pathname.match(/^\/api\/overrides\/(\d+)(\/history)?$/);
  if (!m) return sendJson(req, res, { error: 'not found' }, 404);
  const id = m[1];

  if (req.method === 'PUT' || req.method === 'DELETE') {
    const ip = clientIp(req);
    if (!allowWrite('ip:' + ip, 10, 60_000) || !allowWrite('global', 60, 60_000)) {
      return sendJson(req, res, { error: 'too many corrections — wait a minute and try again' }, 429);
    }
  }

  if (m[2] && req.method === 'GET') {
    return sendJson(req, res, { history: readHistory(id) });
  }
  if (req.method === 'PUT') {
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return sendJson(req, res, { error: 'bad JSON' }, 400); }
    const clean = validOverride(body || {});
    if (!clean) return sendJson(req, res, { error: 'override must contain valid alt, lat+lon, mobile, txp (1-40 dBm), and/or gain (-10..20 dBi)' }, 400);
    clean.updatedAt = new Date().toISOString();
    overrides[id] = clean;
    saveOverridesFile();
    appendHistory({ id: Number(id), action: 'set', ...clean, at: clean.updatedAt });
    return sendJson(req, res, { ok: true, override: clean });
  }
  if (req.method === 'DELETE') {
    if (overrides[id]) {
      delete overrides[id];
      saveOverridesFile();
      appendHistory({ id: Number(id), action: 'clear', at: new Date().toISOString() });
    }
    return sendJson(req, res, { ok: true });
  }
  return sendJson(req, res, { error: 'method not allowed' }, 405);
}

// ---- geocode proxy (cached + rate-limited, per Nominatim policy) ------------

const GEO_FILE = path.join(DATA_DIR, 'geocode-cache.json');
let geoCache = {};
try { geoCache = JSON.parse(fs.readFileSync(GEO_FILE, 'utf8')); } catch { geoCache = {}; }
let geoChain = Promise.resolve();
let lastGeoAt = 0;

function saveGeoCache() {
  try {
    const keys = Object.keys(geoCache);
    if (keys.length > 2000) for (const k of keys.slice(0, keys.length - 2000)) delete geoCache[k];
    fs.writeFileSync(GEO_FILE, JSON.stringify(geoCache));
  } catch (e) { console.warn('[geocode] cache save failed:', e.message); }
}

async function handleGeocode(req, res, url) {
  const q = (url.searchParams.get('q') || '').trim();
  if (!q || q.length > 200) return sendJson(req, res, { error: 'q required' }, 400);
  const key = q.toLowerCase();
  const hit = geoCache[key];
  if (hit && Date.now() - hit.at < GEO_TTL_MS) {
    return sendJson(req, res, { results: hit.results, cached: true });
  }
  // serialize upstream calls and keep >= 1.1 s between them
  const work = geoChain.then(async () => {
    const wait = lastGeoAt + 1100 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastGeoAt = Date.now();
    const gu = `${UPSTREAM_GEOCODE}?format=jsonv2&limit=5&q=${encodeURIComponent(q)}`;
    const r = await fetch(gu, { headers: { 'User-Agent': UA, 'Accept-Language': 'en' } });
    if (!r.ok) throw new Error(`nominatim HTTP ${r.status}`);
    const data = await r.json();
    return data.map((x) => ({ lat: parseFloat(x.lat), lon: parseFloat(x.lon), label: x.display_name }));
  });
  geoChain = work.catch(() => {});
  try {
    const results = await work;
    geoCache[key] = { at: Date.now(), results };
    saveGeoCache();
    sendJson(req, res, { results });
  } catch (e) {
    sendJson(req, res, { error: e.message }, 502);
  }
}

// ---- terrain tile proxy with disk cache -------------------------------------

const tileInflight = new Map();

async function handleTile(req, res, z, x, y) {
  z = parseInt(z, 10); x = parseInt(x, 10); y = parseInt(y, 10);
  const max = 2 ** z;
  if (!Number.isInteger(z) || z < 0 || z > 15 ||
    !Number.isInteger(x) || x < 0 || x >= max ||
    !Number.isInteger(y) || y < 0 || y >= max) {
    res.writeHead(400); return res.end('bad tile');
  }
  const file = path.join(TILE_DIR, String(z), `${x}_${y}.png`);
  const headers = { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=2592000, immutable' };
  try {
    const buf = fs.readFileSync(file);
    res.writeHead(200, headers);
    return res.end(buf);
  } catch {}

  const key = `${z}/${x}/${y}`;
  if (!tileInflight.has(key)) {
    tileInflight.set(key, (async () => {
      const r = await fetch(UPSTREAM_TILES(z, x, y), { headers: { 'User-Agent': UA } });
      if (!r.ok) throw new Error(`tile HTTP ${r.status}`);
      const buf = Buffer.from(await r.arrayBuffer());
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, buf);
      return buf;
    })().finally(() => tileInflight.delete(key)));
  }
  try {
    const buf = await tileInflight.get(key);
    res.writeHead(200, headers);
    res.end(buf);
  } catch (e) {
    res.writeHead(502); res.end('tile fetch failed');
  }
}

// ---- static files -----------------------------------------------------------

function serveStatic(req, res, url) {
  let p = url.pathname === '/' ? '/index.html' : url.pathname;
  const file = path.join(PUBLIC_DIR, path.normalize(p).replace(/^([.][.][\\/])+/, ''));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    const ext = path.extname(file);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
    });
    res.end(buf);
  });
}

// ---- router -----------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname === '/api/nodes') return await handleApiNodes(req, res, url);
    if (url.pathname.startsWith('/api/overrides')) return await handleOverrides(req, res, url);
    if (url.pathname === '/api/geocode') return await handleGeocode(req, res, url);
    if (url.pathname === '/api/linkobs' && req.method === 'POST') {
      let body;
      try { body = JSON.parse(await readBody(req, 32 * 1024)); } catch { return sendJson(req, res, { error: 'bad JSON' }, 400); }
      if (!Array.isArray(body?.ids)) return sendJson(req, res, { error: 'ids array required' }, 400);
      return sendJson(req, res, { obs: LinkStore.query(body.ids) });
    }
    const tm = url.pathname.match(/^\/tiles\/(\d+)\/(\d+)\/(\d+)\.png$/);
    if (tm) return await handleTile(req, res, tm[1], tm[2], tm[3]);
    if (url.pathname === '/api/health') {
      return sendJson(req, res, {
        ok: true,
        nodeSource: NODE_SOURCE,
        cachedNodes: cache.nodes ? cache.nodes.length : 0,
        cacheAge: cache.at ? Date.now() - cache.at : null,
        overrides: Object.keys(overrides).length,
        mqtt: MqttLive.stats(),
        linkObs: LinkStore.stats(),
        ...(LocalNodeTcp ? { localNode: LocalNodeTcp.stats() } : {}),
      });
    }
    return serveStatic(req, res, url);
  } catch (e) {
    console.error('[server]', e);
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
  }
});

server.listen(PORT, () => {
  console.log(`Mesh Planner running at http://localhost:${PORT}`);
  console.log(`Data dir: ${DATA_DIR} (${Object.keys(overrides).length} overrides)`);
  console.log(`Node source: ${NODE_SOURCE}` +
    (LocalNodeTcp ? ` (${process.env.LOCAL_NODE_HOST || '127.0.0.1'}:${process.env.LOCAL_NODE_PORT || 4403})` : ''));
  if (LocalNodeTcp) LocalNodeTcp.start();
  getNodes().catch((e) => console.warn('[nodes] warmup failed:', e.message));
  const obsEnabled = LinkStore.init(DATA_DIR);
  MqttLive.start(obsEnabled ? { onLinkObs: LinkStore.add } : {});
});

// flush buffered link observations on service restart/stop
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    try { LinkStore.flush(); } catch {}
    try { if (LocalNodeTcp) LocalNodeTcp.stop(); } catch {}
    process.exit(0);
  });
}
