import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createLogger } from './logger.js';

const BATCH_MAX = 30;
const DRAIN_TICK_MS = 10_000;
const MAX_QUEUE_ENTRIES = 5_000;
const MIN_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 30 * 60_000;

const log = createLogger('pvoutput');

function fmt(v) {
  if (v === null || v === undefined) return '';
  return String(Math.round(v * 1000) / 1000);
}

/**
 * Durable, rate-limit-aware uploader.
 *
 * Readings are queued with the timestamp they were taken at, persisted to disk,
 * and drained in the background. A failed upload is retried with exponential
 * backoff instead of being dropped, and PVOutput's own rate-limit headers are
 * honoured so the hourly budget is never spent on requests that will 403.
 */
export class PvOutputClient {
  #queue = [];
  #timer = null;
  #sending = false;
  #consecutiveFailures = 0;
  #pausedUntil = 0;
  #remaining = null;
  #resetAt = null;
  #lastSuccessAt = null;
  #lastErrorAt = null;
  #lastError = null;
  #sentCount = 0;
  #droppedCount = 0;
  #dirty = false;

  constructor(cfg, { dataDir, fetchImpl = globalThis.fetch, now = Date.now } = {}) {
    this.cfg = cfg;
    this.queueFile = path.join(dataDir, 'pvoutput-queue.json');
    this.fetch = fetchImpl;
    this.now = now;
    // Token bucket mirroring the account's hourly allowance, so a large backlog
    // drains steadily instead of in one burst that trips the limit.
    this.tokens = cfg.rateLimitPerHour;
    this.lastRefill = now();
  }

  async start() {
    await this.#load();
    this.#timer = setInterval(() => { void this.#drain(); }, DRAIN_TICK_MS);
    log.info('uploader started', {
      dryRun: this.cfg.dryRun,
      queued: this.#queue.length,
      rateLimitPerHour: this.cfg.rateLimitPerHour,
    });
  }

  async stop() {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    await this.#save();
  }

  /**
   * @param {string} sid PVOutput system id
   * @param {{date:string,time:string,energy?:number|null,power?:number|null}} reading
   */
  enqueue(sid, reading) {
    const entry = {
      sid: String(sid),
      date: reading.date,
      time: reading.time,
      energy: reading.energy ?? null,
      power: reading.power ?? null,
      enqueuedAt: this.now(),
    };

    // One status per system per timestamp: a newer reading for the same slot
    // replaces the older one rather than queueing a duplicate.
    const i = this.#queue.findIndex(
      (e) => e.sid === entry.sid && e.date === entry.date && e.time === entry.time,
    );
    if (i >= 0) this.#queue[i] = entry;
    else this.#queue.push(entry);

    if (this.#queue.length > MAX_QUEUE_ENTRIES) {
      const overflow = this.#queue.length - MAX_QUEUE_ENTRIES;
      this.#queue.splice(0, overflow);
      this.#droppedCount += overflow;
      log.warn('queue overflow, dropped oldest readings', { dropped: overflow });
    }

