/**
 * Two canvas chart forms, drawn against the page's CSS custom properties so
 * light and dark come from the same token definitions as the rest of the UI.
 *
 * Both ship a hover layer with a keyboard equivalent: an HTML chart is
 * interactive, and a value must never be reachable by hover alone.
 */

const PAD = { top: 14, right: 14, bottom: 30, left: 52 };

function token(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** Axis ticks on 1/2/5 x 10^n, which are the steps people read fluently. */
function niceTicks(min, max, count = 5) {
  if (!(max > min)) return { ticks: [min], min, max: min + 1 };
  const raw = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Math.round(v / step) * step);
  return { ticks, min: lo, max: hi };
}

function sizeCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(1, Math.round(rect.width));
  const h = Math.max(1, Math.round(rect.height));
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = w * dpr;
    canvas.height = h * dpr;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

function roundedTopRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, Math.max(0, h));
  ctx.beginPath();
  ctx.moveTo(x, y + h);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h);
  ctx.closePath();
  ctx.fill();
}

/** Shared plumbing: sizing, the tooltip element, hover and keyboard cursor. */
class BaseChart {
  constructor(container, { onFormatTooltip }) {
    this.container = container;
    this.canvas = container.querySelector('canvas');
    this.empty = container.querySelector('.empty');
    this.onFormatTooltip = onFormatTooltip;

    this.tooltip = document.createElement('div');
    this.tooltip.className = 'tooltip';
    this.tooltip.setAttribute('role', 'status');
    container.appendChild(this.tooltip);

    this.data = [];
    this.cursor = null;
    this.plot = null;
    this.pointer = null;

    this.canvas.tabIndex = 0;
    this.canvas.setAttribute('role', 'img');

    this.canvas.addEventListener('pointermove', (e) => this.#onPointer(e));
    this.canvas.addEventListener('pointerleave', () => {
      this.pointer = null;
      this.setCursor(null);
    });
    this.canvas.addEventListener('blur', () => this.setCursor(null));
    this.canvas.addEventListener('keydown', (e) => this.#onKey(e));

    this._onResize = () => this.render();
    window.addEventListener('resize', this._onResize);
    // Re-draw when the theme flips, so canvas colours follow the tokens.
    this._observer = new MutationObserver(() => this.render());
    this._observer.observe(document.documentElement, {
      attributes: true, attributeFilter: ['data-theme'],
    });
  }

  #onPointer(e) {
    if (!this.plot || !this.data.length) return;
    const rect = this.canvas.getBoundingClientRect();
    this.pointer = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    this.setCursor(this.indexAt(this.pointer.x, this.pointer.y));
  }

  #onKey(e) {
    if (!this.data.length) return;
    const last = this.data.length - 1;
    let i = this.cursor;
    if (e.key === 'ArrowRight') i = i === null ? 0 : Math.min(last, i + 1);
    else if (e.key === 'ArrowLeft') i = i === null ? last : Math.max(0, i - 1);
    else if (e.key === 'Home') i = 0;
    else if (e.key === 'End') i = last;
    else if (e.key === 'Escape') i = null;
    else return;
    e.preventDefault();
    this.setCursor(i);
  }

  setCursor(index) {
    if (index === this.cursor) return;
    this.cursor = index;
    this.draw();
    this.#positionTooltip();
  }

  #positionTooltip() {
    if (this.cursor === null || !this.data[this.cursor] || !this.plot) {
      this.tooltip.dataset.show = 'false';
      return;
    }
    this.tooltip.innerHTML = this.onFormatTooltip(this.data[this.cursor], this.cursor);
    this.tooltip.dataset.show = 'true';

    const { x, y } = this.anchorFor(this.cursor);
    const tw = this.tooltip.offsetWidth;
    const th = this.tooltip.offsetHeight;
    const maxX = this.container.clientWidth - tw - 4;
    this.tooltip.style.left = `${Math.max(4, Math.min(maxX, x - tw / 2))}px`;
    this.tooltip.style.top = `${Math.max(4, y - th - 12)}px`;
  }

  setData(data, meta = {}) {
    this.data = data ?? [];
    this.meta = meta;
    this.cursor = null;
    this.tooltip.dataset.show = 'false';
    const isEmpty = this.data.length === 0;
    this.canvas.hidden = isEmpty;
    if (this.empty) this.empty.hidden = !isEmpty;
    this.render();

    // A live chart refetches while the pointer may still be resting on it;
    // re-resolve the cursor so the tooltip does not blink out every poll.
    if (this.pointer && !isEmpty && this.plot) {
      this.setCursor(this.indexAt(this.pointer.x, this.pointer.y));
    }
  }

  render() {
    if (!this.data.length || this.canvas.hidden) return;
    this.draw();
    this.#positionTooltip();
  }

  destroy() {
    window.removeEventListener('resize', this._onResize);
    this._observer.disconnect();
  }
}

