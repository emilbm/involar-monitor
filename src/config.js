import path from 'node:path';

function str(name, fallback) {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

function bool(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  if (/^(1|true|yes|on)$/i.test(v)) return true;
  if (/^(0|false|no|off)$/i.test(v)) return false;
  throw new Error(`${name} must be a boolean (true/false), got "${v}"`);
}

function int(name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}, got "${v}"`);
  }
  return n;
}

function ports(name, fallback) {
  const raw = str(name, fallback);
  const list = raw.split(',').map((p) => p.trim()).filter(Boolean).map(Number);
  if (!list.length || list.some((p) => !Number.isInteger(p) || p < 1 || p > 65535)) {
    throw new Error(`${name} must be a comma-separated list of TCP ports, got "${raw}"`);
  }
  return [...new Set(list)];
}

/**
 * Optional display names for the micro-inverters, so the dashboard can say
 * "Roof south" instead of "1a2b". Accepts JSON or `1a2b=Roof south,3c4d=Garage`.
 * Unlabelled inverters still appear, under their serial.
 */
export function parseLabels(raw) {
  if (!raw) return {};
  const out = {};
  const trimmed = raw.trim();

  if (trimmed.startsWith('{')) {
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      throw new Error(`INVERTER_LABELS is not valid JSON: ${err.message}`);
    }
    for (const [k, v] of Object.entries(parsed)) out[String(k).toLowerCase()] = String(v);
  } else {
    for (const pair of trimmed.split(',')) {
      if (!pair.trim()) continue;
      const at = pair.indexOf('=');
      if (at <= 0 || at === pair.length - 1) {
        throw new Error(`INVERTER_LABELS entry "${pair}" must look like serial=Name`);
      }
      out[pair.slice(0, at).trim().toLowerCase()] = pair.slice(at + 1).trim();
    }
  }

  for (const serial of Object.keys(out)) {
    if (!/^[0-9a-f]{4}$/.test(serial)) {
      throw new Error(`Inverter serial "${serial}" must be exactly 4 hex digits`);
    }
  }
  return out;
}

export function loadConfig(env = process.env) {
  const previous = process.env;
  process.env = env;
  try {
    const dataDir = str('DATA_DIR', './data');

    const cfg = {
      tz: str('TZ', 'Europe/Amsterdam'),
      logLevel: str('LOG_LEVEL', 'info'),
      dataDir,

      listen: {
        address: str('LISTEN_ADDRESS', '0.0.0.0'),
        ports: ports('LISTEN_PORTS', '1020,9800'),
        maxConnections: int('MAX_CONNECTIONS', 16, { min: 1, max: 1024 }),
        idleTimeoutMs: int('SOCKET_IDLE_TIMEOUT_SECONDS', 900, { min: 0 }) * 1000,
      },

      db: {
        path: str('DB_PATH', path.join(dataDir, 'solar.db')),
        // Raw samples are pruned past this; the hourly and daily rollups that
        // the charts fall back to are kept forever. 0 disables pruning.
        retentionDays: int('SAMPLE_RETENTION_DAYS', 400, { min: 0 }),
        // A gap longer than this contributes no energy, so an outage or the
        // overnight silence cannot invent generation that never happened.
        maxGapSeconds: int('ENERGY_MAX_GAP_SECONDS', 900, { min: 30 }),
      },

      web: {
        enabled: bool('WEB_ENABLED', true),
        port: int('WEB_PORT', 8080, { min: 1, max: 65535 }),
        address: str('WEB_ADDRESS', '0.0.0.0'),
        // Window used for the "live" smoothed reading on the dashboard.
        liveWindowSeconds: int('LIVE_WINDOW_SECONDS', 120, { min: 10 }),
        // Older than this and the dashboard reports the Egate as stale.
        staleAfterSeconds: int('LIVE_STALE_AFTER_SECONDS', 300, { min: 30 }),
      },

      inverterLabels: parseLabels(str('INVERTER_LABELS', '')),

      relay: {
        enabled: bool('INVOLAR_RELAY', false),
        host: str('INVOLAR_SERVER', '62.28.182.144'),
        port: int('INVOLAR_PORT', 1020, { min: 1, max: 65535 }),
        timeoutMs: int('INVOLAR_TIMEOUT_SECONDS', 10, { min: 1 }) * 1000,
      },

      rawLog: {
        enabled: bool('RAW_LOG', false),
        maxBytes: int('RAW_LOG_MAX_BYTES', 5 * 1024 * 1024, { min: 1024 }),
        maxFiles: int('RAW_LOG_MAX_FILES', 3, { min: 1, max: 50 }),
      },
    };

    try {
      new Intl.DateTimeFormat('en-US', { timeZone: cfg.tz });
    } catch {
      throw new Error(`Invalid configuration:\n  - TZ "${cfg.tz}" is not a recognised IANA time zone`);
    }

    return cfg;
  } finally {
    process.env = previous;
  }
}
