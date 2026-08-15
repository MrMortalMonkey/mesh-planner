// localnode-tcp.js — full local NodeDB pulled directly from a Meshtastic
// device's TCP Stream API: a physically-attached node bridged onto the
// network, or a "virtual" node (e.g. meshtasticd running headless on Linux
// with a LoRa radio attached) exposing the same interface. No public
// aggregator involved at all.
//
// Protocol (meshtastic.org/docs/development/device/client-api/#tcp-api):
//   framing: [0x94, 0xc3, lenHi, lenLo, <ToRadio|FromRadio protobuf bytes>]
// On connect we send ToRadio{want_config_id = <nonce>} (mesh.proto field 3).
// The node replies with MyNodeInfo, then one FromRadio.node_info per node in
// its on-device NodeDB (this *is* the mesh's positioned-node set — no
// separate "fetch" step), then config_complete_id. After that, live
// position/user/telemetry reports keep arriving as decoded MeshPacket app
// payloads (POSITION_APP / NODEINFO_APP / TELEMETRY_APP), so the in-memory
// map stays current without polling. Field numbers below are taken directly
// from meshtastic/protobufs (mesh.proto, telemetry.proto, portnums.proto),
// not guessed.
//
// Zero npm dependencies, same philosophy as mqtt-live.js — shares its
// wire-format reader (protolite.js) rather than pulling in a protobuf lib.

const net = require('net');
const { pbFields, field, vNum, vInt32, sfixed32, encodeVarintField } = require('./protolite');

const HOST = process.env.LOCAL_NODE_HOST || '127.0.0.1';
const PORT = parseInt(process.env.LOCAL_NODE_PORT || '4403', 10);
const START1 = 0x94, START2 = 0xc3;
// Periodic full re-request. The live incremental updates below keep things
// fresh in normal operation; this just guards against drift after a device
// reboot or NodeDB prune that we didn't otherwise notice.
const RESYNC_MS = 15 * 60 * 1000;

// Config.DeviceConfig.Role enum (config.proto) — same ordinal list the
// public MQTT feed uses.
const ROLE_NAMES = ['CLIENT', 'CLIENT_MUTE', 'ROUTER', 'ROUTER_CLIENT', 'REPEATER',
  'TRACKER', 'SENSOR', 'TAK', 'CLIENT_HIDDEN', 'LOST_AND_FOUND', 'TAK_TRACKER',
  'ROUTER_LATE', 'CLIENT_BASE'];

// portnums.proto
const PORTNUM_POSITION = 3, PORTNUM_NODEINFO = 4, PORTNUM_TELEMETRY = 67;

const state = {
  sock: null,
  buf: Buffer.alloc(0),
  connected: false,
  configComplete: false,
  myNodeNum: null,
  nodes: new Map(), // num -> node record, same shape server.js's slimNode() produces
  decoded: 0,
  malformed: 0,
  lastMsgAt: null,
  reconnectMs: 3000,
  stopped: false,
};

let resyncTimer = null;

function log(...args) { console.log('[localnode]', ...args); }

function hex8(num) { return '!' + (num >>> 0).toString(16).padStart(8, '0'); }

function upsert(num, patch) {
  const prev = state.nodes.get(num) || {
    id: num, hex: hex8(num), name: hex8(num), short: '', role: null,
    roleName: 'CLIENT', lat: null, lon: null, alt: null, prec: null,
    hw: null, fw: null, region: null, preset: null, util: null, airTx: null,
    battery: null, neighbours: null, posAt: null, updAt: null, src: 'local-tcp',
  };
  const next = { ...prev, ...patch };
  next.updAt = new Date().toISOString();
  if (patch.lat != null || patch.lon != null) next.posAt = next.updAt;
  state.nodes.set(num, next);
}

// ---- payload parsers (subset of mesh.proto / telemetry.proto we need) ------

function parseUser(buf) {
  const fs = pbFields(buf);
  const str = (f) => { const x = field(fs, f); return x && x.wt === 2 ? x.v.toString('utf8') : null; };
  const num = (f) => { const x = field(fs, f); return x && x.wt === 0 ? vNum(x.v) : null; };
  return { id: str(1), longName: str(2), shortName: str(3), hwModel: num(5), role: num(7) };
}

function parsePosition(buf) {
  const fs = pbFields(buf);
  const sf32 = (f) => { const x = field(fs, f); return x && x.wt === 5 ? sfixed32(x.v) : null; };
  const num = (f) => { const x = field(fs, f); return x && x.wt === 0 ? vInt32(x.v) : null; };
  return { lat: sf32(1), lon: sf32(2), alt: num(3), prec: num(23) };
}

