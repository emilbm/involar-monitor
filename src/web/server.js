import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createLogger } from '../logger.js';

const log = createLogger('web');

const WEB_ROOT = path.resolve(import.meta.dirname, '../../web');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

function sendJson(res, status, value) {
  send(res, status, JSON.stringify(value));
}

async function sendFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const stat = await fsp.stat(filePath);
  res.writeHead(200, {
    'Content-Type': TYPES[ext] ?? 'application/octet-stream',
    'Content-Length': stat.size,
    // The dashboard is served from the same box that writes the data, so a
    // hard refresh should always show the current build.
    'Cache-Control': 'no-cache',
    'Last-Modified': stat.mtime.toUTCString(),
  });
  fs.createReadStream(filePath).pipe(res);
}

/**
 * Serves the JSON API and the dashboard's static files.
 *
 * Deliberately unauthenticated: this is a LAN dashboard for one household's
 * own generation data. Do not publish the port to the internet as-is.
 */
export function createWebServer({ api, port, address }) {
  const server = http.createServer((req, res) => {
    const started = Date.now();
    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    } catch {
      return send(res, 400, '{"error":"bad request line"}');
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return send(res, 405, '{"error":"only GET is supported"}', { Allow: 'GET, HEAD' });
    }

    const route = url.pathname.replace(/\/+$/, '') || '/';
    const query = Object.fromEntries(url.searchParams);

    try {
      switch (route) {
        case '/health':
          return sendJson(res, api.status().ok ? 200 : 503, { status: 'ok' });
        case '/api/live':
          return sendJson(res, 200, api.live());
        case '/api/series':
          return sendJson(res, 200, api.series(query));
        case '/api/summary':
          return sendJson(res, 200, api.summary(query));
        case '/api/inverters':
          return sendJson(res, 200, api.inverters(query));
        case '/api/status':
          return sendJson(res, 200, api.status());
        default:
          break;
      }
    } catch (err) {
      const status = err.status ?? 500;
      if (status >= 500) log.error(`${route} failed`, err);
      return sendJson(res, status, { error: err.message });
    }

    if (route.startsWith('/api/')) return sendJson(res, 404, { error: 'no such endpoint' });

    // Static files. Resolve inside WEB_ROOT and verify, so no request can
    // escape the directory with `..` or an encoded separator.
    const requested = route === '/' ? '/index.html' : route;
    const filePath = path.resolve(WEB_ROOT, `.${requested}`);
    if (filePath !== WEB_ROOT && !filePath.startsWith(WEB_ROOT + path.sep)) {
      return sendJson(res, 403, { error: 'forbidden' });
    }

    sendFile(res, filePath)
      .catch(() => sendJson(res, 404, { error: 'not found' }))
      .finally(() => log.debug('served', { route, ms: Date.now() - started }));
  });

  server.on('error', (err) => log.error('web server error', err));
  server.on('clientError', (err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, address, () => {
      log.info('dashboard listening', { address, port });
      resolve(server);
    });
  });
}
