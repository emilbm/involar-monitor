/**
 * Trailing-window mean of the instantaneous power readings.
 *
 * The Egate reports every few seconds; PVOutput wants one value per interval.
 * Averaging smooths the spikes, and pruning by timestamp (rather than by
 * splicing during iteration, as the original did) keeps the window honest.
 */
export class PowerWindow {
  #samples = [];

  constructor(windowMs, now = Date.now) {
    this.windowMs = windowMs;
    this.now = now;
  }

  add(watts, at = this.now()) {
    if (!Number.isFinite(watts)) return;
    this.#samples.push({ at, watts });
    this.#prune(at);
  }

  #prune(reference = this.now()) {
    const cutoff = reference - this.windowMs;
    // Samples are appended in time order, so drop from the front.
    let i = 0;
    while (i < this.#samples.length && this.#samples[i].at < cutoff) i += 1;
    if (i > 0) this.#samples.splice(0, i);
  }

  /** @returns {{count:number, average:number, latest:number|null}|null} */
  summarise() {
    this.#prune();
    if (!this.#samples.length) return null;
    const total = this.#samples.reduce((sum, s) => sum + s.watts, 0);
    return {
      count: this.#samples.length,
      average: total / this.#samples.length,
      latest: this.#samples[this.#samples.length - 1].watts,
    };
  }

  clear() {
    this.#samples = [];
  }

  get size() {
    return this.#samples.length;
  }
}

/**
 * Latest daily-energy total per micro-inverter serial. The Egate resends the
 * full table periodically, so we only ever keep the newest value per serial.
 */
export class InverterTotals {
  #bySerial = new Map();

  constructor(now = Date.now) {
    this.now = now;
  }

  record(serial, energyWh, at = this.now()) {
    if (!Number.isFinite(energyWh) || energyWh <= 0) return false;
    this.#bySerial.set(serial, { energyWh, at });
    return true;
  }

  /** Readings recorded since the last call, then cleared. */
  drain() {
    const out = [...this.#bySerial.entries()].map(([serial, v]) => ({ serial, ...v }));
    this.#bySerial.clear();
    return out;
  }

  get size() {
    return this.#bySerial.size;
  }
}