function parseDeviceMetrics(buf) {
  const fs = pbFields(buf);
  const num = (f) => { const x = field(fs, f); return x && x.wt === 0 ? vNum(x.v) : null; };
  const flt = (f) => { const x = field(fs, f); return x && x.wt === 5 ? x.v.readFloatLE(0) : null; };
  return { battery: num(1), voltage: flt(2), util: flt(3), airTx: flt(4) };
}

// FromRadio.node_info (mesh.proto NodeInfo): num=1, user=2, position=3,
// snr=4, last_heard=5, device_metrics=6, hops_away=9. One of these arrives
// per node during the initial config dump.
function parseNodeInfo(buf) {
  const fs = pbFields(buf);
  const numF = field(fs, 1);
  if (!numF || numF.wt !== 0) return;
  const num = vNum(numF.v);
  const patch = {};

  const userF = field(fs, 2);
  if (userF && userF.wt === 2) {
    const u = parseUser(userF.v);
    if (u.id) patch.hex = u.id;
    if (u.longName) patch.name = u.longName;
    if (u.shortName != null) patch.short = u.shortName;
    if (u.role != null) { patch.role = u.role; patch.roleName = ROLE_NAMES[u.role] || 'CLIENT'; }
  }

  const posF = field(fs, 3);
  if (posF && posF.wt === 2) {
    const p = parsePosition(posF.v);
    if (p.lat != null && p.lon != null && !(p.lat === 0 && p.lon === 0)) {
      patch.lat = p.lat / 1e7; patch.lon = p.lon / 1e7;
    }
    if (p.alt != null) patch.alt = p.alt;
    if (p.prec != null) patch.prec = p.prec;
  }

  const dmF = field(fs, 6);
  if (dmF && dmF.wt === 2) {
    const d = parseDeviceMetrics(dmF.v);
    if (d.battery != null) patch.battery = d.battery;
    if (d.util != null) patch.util = d.util;
    if (d.airTx != null) patch.airTx = d.airTx;
  }

  const hopsF = field(fs, 9);
  if (hopsF && hopsF.wt === 0) patch.hopsAway = vNum(hopsF.v);

  upsert(num, patch);
  state.decoded++;
}

// Telemetry wrapper (telemetry.proto): time=1, device_metrics=2.
function parseTelemetryDeviceMetrics(buf) {
  const dmF = field(pbFields(buf), 2);
  return dmF && dmF.wt === 2 ? parseDeviceMetrics(dmF.v) : null;
}

// Live incremental updates: decoded MeshPacket app payloads heard directly
// off the mesh after the initial NodeDB dump (same envelope shape as
// mqtt-live.js's handleMapPayload — from=1, decoded=4, portnum=1, payload=2
// inside the decoded Data submessage).
function handleDecodedPacket(pkt) {
  const fromF = field(pkt, 1);
  const decodedF = field(pkt, 4);
  if (!fromF || !decodedF || decodedF.wt !== 2) return;
  const from = fromF.wt === 5 ? fromF.v.readUInt32LE(0) : Number(BigInt.asUintN(32, fromF.v));
  if (!from) return;
  const data = pbFields(decodedF.v);
  const portF = field(data, 1);
  const plF = field(data, 2);
  if (!portF || portF.wt !== 0 || !plF || plF.wt !== 2) return;
  const port = vNum(portF.v);

  if (port === PORTNUM_POSITION) {
    const p = parsePosition(plF.v);
    if (p.lat != null && p.lon != null && !(p.lat === 0 && p.lon === 0)) {
      const patch = { lat: p.lat / 1e7, lon: p.lon / 1e7 };
      if (p.alt != null) patch.alt = p.alt;
      if (p.prec != null) patch.prec = p.prec;
      upsert(from, patch);
      state.decoded++;
    }
  } else if (port === PORTNUM_NODEINFO) {
    const u = parseUser(plF.v);
    const patch = {};
    if (u.id) patch.hex = u.id;
    if (u.longName) patch.name = u.longName;
    if (u.shortName != null) patch.short = u.shortName;
    if (u.role != null) { patch.role = u.role; patch.roleName = ROLE_NAMES[u.role] || 'CLIENT'; }
    if (Object.keys(patch).length) { upsert(from, patch); state.decoded++; }
  } else if (port === PORTNUM_TELEMETRY) {
    const d = parseTelemetryDeviceMetrics(plF.v);
    if (d) {
      const patch = {};
      if (d.battery != null) patch.battery = d.battery;
      if (d.util != null) patch.util = d.util;
      if (d.airTx != null) patch.airTx = d.airTx;
      if (Object.keys(patch).length) { upsert(from, patch); state.decoded++; }
    }
  }
}

