import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FrameReader, decodeFrame, decodeFrames, STATUS_ACK, FRAME_BYTES,
} from '../src/protocol.js';

/** Build a 32-byte frame from a partial hex string, zero-padded. */
function frame(hex) {
  const buf = Buffer.alloc(FRAME_BYTES);
  Buffer.from(hex.padEnd(FRAME_BYTES * 2, '0'), 'hex').copy(buf);
  return buf;
}

test('status frame decodes power as quarter-watts at byte 24', () => {
  // 0x0640 = 1600 quarter-watts = 400 W
  const f = frame('ffffe7'.padEnd(48, '0') + '0640');
  assert.equal(f.length, FRAME_BYTES);
  assert.deepEqual(decodeFrame(f), { kind: 'status', watts: 400 });
});

test('status ACK matches the byte sequence the Egate expects', () => {
  assert.equal(
    STATUS_ACK.toString('hex'),
    'ffffa77000000000000000000000000000000000000000000000000000000000',
  );
  assert.equal(STATUS_ACK.length, FRAME_BYTES);
});

test('serial and keepalive frames are recognised and carry no reading', () => {
  assert.deepEqual(decodeFrame(frame('ffffe1')), { kind: 'serial' });
  assert.deepEqual(decodeFrame(frame('ffffe9')), { kind: 'keepalive' });
});

test('detail frame decodes serial from bytes 30-31 and energy from bytes 18-19', () => {
  const f = Buffer.alloc(FRAME_BYTES);
  f.writeUInt16BE(0xffff, 0);
  f[2] = 0x01;
  f.writeUInt16BE(8195, 18); // ~1000 Wh
  Buffer.from('1a2b', 'hex').copy(f, 30);

  const d = decodeFrame(f);
  assert.equal(d.kind, 'detail');
  assert.equal(d.serial, '1a2b');
  assert.ok(Math.abs(d.energyWh - 1000) < 1, `expected ~1000 Wh, got ${d.energyWh}`);
});

test('a serial containing hex letters is not dropped (regression: `serial > 0`)', () => {
  const f = Buffer.alloc(FRAME_BYTES);
  f.writeUInt16BE(0xffff, 0);
  f.writeUInt16BE(8195, 18);
  Buffer.from('aabb', 'hex').copy(f, 30);
  assert.equal(decodeFrame(f).serial, 'aabb');
});

test('frames without the marker or a known type are flagged, not guessed at', () => {
  const f = Buffer.alloc(FRAME_BYTES);
  f.writeUInt16BE(0x1234, 0);
  assert.equal(decodeFrame(f).kind, 'unknown');
});

test('short buffers are rejected rather than mis-parsed', () => {
  assert.equal(decodeFrame(Buffer.alloc(10)).kind, 'invalid');
});

test('FrameReader reassembles a frame split across TCP chunks', () => {
  const f = frame('ffffe7'.padEnd(48, '0') + '0640');
  const reader = new FrameReader();

  assert.deepEqual(reader.push(f.subarray(0, 20)), []);
  assert.equal(reader.pendingBytes, 20);

  const frames = reader.push(f.subarray(20));
  assert.equal(frames.length, 1);
  assert.equal(reader.pendingBytes, 0);
  assert.deepEqual(decodeFrame(frames[0]), { kind: 'status', watts: 400 });
});

test('FrameReader splits coalesced frames and keeps the trailing remainder', () => {
  const a = frame('ffffe1');
  const b = frame('ffffe9');
  const reader = new FrameReader();

  const frames = reader.push(Buffer.concat([a, b, a.subarray(0, 5)]));
  assert.equal(frames.length, 2);
  assert.equal(reader.pendingBytes, 5);
  assert.deepEqual(frames.map(decodeFrame).map((d) => d.kind), ['serial', 'keepalive']);
});

test('a multi-record detail dump decodes every record', () => {
  const records = ['1a2b', '3c4d', '5e6f'].map((serial) => {
    const f = Buffer.alloc(FRAME_BYTES);
    f.writeUInt16BE(0xffff, 0);
    f.writeUInt16BE(4097, 18);
    Buffer.from(serial, 'hex').copy(f, 30);
    return f;
  });

  const decoded = decodeFrames(Buffer.concat(records));
  assert.equal(decoded.length, 3);
  assert.deepEqual(decoded.map((d) => d.serial), ['1a2b', '3c4d', '5e6f']);
  assert.ok(decoded.every((d) => d.kind === 'detail' && d.energyWh > 0));
});
