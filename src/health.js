import http from 'node:http';
import { createLogger } from './logger.js';

const log = createLogger('health');

/**
 * Tiny status endpoint for the Docker HEALTHCHECK and for eyeballing state.
 *
 * "Healthy" deliberately means "the listeners are up" and nothing more: solar
 * output stops every night, so tying health to recent telemetry would put the
 * container into a restart loop after dark.
 */
export function startHealthServer({ port, snapshot }) {
  const server = http.createServer((req, res) => {
    if (req.method !== 'GET') {
      res.writeHead(405).end();
      return;
    }
    const state = snapshot();
    const healthy = state.listening;
    const body = JSON.stringify({ status: healthy ? 'ok' : 'down', ...state }, null, 2);
    res.writeHead(healthy ? 200 : 503, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    });
    res.end(body);
  });

  server.on('error', (err) => log.error('health server error', err));

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', () => {
      log.info('health endpoint listening', { port });
      resolve(server);
    });
  });
}
