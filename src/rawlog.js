import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from './logger.js';

const log = createLogger('rawlog');

/**
 * Optional append-only log of every frame seen on the wire, for decoding work.
 *
 * The original wrote these files unbounded, which eventually fills the disk on
 * a small box. This rotates at a size cap and keeps a fixed number of files.
 */
export class RawLog {
  #stream = null;
  #bytes = 0;
  #rotating = false;

  constructor({ enabled, dir, file = 'frames.log', maxBytes, maxFiles }) {
    this.enabled = enabled;
    this.file = path.join(dir, file);
    this.maxBytes = maxBytes;
    this.maxFiles = maxFiles;
  }

  open() {
    if (!this.enabled) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    this.#bytes = fs.existsSync(this.file) ? fs.statSync(this.file).size : 0;
    this.#stream = fs.createWriteStream(this.file, { flags: 'a' });
    this.#stream.on('error', (err) => log.warn('raw log write failed', err));
    log.info('raw frame logging enabled', { file: this.file, maxBytes: this.maxBytes });
  }

  write(line) {
    if (!this.#stream) return;
    const data = `${line}\n`;
    this.#bytes += Buffer.byteLength(data);
    this.#stream.write(data);
    if (this.#bytes >= this.maxBytes) this.#rotate();
  }

  #rotate() {
    if (this.#rotating) return;
    this.#rotating = true;
    const current = this.#stream;
    this.#stream = null;
    current.end(() => {
      try {
        for (let i = this.maxFiles - 1; i >= 1; i -= 1) {
          const from = i === 1 ? this.file : `${this.file}.${i - 1}`;
          const to = `${this.file}.${i}`;
          if (fs.existsSync(from)) fs.renameSync(from, to);
        }
      } catch (err) {
        log.warn('raw log rotation failed', err);
      }
      this.#bytes = 0;
      this.#stream = fs.createWriteStream(this.file, { flags: 'a' });
      this.#stream.on('error', (err) => log.warn('raw log write failed', err));
      this.#rotating = false;
    });
  }

  close() {
    if (this.#stream) this.#stream.end();
    this.#stream = null;
  }
}
