/**
 * Simulates an Egate for smoke-testing a running instance.
 *
 *   node test/tools/fake-egate.js [host] [port]
 *
 * Sends a serial announcement, a micro-inverter detail dump (deliberately
 * split mid-frame across two writes), then a status frame every 3 seconds,
 * and prints the ACK it gets back.
 */
import net from 'node:net';

const host = process.argv[2] ?? '127.0.0.1';
const port = Number(process.argv[3] ?? 11020);

const FRAME = 32;

function blank(type) {
  const f = Buffer.alloc(FRAME);
  f.writeUInt16BE(0xffff, 0);
  f[2] = type;
  return f;
}

function statusFrame(watts) {
  const f = blank(0xe7);
  f.writeUInt16BE(Math.round(watts * 4), 24);
  return f;
}

function detailFrame(serialHex, energyWh) {
  const f = blank(0x01);
  f.writeUInt16BE(Math.round((energyWh / 1000) * 8194.968553459119), 18);
  Buffer.from(serialHex, 'hex').copy(f, 30);
  return f;
}

const socket = net.createConnection({ host, port }, () => {
  console.log(`connected to ${host}:${port}`);

  socket.write(blank(0xe1));

  const dump = Buffer.concat([
    detailFrame('1a2b', 4200),
    detailFrame('3c4d', 3900),
    detailFrame('aabb', 4100),
  ]);
  // Split mid-frame to exercise the stream reassembly.
  socket.write(dump.subarray(0, 50));
  setTimeout(() => socket.write(dump.subarray(50)), 200);

  let n = 0;
  setInterval(() => {
    const watts = 800 + Math.round(Math.sin(n++ / 4) * 400);
    console.log(`-> status ${watts} W`);
    socket.write(statusFrame(watts));
  }, 3000);
});

socket.on('data', (d) => console.log('<- ack', d.toString('hex').slice(0, 16)));
socket.on('error', (err) => { console.error('error:', err.message); process.exit(1); });
socket.on('close', () => { console.log('closed'); process.exit(0); });
