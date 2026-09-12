import net from 'node:net';
import { createLogger } from './logger.js';
import { FrameReader, decodeFrame, STATUS_ACK } from './protocol.js';

const log = createLogger('egate');

/**
 * Forward the raw bytes to the original Involar collector.
 *
 * Involar is defunct, so this is off by default; when it is on, every failure
 * mode here is contained so it can never take the main path down.
 */
function relay(cfg, data) {
  const client = new net.Socket();
  let settled = false;
  const done = (err) => {
    if (settled) return;
    settled = true;
    if (err) log.debug('relay failed', { error: err.message });
    client.destroy();
  };

  client.setTimeout(cfg.timeoutMs);
  client.on('timeout', () => done(new Error('timeout')));
  client.on('error', done);
  client.on('close', () => done());
  client.connect(cfg.port, cfg.host, () => {
    // end() flushes the payload before closing; the original's write()+destroy()
    // could cut the transfer short.
    client.end(data);
  });
}

/**
 * One TCP listener per configured port. The original reused a single
 * net.Server for both ports, so the second listen() threw
 * ERR_SERVER_ALREADY_LISTEN and only one port ever came up.
 */
export class EgateServer {
  #servers = [];
  #connections = new Set();

  constructor(cfg, { onFrame, onRaw, stats }) {
    this.cfg = cfg;
    this.onFrame = onFrame;
    this.onRaw = onRaw;
    this.stats = stats;
  }

  async listen() {
    await Promise.all(this.cfg.listen.ports.map((port) => this.#listenOn(port)));
  }

  #listenOn(port) {
    return new Promise((resolve, reject) => {
      const server = net.createServer((socket) => this.#handle(socket, port));
      server.maxConnections = this.cfg.listen.maxConnections;

      const onError = (err) => {
        // Before 'listening' this is a bind failure; after, it is a stray
        // socket error that must not be allowed to kill the process.
        if (!server.listening) {
          reject(new Error(`could not bind port ${port}: ${err.message}`));
        } else {
          log.error(`server error on port ${port}`, err);
        }
      };

      server.on('error', onError);
      server.listen(port, this.cfg.listen.address, () => {
        log.info(`listening for Egate connections`, { address: this.cfg.listen.address, port });
        this.#servers.push(server);
        resolve();
      });
    });
  }

  #handle(socket, port) {
    const peer = `${socket.remoteAddress}:${socket.remotePort}`;
    const reader = new FrameReader();
    this.#connections.add(socket);
    this.stats.connectionOpened(peer, port);
    log.info('Egate connected', { peer, port, open: this.#connections.size });

    socket.setKeepAlive(true, 60_000);
    if (this.cfg.listen.idleTimeoutMs > 0) socket.setTimeout(this.cfg.listen.idleTimeoutMs);

    socket.on('timeout', () => {
      log.warn('closing idle connection', { peer, idleSeconds: this.cfg.listen.idleTimeoutMs / 1000 });
      socket.destroy();
    });

    socket.on('data', (chunk) => {
      try {
        this.stats.bytesReceived(chunk.length);
        if (this.cfg.relay.enabled) relay(this.cfg.relay, chunk);

        const frames = reader.push(chunk);
        if (!frames.length && reader.pendingBytes > 0) {
          log.debug('waiting for the rest of a frame', { peer, pending: reader.pendingBytes });
        }

        for (const frame of frames) {
          const decoded = decodeFrame(frame);
          this.onRaw?.(frame, decoded, port);
          if (decoded.kind === 'status') {
            // The Egate waits for this ACK before sending the next reading.
            socket.write(STATUS_ACK);
          }
          this.onFrame(decoded, { peer, port });
        }
      } catch (err) {
        log.error('failed to process incoming data', err);
      }
    });

    socket.on('error', (err) => log.warn('socket error', { peer, error: err.message }));
    socket.on('close', () => {
      this.#connections.delete(socket);
      log.info('Egate disconnected', { peer, port, open: this.#connections.size });
    });
  }

  get openConnections() {
    return this.#connections.size;
  }

  async close() {
    for (const socket of this.#connections) socket.destroy();
    this.#connections.clear();
    await Promise.all(
      this.#servers.map((s) => new Promise((resolve) => s.close(() => resolve()))),
    );
    this.#servers = [];
  }
}
