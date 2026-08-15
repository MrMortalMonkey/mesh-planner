// mqtt-live.js — live node feed from the public Meshtastic MQTT broker.
//
// Subscribes to the map-report topics (msh/<region...>/2/map/), which carry
// UNENCRYPTED MapReport protobufs: position, role, hardware, preset, region.
// This gives near-real-time node freshness between the 5-minute cache pulls of
// the aggregate databases. Zero npm dependencies: a minimal MQTT 3.1.1 client
// over TCP plus a hand-rolled protobuf wire-format reader (we only need a few
// well-known field numbers).
//
// Public broker credentials are the well-known community ones (meshdev).

const net = require('net');
const { pbFields, field, vNum, vInt32, sfixed32 } = require('./protolite');

const HOST = process.env.MQTT_HOST || 'mqtt.meshtastic.org';
const PORT = parseInt(process.env.MQTT_PORT || '1883', 10);
const USER = 'meshdev';
const PASS = 'large4cats';
// Map reports are subscribed globally (cheap). Link-observation harvesting
// needs the full per-region traffic tree — bandwidth scales with region count,
// so scope it (comma-separated env override, e.g. MQTT_REGIONS=US,EU_868).
const REGIONS = (process.env.MQTT_REGIONS || 'US').split(',').map((s) => s.trim()).filter(Boolean);
const TOPICS = ['msh/+/2/map/#', 'msh/+/+/2/map/#', 'msh/+/+/+/2/map/#',
  ...REGIONS.map((r) => `msh/${r}/#`)];
const KEEPALIVE_S = 60;
const LIVE_TTL_MS = 24 * 3600 * 1000;

const ROLE_NAMES = ['CLIENT', 'CLIENT_MUTE', 'ROUTER', 'ROUTER_CLIENT', 'REPEATER',
  'TRACKER', 'SENSOR', 'TAK', 'CLIENT_HIDDEN', 'LOST_AND_FOUND', 'TAK_TRACKER',
  'ROUTER_LATE', 'CLIENT_BASE'];
const REGION_NAMES = ['UNSET', 'US', 'EU_433', 'EU_868', 'CN', 'JP', 'ANZ', 'KR',
  'TW', 'RU', 'IN', 'NZ_865', 'TH', 'LORA_24', 'UA_433', 'UA_868', 'MY_433',
  'MY_919', 'SG_923', 'PH_433', 'PH_868', 'PH_915', 'ANZ_433', 'KZ_433',
  'KZ_863', 'NP_865', 'BR_902'];
const PRESET_NAMES = ['LONG_FAST', 'LONG_SLOW', 'VERY_LONG_SLOW', 'MEDIUM_SLOW',
  'MEDIUM_FAST', 'SHORT_SLOW', 'SHORT_FAST', 'LONG_MODERATE', 'SHORT_TURBO'];
const PORTNUM_MAP_REPORT = 73;

// ---- MapReport payload parser (wire-format reader lives in protolite.js) ---

function parseMapReport(buf) {
  const fs = pbFields(buf);
  const str = (f) => { const x = field(fs, f); return x && x.wt === 2 ? x.v.toString('utf8') : null; };
  const num = (f) => { const x = field(fs, f); return x && x.wt === 0 ? vNum(x.v) : null; };
  const sf32 = (f) => {
    const x = field(fs, f);
    if (!x) return null;
    if (x.wt === 5) return sfixed32(x.v);
    if (x.wt === 0) return vInt32(x.v); // defensive: some encoders vary
    return null;
  };
  return {
    name: str(1), short: str(2),
    role: num(3), hw: num(4), fw: str(5),
    region: num(6), preset: num(7),
    lat: sf32(9), lon: sf32(10),
    alt: (() => { const x = field(fs, 11); return x && x.wt === 0 ? vInt32(x.v) : null; })(),
    prec: num(12),
    numLocal: num(13),
  };
}

// ---- MQTT 3.1.1 minimal client ----------------------------------------------

function mqttStr(s) {
  const b = Buffer.from(s, 'utf8');
  const l = Buffer.alloc(2);
  l.writeUInt16BE(b.length, 0);
  return Buffer.concat([l, b]);
}

function encVarint(n) {
  const out = [];
  do {
    let b = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) b |= 0x80;
    out.push(b);
  } while (n > 0);
  return Buffer.from(out);
}

function mqttPacket(typeByte, body) {
  return Buffer.concat([Buffer.from([typeByte]), encVarint(body.length), body]);
}

