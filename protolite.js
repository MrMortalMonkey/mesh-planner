// protolite.js — minimal shared protobuf wire-format reader/writer.
//
// Used by both mqtt-live.js (MapReport/ServiceEnvelope decoding) and
// localnode-tcp.js (FromRadio/ToRadio decoding). Handles only what those two
// need: the four wire types Meshtastic protobufs actually use
// (varint/fixed64/length-delimited/fixed32) and single-field varint message
// construction for building a ToRadio{want_config_id}. No schema, no code
// generation — same "zero npm dependencies" philosophy as the rest of the
// server.

function pbVarint(buf, i) {
  let v = 0n, shift = 0n;
  for (;;) {
    if (i >= buf.length) throw new Error('truncated varint');
    const b = buf[i++];
    v |= BigInt(b & 0x7f) << shift;
    if (!(b & 0x80)) break;
    shift += 7n;
    if (shift > 63n) throw new Error('varint too long');
  }
  return [v, i];
}

function pbFields(buf) {
  const out = [];
  let i = 0;
  while (i < buf.length) {
    let tag;
    [tag, i] = pbVarint(buf, i);
    const f = Number(tag >> 3n), wt = Number(tag & 7n);
    if (wt === 0) { let v; [v, i] = pbVarint(buf, i); out.push({ f, wt, v }); }
    else if (wt === 2) {
      let len; [len, i] = pbVarint(buf, i);
      const l = Number(len);
      if (i + l > buf.length) throw new Error('truncated bytes field');
      out.push({ f, wt, v: buf.subarray(i, i + l) }); i += l;
    } else if (wt === 5) { out.push({ f, wt, v: buf.subarray(i, i + 4) }); i += 4; }
    else if (wt === 1) { out.push({ f, wt, v: buf.subarray(i, i + 8) }); i += 8; }
    else throw new Error(`unsupported wire type ${wt}`);
  }
  return out;
}

const vNum = (v) => Number(BigInt.asIntN(64, v));
const vInt32 = (v) => Number(BigInt.asIntN(32, v));
const sfixed32 = (b) => b.readInt32LE(0);

function field(fields, f) { return fields.find((x) => x.f === f); }

function encVarint(n) {
  n = BigInt(n);
  const out = [];
  do {
    let b = Number(n & 0x7fn);
    n >>= 7n;
    if (n > 0n) b |= 0x80;
    out.push(b);
  } while (n > 0n);
  return Buffer.from(out);
}

// Encodes a single varint (wire type 0) field. All we need to build a
// ToRadio{want_config_id = N} request — the one message this server ever
// sends *to* a radio.
function encodeVarintField(fieldNum, value) {
  const tag = (fieldNum << 3) | 0;
  return Buffer.concat([encVarint(tag), encVarint(value)]);
}

module.exports = { pbVarint, pbFields, vNum, vInt32, sfixed32, field, encVarint, encodeVarintField };
