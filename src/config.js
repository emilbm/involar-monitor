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
 * Accepts either JSON (`{"1a2b":"12345"}`) or a compact list
 * (`1a2b=12345,3c4d=23456`). Serial keys are the last 4 hex digits of the
 * micro-inverter serial, lower-cased; values are PVOutput system ids.
 */
export function parseMapping(raw) {
  if (!raw) return {};
  const out = {};
  const trimmed = raw.trim();

  if (trimmed.startsWith('{')) {
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      throw new Error(`PVOUTPUT_MICROINVERTER_MAPPING is not valid JSON: ${err.message}`);
    }
    for (const [k, v] of Object.entries(parsed)) out[String(k).toLowerCase()] = String(v);
  } else {
    for (const pair of trimmed.split(',')) {
      if (!pair.trim()) continue;
      const m = pair.split(/[=:]/);
      if (m.length !== 2 || !m[0].trim() || !m[1].trim()) {
        throw new Error(`PVOUTPUT_MICROINVERTER_MAPPING entry "${pair}" must look like serial=systemId`);
      }
      out[m[0].trim().toLowerCase()] = m[1].trim();
    }
  }

  for (const [serial, sid] of Object.entries(out)) {
    if (!/^[0-9a-f]{4}$/.test(serial)) {
      throw new Error(`Micro-inverter serial "${serial}" must be exactly 4 hex digits`);
    }
    if (!/^\d+$/.test(sid)) {
      throw new Error(`PVOutput system id for serial "${serial}" must be numeric, got "${sid}"`);
    }
  }
  return out;
}

export function loadConfig(env = process.env) {
  const previous = process.env;
  process.env = env;
  try {
    const cfg = {
      tz: str('TZ', 'Europe/Amsterdam'),
      logLevel: str('LOG_LEVEL', 'info'),

      listen: {
        address: str('LISTEN_ADDRESS', '0.0.0.0'),
        ports: ports('LISTEN_PORTS', '1020,9800'),
        maxConnections: int('MAX_CONNECTIONS', 16, { min: 1, max: 1024 }),
        idleTimeoutMs: int('SOCKET_IDLE_TIMEOUT_SECONDS', 900, { min: 0 }) * 1000,
      },

      health: {
        enabled: bool('HEALTH_ENABLED', true),
        port: int('HEALTH_PORT', 8080, { min: 1, max: 65535 }),
      },

      pvoutput: {
        apiKey: str('PVOUTPUT_API_KEY', ''),
        systemId: str('PVOUTPUT_SYSTEM_ID', ''),
        baseUrl: str('PVOUTPUT_BASE_URL', 'https://pvoutput.org/service/r2'),
        dryRun: bool('PVOUTPUT_DRY_RUN', false),
        // How often the aggregated whole-array power reading is published.
        // 300s matches PVOutput's standard 5-minute status interval (12 req/h).
        postIntervalMs: int('PVOUTPUT_POST_INTERVAL_SECONDS', 300, { min: 60 }) * 1000,
        // Power is averaged over this trailing window before being published.
        averageWindowMs: int('POWER_AVERAGE_WINDOW_SECONDS', 300, { min: 30 }) * 1000,
        microInverterMode: bool('PVOUTPUT_MICROINVERTER_MODE', false),
        // Every mapped inverter costs one request per cycle, so this defaults
        // to a slower cadence to stay inside the 60 req/h free-tier budget.
        microIntervalMs: int('PVOUTPUT_MICROINVERTER_INTERVAL_SECONDS', 900, { min: 60 }) * 1000,
        mapping: parseMapping(str('PVOUTPUT_MICROINVERTER_MAPPING', '')),
        // Requests per hour the account is allowed. Free = 60, donator = 300.
        rateLimitPerHour: int('PVOUTPUT_RATE_LIMIT_PER_HOUR', 60, { min: 1 }),
        // Queued readings older than this are dropped rather than back-filled.
        maxQueueAgeMs: int('PVOUTPUT_MAX_QUEUE_AGE_HOURS', 24, { min: 1 }) * 3600 * 1000,
      },

      relay: {
        enabled: bool('INVOLAR_RELAY', false),
        host: str('INVOLAR_SERVER', '62.28.182.144'),
        port: int('INVOLAR_PORT', 1020, { min: 1, max: 65535 }),
        timeoutMs: int('INVOLAR_TIMEOUT_SECONDS', 10, { min: 1 }) * 1000,
      },

      dataDir: str('DATA_DIR', './data'),
      rawLog: {
        enabled: bool('RAW_LOG', false),
        maxBytes: int('RAW_LOG_MAX_BYTES', 5 * 1024 * 1024, { min: 1024 }),
        maxFiles: int('RAW_LOG_MAX_FILES', 3, { min: 1, max: 50 }),
      },
    };

    const problems = [];
    if (!cfg.pvoutput.dryRun) {
      if (!cfg.pvoutput.apiKey) problems.push('PVOUTPUT_API_KEY is required');
      if (!/^\d+$/.test(cfg.pvoutput.systemId)) {
        problems.push('PVOUTPUT_SYSTEM_ID is required and must be numeric');
      }
    }
    if (cfg.pvoutput.microInverterMode && Object.keys(cfg.pvoutput.mapping).length === 0) {
      problems.push('PVOUTPUT_MICROINVERTER_MODE is enabled but PVOUTPUT_MICROINVERTER_MAPPING is empty');
    }
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: cfg.tz });
    } catch {
      problems.push(`TZ "${cfg.tz}" is not a recognised IANA time zone`);
    }
    if (problems.length) {
      throw new Error(`Invalid configuration:\n  - ${problems.join('\n  - ')}`);
    }

    return cfg;
  } finally {
    process.env = previous;
  }
}