/**
 * Power over time: a 2px line over a soft fill, with a crosshair on hover.
 * One series, so the card title names it and no legend box is needed.
 */
export class TimeSeriesChart extends BaseChart {
  constructor(container, opts) {
    super(container, opts);
    this.formatX = opts.formatX;
    this.formatY = opts.formatY ?? ((v) => String(Math.round(v)));
  }

  indexAt(px) {
    const { x0, x1, tMin, tMax } = this.plot;
    const t = tMin + ((px - x0) / Math.max(1, x1 - x0)) * (tMax - tMin);
    // Nearest by time, so the hit area is the whole column, not the 2px line.
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < this.data.length; i += 1) {
      const d = Math.abs(this.data[i].t - t);
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }

  anchorFor(i) {
    const p = this.data[i];
    return { x: this.plot.sx(p.t), y: this.plot.sy(p.w) };
  }

  draw() {
    const { ctx, w, h } = sizeCanvas(this.canvas);
    const data = this.data;

    const tMin = data[0].t;
    const tMax = Math.max(data[data.length - 1].t, tMin + 1);
    const peak = Math.max(...data.map((d) => Math.max(d.w, d.peak ?? d.w)), 0);
    const { ticks, max: yMax } = niceTicks(0, peak || 1, 4);

    const x0 = PAD.left;
    const x1 = w - PAD.right;
    const y0 = h - PAD.bottom;
    const y1 = PAD.top;

    const sx = (t) => x0 + ((t - tMin) / (tMax - tMin)) * (x1 - x0);
    const sy = (v) => y0 - (v / (yMax || 1)) * (y0 - y1);
    this.plot = { x0, x1, y0, y1, tMin, tMax, yMax, sx, sy };

    const grid = token('--grid');
    const axis = token('--axis');
    const muted = token('--ink-muted');
    const series = token('--series-1');

    // Recessive solid hairline grid - never dashed.
    ctx.lineWidth = 1;
    ctx.strokeStyle = grid;
    ctx.fillStyle = muted;
    ctx.font = `11px ${token('--font') || 'system-ui'}`;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (const v of ticks) {
      if (v > yMax) continue;
      const y = Math.round(sy(v)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x0, y);
      ctx.lineTo(x1, y);
      ctx.stroke();
      ctx.fillText(this.formatY(v), x0 - 8, y);
    }

    // X labels, thinned until they stop colliding.
    const labels = this.formatX(tMin, tMax, data);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (const { t, text } of labels) {
      const x = sx(t);
      if (x < x0 - 1 || x > x1 + 1) continue;
      ctx.fillText(text, x, y0 + 8);
    }

    ctx.strokeStyle = axis;
    ctx.beginPath();
    ctx.moveTo(x0, y0 + 0.5);
    ctx.lineTo(x1, y0 + 0.5);
    ctx.stroke();

    // Peak envelope, so smoothing never hides a real spike.
    if (data.some((d) => (d.peak ?? 0) > d.w + 1)) {
      ctx.fillStyle = token('--series-1-faint');
      ctx.beginPath();
      ctx.moveTo(sx(data[0].t), y0);
      for (const d of data) ctx.lineTo(sx(d.t), sy(Math.max(d.peak ?? 0, d.w)));
      ctx.lineTo(sx(data[data.length - 1].t), y0);
      ctx.closePath();
      ctx.fill();
    }

    ctx.fillStyle = token('--series-1-soft');
    ctx.beginPath();
    ctx.moveTo(sx(data[0].t), y0);
    for (const d of data) ctx.lineTo(sx(d.t), sy(d.w));
    ctx.lineTo(sx(data[data.length - 1].t), y0);
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = series;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    data.forEach((d, i) => (i ? ctx.lineTo(sx(d.t), sy(d.w)) : ctx.moveTo(sx(d.t), sy(d.w))));
    ctx.stroke();

    if (this.cursor !== null && data[this.cursor]) {
      const p = data[this.cursor];
      const cx = sx(p.t);
      ctx.strokeStyle = axis;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(Math.round(cx) + 0.5, y1);
      ctx.lineTo(Math.round(cx) + 0.5, y0);
      ctx.stroke();

      // 2px surface ring rather than a border, per the mark spec.
      ctx.fillStyle = token('--surface');
      ctx.beginPath();
      ctx.arc(cx, sy(p.w), 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = series;
      ctx.beginPath();
      ctx.arc(cx, sy(p.w), 4, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

/**
 * Energy per bucket: one hue for every bar (the categories are nominal, so a
 * value-ramp would burn the colour channel on information the length already
 * carries). The largest bar is direct-labelled; the rest live in the tooltip
 * and the table view.
 */
export class BarChart extends BaseChart {
  constructor(container, opts) {
    super(container, opts);
    this.formatValue = opts.formatValue ?? ((v) => String(Math.round(v)));
    // Ticks share one precision, chosen from the top of the scale - mixing
    // "0.00" with "20.0" down one axis reads as a rendering slip.
    this.formatAxis = opts.formatAxis ?? this.formatValue;
    this.formatLabel = opts.formatLabel ?? ((d) => d.key);
  }

  indexAt(px) {
    const { x0, step } = this.plot;
    return Math.max(0, Math.min(this.data.length - 1, Math.floor((px - x0) / step)));
  }

  anchorFor(i) {
    const { x0, step, sy } = this.plot;
    return { x: x0 + step * (i + 0.5), y: sy(this.data[i].value) };
  }

  draw() {
    const { ctx, w, h } = sizeCanvas(this.canvas);
    const data = this.data;

    const peak = Math.max(...data.map((d) => d.value), 0);
    const { ticks, max: yMax } = niceTicks(0, peak || 1, 4);

    const x0 = PAD.left;
    const x1 = w - PAD.right;
    const y0 = h - PAD.bottom;
    const y1 = PAD.top;

    const step = (x1 - x0) / data.length;
    const GAP = 2; // surface gap between adjacent bars, not a border
    const barW = Math.max(1, Math.min(46, step - GAP * 2));
    const sy = (v) => y0 - (v / (yMax || 1)) * (y0 - y1);
    this.plot = { x0, x1, y0, y1, step, sy };

    const muted = token('--ink-muted');
    ctx.lineWidth = 1;
    ctx.strokeStyle = token('--grid');
    ctx.fillStyle = muted;
    ctx.font = `11px ${token('--font') || 'system-ui'}`;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (const v of ticks) {
      if (v > yMax) continue;
      const y = Math.round(sy(v)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x0, y);
      ctx.lineTo(x1, y);
      ctx.stroke();
      ctx.fillText(this.formatAxis(v, yMax), x0 - 8, y);
    }

    const series = token('--series-1');
    let peakIndex = 0;
    data.forEach((d, i) => {
      if (d.value > data[peakIndex].value) peakIndex = i;
      const cx = x0 + step * (i + 0.5);
      const top = sy(d.value);
      ctx.fillStyle = this.cursor === i ? series : series;
      ctx.globalAlpha = this.cursor === null || this.cursor === i ? 1 : 0.55;
      // 4px rounded data-end, anchored square to the baseline.
      roundedTopRect(ctx, cx - barW / 2, top, barW, y0 - top, 4);
      ctx.globalAlpha = 1;
    });

    ctx.strokeStyle = token('--axis');
    ctx.beginPath();
    ctx.moveTo(x0, y0 + 0.5);
    ctx.lineTo(x1, y0 + 0.5);
    ctx.stroke();

    // Thin x labels until they fit; always keep the first and last.
    ctx.fillStyle = muted;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const every = Math.max(1, Math.ceil((data.length * 58) / Math.max(1, x1 - x0)));
    data.forEach((d, i) => {
      if (i % every !== 0 && i !== data.length - 1) return;
      ctx.fillText(this.formatLabel(d), x0 + step * (i + 0.5), y0 + 8);
    });

    // Selective direct label: the extreme only, never a number on every bar.
    if (data.length > 1 && data[peakIndex].value > 0) {
      const cx = x0 + step * (peakIndex + 0.5);
      const top = sy(data[peakIndex].value);
      ctx.fillStyle = token('--ink-2');
      ctx.font = `600 11px ${token('--font') || 'system-ui'}`;
      ctx.textBaseline = 'bottom';
      ctx.fillText(this.formatAxis(data[peakIndex].value, yMax), cx, top - 5);
    }
  }
}