// FromRadio (mesh.proto): id=1, packet=2, my_info=3, node_info=4, config=5,
// log_record=6, config_complete_id=7.
function handleFromRadio(buf) {
  const fs = pbFields(buf);

  const myInfoF = field(fs, 3);
  if (myInfoF && myInfoF.wt === 2) {
    const numF = field(pbFields(myInfoF.v), 1);
    if (numF && numF.wt === 0) state.myNodeNum = vNum(numF.v);
    return;
  }

  const nodeInfoF = field(fs, 4);
  if (nodeInfoF && nodeInfoF.wt === 2) { parseNodeInfo(nodeInfoF.v); return; }

  const pktF = field(fs, 2);
  if (pktF && pktF.wt === 2) { handleDecodedPacket(pbFields(pktF.v)); return; }

  const ccF = field(fs, 7);
  if (ccF && ccF.wt === 0 && !state.configComplete) {
    state.configComplete = true;
    log(`initial NodeDB loaded: ${state.nodes.size} nodes known, ` +
      `${getNodes().length} positioned`);
  }
}

// ---- StreamAPI framing + TCP transport --------------------------------------

function sendToRadio(payload) {
  const head = Buffer.from([START1, START2, (payload.length >> 8) & 0xff, payload.length & 0xff]);
  state.sock.write(Buffer.concat([head, payload]));
}

function requestConfig() {
  if (!state.connected) return;
  const nonce = 1 + Math.floor(Math.random() * 0x7ffffffe);
  state.configComplete = false;
  sendToRadio(encodeVarintField(3, nonce)); // ToRadio.want_config_id
}

function onData(chunk) {
  state.buf = Buffer.concat([state.buf, chunk]);
  for (;;) {
    let start = -1;
    for (let i = 0; i + 1 < state.buf.length; i++) {
      if (state.buf[i] === START1 && state.buf[i + 1] === START2) { start = i; break; }
    }
    if (start === -1) {
      // keep a trailing lone START1 byte in case START2 arrives next chunk
      state.buf = state.buf.length && state.buf[state.buf.length - 1] === START1
        ? state.buf.subarray(state.buf.length - 1) : Buffer.alloc(0);
      return;
    }
    if (start > 0) state.buf = state.buf.subarray(start);
    if (state.buf.length < 4) return;
    const len = (state.buf[2] << 8) | state.buf[3];
    if (state.buf.length < 4 + len) return;
    const payload = state.buf.subarray(4, 4 + len);
    state.buf = state.buf.subarray(4 + len);
    state.lastMsgAt = Date.now();
    try { handleFromRadio(payload); } catch (e) { state.malformed++; }
  }
}

function connect() {
  if (state.stopped) return;
  state.buf = Buffer.alloc(0);
  state.connected = false;
  const sock = net.connect(PORT, HOST);
  state.sock = sock;
  sock.setNoDelay(true);
  sock.on('connect', () => {
    state.connected = true;
    state.reconnectMs = 3000;
    log(`connected to ${HOST}:${PORT}, requesting node DB`);
    requestConfig();
  });
  sock.on('data', onData);
  const onGone = (why) => () => {
    if (state.sock !== sock) return;
    state.connected = false;
    log(`${why}; reconnecting in ${Math.round(state.reconnectMs / 1000)}s`);
    setTimeout(connect, state.reconnectMs);
    state.reconnectMs = Math.min(state.reconnectMs * 2, 60000);
  };
  sock.on('error', (e) => { log('socket error:', e.message); sock.destroy(); });
  sock.on('close', onGone('connection closed'));
}

function start() {
  if (state.stopped) return;
  connect();
  resyncTimer = setInterval(requestConfig, RESYNC_MS);
  resyncTimer.unref();
}

function stop() {
  state.stopped = true;
  if (resyncTimer) clearInterval(resyncTimer);
  if (state.sock) state.sock.destroy();
}

// Node array in the shape server.js's cache expects — lat/lon already in
// decimal degrees. This *is* the node source when NODE_SOURCE=local-tcp,
// not a supplemental blend, so nothing further needs fetching.
function getNodes() {
  return [...state.nodes.values()].filter((n) => n.lat != null && n.lon != null);
}

function stats() {
  return {
    host: HOST, port: PORT,
    connected: state.connected,
    configComplete: state.configComplete,
    myNodeNum: state.myNodeNum,
    nodeCount: state.nodes.size,
    positionedCount: getNodes().length,
    decoded: state.decoded,
    malformed: state.malformed,
    lastMsgAt: state.lastMsgAt,
  };
}

module.exports = { start, stop, getNodes, stats };