const state = {
  sock: null,
  buf: Buffer.alloc(0),
  connected: false,
  decoded: 0,
  malformed: 0,
  linkObs: 0,
  lastMsgAt: null,
  reconnectMs: 5000,
  live: new Map(), // node id -> { name, short, roleName, region, preset, fw, lat, lon, alt, numLocal, at }
  stopped: false,
};

let onLinkObsCb = null;

function log(...args) { console.log('[mqtt]', ...args); }

function handleMapPayload(payload) {
  // ServiceEnvelope: f1 = MeshPacket
  const env = pbFields(payload);
  const pktF = field(env, 1);
  if (!pktF || pktF.wt !== 2) return;
  const pkt = pbFields(pktF.v);
  const fromF = field(pkt, 1);
  const decodedF = field(pkt, 4);
  if (!fromF || !decodedF || decodedF.wt !== 2) return;
  const from = fromF.wt === 5 ? fromF.v.readUInt32LE(0) : Number(BigInt.asUintN(32, fromF.v));
  const data = pbFields(decodedF.v);
  const portF = field(data, 1);
  const plF = field(data, 2);
  if (!portF || vNum(portF.v) !== PORTNUM_MAP_REPORT || !plF || plF.wt !== 2) return;
  const r = parseMapReport(plF.v);
  if (r.lat == null || r.lon == null || (r.lat === 0 && r.lon === 0)) return;
  const lat = r.lat / 1e7, lon = r.lon / 1e7;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return;
  state.live.set(from, {
    name: r.name || null,
    short: r.short || null,
    roleName: r.role != null ? (ROLE_NAMES[r.role] || 'CLIENT') : null,
    region: r.region != null && r.region > 0 ? (REGION_NAMES[r.region] || null) : null,
    preset: r.preset != null ? (PRESET_NAMES[r.preset] || null) : null,
    fw: r.fw || null,
    lat, lon,
    alt: r.alt,
    prec: r.prec,
    numLocal: r.numLocal,
    at: Date.now(),
  });
  state.decoded++;
}

// Envelope-metadata link observation: the gateway heard `from` directly off
// the air when the packet consumed zero hops and wasn't injected via MQTT.
// rx_snr/rx_rssi live in the plaintext MeshPacket header — no payload
// decryption involved.
function handleLinkEnvelope(payload) {
  const env = pbFields(payload);
  const pktF = field(env, 1);
  const gwF = field(env, 3); // gateway_id, e.g. "!a1b2c3d4"
  if (!pktF || pktF.wt !== 2 || !gwF || gwF.wt !== 2) return;
  const gwStr = gwF.v.toString('utf8');
  if (!gwStr.startsWith('!')) return;
  const gw = parseInt(gwStr.slice(1), 16) >>> 0;
  if (!gw) return;
  const pkt = pbFields(pktF.v);
  const fromF = field(pkt, 1);
  if (!fromF) return;
  const from = fromF.wt === 5 ? fromF.v.readUInt32LE(0) : Number(BigInt.asUintN(32, fromF.v));
  if (!from || from === gw) return;
  const num = (f) => { const x = field(pkt, f); return x && x.wt === 0 ? vNum(x.v) : null; };
  if (num(14)) return; // via_mqtt: gateway got it from the broker, not RF
  const hopLimit = num(9), hopStart = num(15);
  if (!hopStart || hopLimit == null || hopLimit !== hopStart) return; // must be 0 hops
  const snrF = field(pkt, 8); // rx_snr float
  if (!snrF || snrF.wt !== 5) return;
  const snr = snrF.v.readFloatLE(0);
  if (!Number.isFinite(snr) || snr === 0 || snr < -30 || snr > 15) return;
  const rssiF = field(pkt, 12);
  const rssi = rssiF && rssiF.wt === 0 ? vInt32(rssiF.v) : null;
  state.linkObs++;
  if (onLinkObsCb) {
    onLinkObsCb({ a: Math.min(from, gw), b: Math.max(from, gw), snr, rssi, at: Date.now() });
  }
}