    this.#dirty = true;
    log.debug('queued reading', entry);
  }

  /** Run one drain cycle immediately instead of waiting for the next tick. */
  async flush() {
    await this.#drain();
  }

  stats() {
    return {
      queued: this.#queue.length,
      sent: this.#sentCount,
      dropped: this.#droppedCount,
      lastSuccessAt: this.#lastSuccessAt,
      lastErrorAt: this.#lastErrorAt,
      lastError: this.#lastError,
      rateLimitRemaining: this.#remaining,
      rateLimitResetAt: this.#resetAt,
      pausedUntil: this.#pausedUntil || null,
      consecutiveFailures: this.#consecutiveFailures,
    };
  }

  // ---------------------------------------------------------------- internals

  #expire() {
    const cutoff = this.now() - this.cfg.maxQueueAgeMs;
    const before = this.#queue.length;
    this.#queue = this.#queue.filter((e) => e.enqueuedAt >= cutoff);
    const dropped = before - this.#queue.length;
    if (dropped > 0) {
      this.#droppedCount += dropped;
      this.#dirty = true;
      log.warn('dropped readings older than the back-fill window', { dropped });
    }
  }

  #refill() {
    const now = this.now();
    const elapsed = now - this.lastRefill;
    if (elapsed <= 0) return;
    this.lastRefill = now;
    this.tokens = Math.min(
      this.cfg.rateLimitPerHour,
      this.tokens + (elapsed / 3_600_000) * this.cfg.rateLimitPerHour,
    );
  }

  async #drain() {
    if (this.#sending) return;
    this.#sending = true;
    try {
      this.#expire();
      if (this.#dirty) await this.#save();
      if (!this.#queue.length) return;

      const now = this.now();
      if (now < this.#pausedUntil) return;

      this.#refill();
      if (this.tokens < 1) return;
      if (this.#remaining !== null && this.#remaining <= 1 && this.#resetAt && now < this.#resetAt) {
        log.debug('holding off, PVOutput hourly allowance nearly spent', {
          remaining: this.#remaining,
          resetAt: new Date(this.#resetAt).toISOString(),
        });
        return;
      }

      // Send one system's backlog per tick, oldest first.
      const sid = this.#queue[0].sid;
      const batch = this.#queue
        .filter((e) => e.sid === sid)
        .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time))
        .slice(0, BATCH_MAX);

      const ok = await this.#send(sid, batch);
      if (ok) {
        const sent = new Set(batch);
        this.#queue = this.#queue.filter((e) => !sent.has(e));
        this.#sentCount += batch.length;
        this.#consecutiveFailures = 0;
        this.#lastSuccessAt = this.now();
        this.#lastError = null;
        await this.#save();
      }
    } catch (err) {
      log.error('unexpected error while draining the queue', err);
    } finally {
      this.#sending = false;
    }
  }

  async #send(sid, batch) {
    const useBatch = batch.length > 1;
    const url = `${this.cfg.baseUrl}/${useBatch ? 'addbatchstatus.jsp' : 'addstatus.jsp'}`;

    const body = new URLSearchParams();
    if (useBatch) {
      body.set(
        'data',
        batch.map((e) => [e.date, e.time, fmt(e.energy), fmt(e.power)].join(',')).join(';'),
      );
    } else {
      const e = batch[0];
      body.set('d', e.date);
      body.set('t', e.time);
      if (e.energy !== null) body.set('v1', fmt(e.energy));
      if (e.power !== null) body.set('v2', fmt(e.power));
    }

    if (this.cfg.dryRun) {
      log.info('dry run, not posting', { sid, url, body: body.toString() });
      return true;
    }

    this.tokens -= 1;

    let res;
    try {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 20_000);
      try {
        res = await this.fetch(url, {
          method: 'POST',
          headers: {
            'X-Pvoutput-Apikey': this.cfg.apiKey,
            'X-Pvoutput-SystemId': sid,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body,
          signal: ac.signal,
        });
      } finally {
        clearTimeout(t);
      }
    } catch (err) {
      this.#fail(`network error: ${err.message}`);
      return false;
    }

    this.#readRateLimitHeaders(res);
    const text = (await res.text().catch(() => '')).trim();

    if (res.ok) {
      log.info('published', { sid, statuses: batch.length, response: text || 'OK' });
      return true;
    }

    if (res.status === 403) {
      // Either the hourly limit, or a system/key permission problem.
      const until = this.#resetAt ?? this.now() + 10 * 60_000;
      this.#pausedUntil = until;
      this.#fail(`403 from PVOutput: ${text}`, { pausedUntil: new Date(until).toISOString() });
      return false;
    }

    if (res.status === 401) {
      this.#pausedUntil = this.now() + 5 * 60_000;
      this.#fail(`401 unauthorised - check PVOUTPUT_API_KEY and PVOUTPUT_SYSTEM_ID: ${text}`);
      return false;
    }

    if (res.status === 400) {
      // Malformed or outside the back-fill window: retrying will never succeed.
      const sent = new Set(batch);
      this.#queue = this.#queue.filter((e) => !sent.has(e));
      this.#droppedCount += batch.length;
      this.#dirty = true;
      this.#fail(`400 bad request, discarded ${batch.length} reading(s): ${text}`);
      return false;
    }

    this.#fail(`HTTP ${res.status}: ${text}`);
    return false;
  }

  #readRateLimitHeaders(res) {
    const remainingRaw = res.headers.get('x-rate-limit-remaining');
    const resetRaw = res.headers.get('x-rate-limit-reset');
    const remaining = Number(remainingRaw);
    const reset = Number(resetRaw);
    if (remainingRaw !== null && Number.isFinite(remaining)) {
      this.#remaining = remaining;
      // Keep the local bucket in step with the server's view.
      this.tokens = Math.min(this.tokens, Math.max(0, remaining - 1));
    }
    if (resetRaw !== null && Number.isFinite(reset) && reset > 0) this.#resetAt = reset * 1000;
  }

  #fail(message, detail) {
    this.#consecutiveFailures += 1;
    this.#lastErrorAt = this.now();
    this.#lastError = message;
    const backoff = Math.min(
      MIN_BACKOFF_MS * 2 ** (this.#consecutiveFailures - 1),
      MAX_BACKOFF_MS,
    );
    this.#pausedUntil = Math.max(this.#pausedUntil, this.now() + backoff);
    log.warn(message, {
      ...detail,
      attempt: this.#consecutiveFailures,
      retryInSeconds: Math.round((this.#pausedUntil - this.now()) / 1000),
      queued: this.#queue.length,
    });
  }

  async #load() {
    try {
      const raw = await fs.readFile(this.queueFile, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        this.#queue = parsed.filter(
          (e) => e && typeof e.sid === 'string' && typeof e.date === 'string'
            && typeof e.time === 'string' && Number.isFinite(e.enqueuedAt),
        );
        this.#expire();
        if (this.#queue.length) {
          log.info('restored queued readings from disk', { count: this.#queue.length });
        }
      }
    } catch (err) {
      if (err.code !== 'ENOENT') log.warn('could not restore the queue, starting empty', err);
    }
  }

  async #save() {
    this.#dirty = false;
    const tmp = `${this.queueFile}.tmp`;
    try {
      await fs.mkdir(path.dirname(this.queueFile), { recursive: true });
      await fs.writeFile(tmp, JSON.stringify(this.#queue), 'utf8');
      await fs.rename(tmp, this.queueFile);
    } catch (err) {
      log.warn('could not persist the queue', err);
    }
  }
}
