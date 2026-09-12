/**
 * Egate wire format.
 *
 * Everything the Egate sends is a stream of fixed 32-byte frames, each of
 * which starts with the marker 0xFFFF. Byte 2 is the message type:
 *
 *   0xE7  status frame  - whole-array instantaneous power, must be ACKed
 *   0xE1  Egate serial number announcement (no payload we use)
 *   0xE9  keepalive / unknown, silently ignored by the original code
 *   other detail record  - one micro-inverter's daily energy total
 *
 * The original implementation guessed the frame type from the length of the
 * TCP `data` event, which breaks as soon as the kernel splits or coalesces
 * segments. We reassemble on 32-byte boundaries instead.
 */

export const FRAME_BYTES = 32;
export const FRAME_MARKER = 0xffff;

export const MSG_STATUS = 0xe7;
export const MSG_SERIAL = 0xe1;
export const MSG_KEEPALIVE = 0xe9;

/** The exact byte sequence the Egate expects back after a 0xE7 status frame. */
export const STATUS_ACK = Buffer.from(
  'ffffa77000000000000000000000000000000000000000000000000000000000',
  'hex',
);

/**
 * Daily-energy scale factor from the original decoding work (see README
 * acknowledgements). The raw 16-bit counter is in units of
 * 1/8194.968553459119 kWh; we publish Wh.
 */
export const ENERGY_DIVISOR = 8194.968553459119;

/**
 * Accumulates bytes from a TCP socket and yields whole 32-byte frames.
 * A trailing partial frame is kept until the rest of it arrives.
 */
export class FrameReader {
  #buffer = Buffer.alloc(0);

  /** @returns {Buffer[]} complete frames unlocked by this chunk */
  push(chunk) {
    this.#buffer = this.#buffer.length === 0
      ? Buffer.from(chunk)
      : Buffer.concat([this.#buffer, chunk]);

    const frames = [];
    let offset = 0;
    while (this.#buffer.length - offset >= FRAME_BYTES) {
      frames.push(this.#buffer.subarray(offset, offset + FRAME_BYTES));
      offset += FRAME_BYTES;
    }
    this.#buffer = offset === 0 ? this.#buffer : Buffer.from(this.#buffer.subarray(offset));
    return frames;
  }

  get pendingBytes() {
    return this.#buffer.length;
  }

  reset() {
    this.#buffer = Buffer.alloc(0);
  }
}

/**
 * Classify and decode a single 32-byte frame.
 * @returns {{kind: string, [key: string]: any}}
 */
export function decodeFrame(frame) {
  if (frame.length !== FRAME_BYTES) {
    return { kind: 'invalid', reason: `expected ${FRAME_BYTES} bytes, got ${frame.length}` };
  }

  // Check the type byte before the marker: the marker is informational, and we
  // would rather decode a known message type than reject it on a strict check.
  const type = frame[2];

  if (type === MSG_STATUS) {
    // Bytes 24-25 hold the array power in quarter-watts.
    return { kind: 'status', watts: frame.readUInt16BE(24) / 4 };
  }
  if (type === MSG_SERIAL) return { kind: 'serial' };
  if (type === MSG_KEEPALIVE) return { kind: 'keepalive' };

  if (frame.readUInt16BE(0) !== FRAME_MARKER) {
    return { kind: 'unknown', reason: 'missing 0xffff frame marker', hex: frame.toString('hex') };
  }

  // Detail record: bytes 18-19 are today's energy counter, bytes 30-31 are the
  // last four hex digits of the micro-inverter serial.
  const serial = frame.subarray(30, 32).toString('hex');
  const energyWh = (frame.readUInt16BE(18) / ENERGY_DIVISOR) * 1000;
  return { kind: 'detail', serial, energyWh, type };
}

/** Convenience wrapper: decode every frame in a buffer of whole frames. */
export function decodeFrames(buffer) {
  const reader = new FrameReader();
  return reader.push(buffer).map(decodeFrame);
}