function onPublish(topic, payload) {
  state.lastMsgAt = Date.now();
  // json/stat topics carry text, not ServiceEnvelope protobufs
  if (/\/(json|stat)\//.test(topic + '/')) return;
  try {
    if (/\/2\/map\//.test(topic + '/')) handleMapPayload(payload);
    else handleLinkEnvelope(payload);
  } catch {
    state.malformed++;
  }
}

function dispatch(typeByte, body) {
  const type = typeByte >> 4;
  if (type === 2) { // CONNACK
    const rc = body[1];
    if (rc === 0) {
      state.connected = true;
      state.reconnectMs = 5000;
      log('connected, subscribing to map topics');
      let sub = Buffer.alloc(2);
      sub.writeUInt16BE(1, 0);
      for (const t of TOPICS) sub = Buffer.concat([sub, mqttStr(t), Buffer.from([0])]);
      state.sock.write(mqttPacket(0x82, sub));
    } else {
      log(`CONNACK refused (rc=${rc})`);
      state.sock.destroy();
    }
  } else if (type === 3) { // PUBLISH
    const qos = (typeByte >> 1) & 3;
    const tlen = body.readUInt16BE(0);
    const topic = body.subarray(2, 2 + tlen).toString('utf8');
    let off = 2 + tlen;
    if (qos > 0) {
      const pid = body.readUInt16BE(off);
      off += 2;
      const ack = Buffer.alloc(2);
      ack.writeUInt16BE(pid, 0);
      state.sock.write(mqttPacket(0x40, ack)); // PUBACK
    }
    onPublish(topic, body.subarray(off));
  }
  // SUBACK (9) / PINGRESP (13): nothing to do
}

function onData(chunk) {
  state.buf = Buffer.concat([state.buf, chunk]);
  for (;;) {
    if (state.buf.length < 2) return;
    // fixed header: 1 type byte + 1-4 byte varint remaining length
    let rem = 0, mult = 1, i = 1, ok = false;
    for (; i < Math.min(state.buf.length, 5); i++) {
      const b = state.buf[i];
      rem += (b & 0x7f) * mult;
      mult *= 128;
      if (!(b & 0x80)) { ok = true; i++; break; }
    }
    if (!ok) return; // length bytes incomplete
    const total = i + rem;
    if (state.buf.length < total) return;
    const typeByte = state.buf[0];
    const body = state.buf.subarray(i, total);
    state.buf = state.buf.subarray(total);
    try { dispatch(typeByte, body); } catch (e) { state.malformed++; }
  }
}

let pingTimer = null;
let pruneTimer = null;

function connect() {
  if (state.stopped) return;
  state.buf = Buffer.alloc(0);
  state.connected = false;
  const sock = net.connect(PORT, HOST);
  state.sock = sock;
  sock.setNoDelay(true);
  sock.on('connect', () => {
    const clientId = 'meshplanner-' + process.pid + '-' + (Date.now() % 100000);
    const body = Buffer.concat([
      mqttStr('MQTT'), Buffer.from([4, 0xC2, KEEPALIVE_S >> 8, KEEPALIVE_S & 0xff]),
      mqttStr(clientId), mqttStr(USER), mqttStr(PASS),
    ]);
    sock.write(mqttPacket(0x10, body));
  });
  sock.on('data', onData);
  const onGone = (why) => () => {
    if (state.sock !== sock) return;
    state.connected = false;
    log(`${why}; reconnecting in ${Math.round(state.reconnectMs / 1000)}s`);
    setTimeout(connect, state.reconnectMs);
    state.reconnectMs = Math.min(state.reconnectMs * 2, 120000);
  };
  sock.on('error', (e) => { log('socket error:', e.message); sock.destroy(); });
  sock.on('close', onGone('connection closed'));
}

function start(opts = {}) {
  onLinkObsCb = opts.onLinkObs || null;
  if (process.env.MQTT_DISABLE === '1') {
    log('disabled via MQTT_DISABLE=1');
    return;
  }
  connect();
  pingTimer = setInterval(() => {
    if (state.connected && state.sock) state.sock.write(Buffer.from([0xC0, 0]));
  }, 30000);
  pruneTimer = setInterval(() => {
    const cutoff = Date.now() - LIVE_TTL_MS;
    for (const [id, n] of state.live) if (n.at < cutoff) state.live.delete(id);
  }, 10 * 60 * 1000);
  pingTimer.unref(); pruneTimer.unref();
  setInterval(() => {
    if (state.decoded > 0) {
      log(`${state.live.size} live nodes tracked (${state.decoded} map reports decoded, ${state.malformed} unparsed)`);
    }
  }, 10 * 60 * 1000).unref();
}

function getLive() { return state.live; }

function stats() {
  return {
    connected: state.connected,
    liveNodes: state.live.size,
    decoded: state.decoded,
    linkObs: state.linkObs,
    malformed: state.malformed,
    lastMsgAt: state.lastMsgAt,
    regions: REGIONS,
  };
}

module.exports = { start, getLive, stats, LIVE_TTL_MS };
