import { TimeSeriesChart, BarChart } from './chart.js';

const LIVE_POLL_MS = 5000;
const $ = (id) => document.getElementById(id);

const state = {
  tab: 'live',
  range: '24h',
  period: 'day',
  timeZone: 'UTC',
  lastLive: null,
};

const RANGES = {
  '6h': 6 * 3600,
  '24h': 24 * 3600,
  '7d': 7 * 86400,
  '30d': 30 * 86400,
  '90d': 90 * 86400,
  '1y': 365 * 86400,
};

// ------------------------------------------------------------- formatting --

const nf = (digits) => new Intl.NumberFormat(undefined, {
  minimumFractionDigits: digits, maximumFractionDigits: digits,
});

function watts(v) {
  if (v === null || v === undefined || !Number.isFinite(v)) return '–';
  return nf(0).format(Math.round(v));
}

function kwh(v) {
  if (!Number.isFinite(v)) return '–';
  const k = v / 1000;
  return nf(k >= 100 ? 0 : k >= 10 ? 1 : 2).format(k);
}

/** Every tick on one axis shares the precision the largest tick needs. */
function kwhAxis(v, scaleMax) {
  const top = (scaleMax ?? v) / 1000;
  return nf(top >= 100 ? 0 : top >= 10 ? 1 : 2).format(v / 1000);
}

function timeFmt(opts) {
  return new Intl.DateTimeFormat(undefined, { timeZone: state.timeZone, ...opts });
}

const fmtClock = () => timeFmt({ hour: '2-digit', minute: '2-digit', hour12: false });
const fmtDayShort = () => timeFmt({ day: 'numeric', month: 'short' });
const fmtFull = () => timeFmt({
  day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
});

function ago(seconds) {
  if (seconds === null || seconds === undefined) return 'never';
  if (seconds < 60) return `${Math.max(0, Math.round(seconds))}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} h ago`;
  return `${Math.round(seconds / 86400)} d ago`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// -------------------------------------------------------------- transport --

let errorShown = false;

async function getJson(path, params) {
  const url = new URL(path, window.location.href);
  for (const [k, v] of Object.entries(params ?? {})) {
    if (v !== undefined && v !== null) url.searchParams.set(k, v);
  }
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  }
  return res.json();
}

function showError(err) {
  errorShown = true;
  $('error').hidden = false;
  $('error').innerHTML = `<strong>Cannot reach the server.</strong> ${escapeHtml(err.message)}`;
}

function clearError() {
  if (!errorShown) return;
  errorShown = false;
  $('error').hidden = true;
}

// ----------------------------------------------------------- x-axis ticks --

/** Time labels at a density the axis can actually hold. */
function timeLabels(tMin, tMax) {
  const span = tMax - tMin;
  const out = [];
  const push = (t, fmt) => out.push({ t, text: fmt.format(new Date(t * 1000)) });

  if (span <= 3 * 86400) {
    const stepHours = span <= 4 * 3600 ? 1 : span <= 12 * 3600 ? 2 : span <= 36 * 3600 ? 4 : 12;
    const step = stepHours * 3600;
    const fmt = span <= 36 * 3600 ? fmtClock() : fmtFull();
    for (let t = Math.ceil(tMin / step) * step; t <= tMax; t += step) push(t, fmt);
  } else {
    const days = Math.ceil(span / 86400);
    const stepDays = days <= 10 ? 1 : days <= 45 ? 7 : days <= 200 ? 30 : 90;
    const step = stepDays * 86400;
    const fmt = fmtDayShort();
    for (let t = Math.ceil(tMin / step) * step; t <= tMax; t += step) push(t, fmt);
  }
  return out;
}

// ------------------------------------------------------------------ charts --

const liveChart = new TimeSeriesChart($('liveChart'), {
  formatX: timeLabels,
  formatY: (v) => watts(v),
  onFormatTooltip: (p) => `
    <div class="t-title">${fmtClock().format(new Date(p.t * 1000))}</div>
    <div class="t-row"><span>Output</span><span class="t-val">${watts(p.w)} W</span></div>
    ${p.peak > p.w + 1 ? `<div class="t-row"><span>Peak</span><span class="t-val">${watts(p.peak)} W</span></div>` : ''}
  `,
});

const historyChart = new TimeSeriesChart($('historyChart'), {
  formatX: timeLabels,
  formatY: (v) => watts(v),
  onFormatTooltip: (p) => `
    <div class="t-title">${fmtFull().format(new Date(p.t * 1000))}</div>
    <div class="t-row"><span>Average</span><span class="t-val">${watts(p.w)} W</span></div>
    ${p.peak > p.w + 1 ? `<div class="t-row"><span>Peak</span><span class="t-val">${watts(p.peak)} W</span></div>` : ''}
    ${p.wh ? `<div class="t-row"><span>Energy</span><span class="t-val">${kwh(p.wh)} kWh</span></div>` : ''}
  `,
});

const summaryChart = new BarChart($('summaryChart'), {
  formatValue: (v) => kwh(v),
  formatAxis: kwhAxis,
  formatLabel: (d) => d.shortLabel,
  onFormatTooltip: (d) => `
    <div class="t-title">${escapeHtml(d.longLabel)}</div>
    <div class="t-row"><span>Generated</span><span class="t-val">${kwh(d.value)} kWh</span></div>
    <div class="t-row"><span>Peak</span><span class="t-val">${watts(d.peakWatts)} W</span></div>
    ${d.days > 1 ? `<div class="t-row"><span>Daily avg</span><span class="t-val">${kwh(d.value / d.days)} kWh</span></div>` : ''}
  `,
});

// --------------------------------------------------------------- live view --

async function refreshLive() {
  try {
    const live = await getJson('/api/live');
    clearError();
    state.timeZone = live.timeZone;
    state.lastLive = live;

    const pill = $('statusPill');
    pill.dataset.state = live.state;
    $('statusText').textContent = {
      live: 'Receiving data',
      stale: 'No recent data',
      offline: 'Egate not connected',
    }[live.state];

    $('nowW').textContent = watts(live.smoothedWatts ?? live.watts);
    $('nowSub').textContent = live.at
      ? `${watts(live.watts)} W latest · ${ago(live.ageSeconds)}`
      : 'Waiting for the first reading';

    $('todayKwh').textContent = kwh(live.today.wh);
    $('todaySub').textContent = live.today.firstAt
      ? `Since ${fmtClock().format(new Date(live.today.firstAt * 1000))}`
      : 'Nothing generated yet today';

    $('peakW').textContent = watts(live.today.peakWatts);
    $('peakSub').textContent = live.today.peakAt
      ? `At ${fmtClock().format(new Date(live.today.peakAt * 1000))}`
      : ' ';

    renderInverters(live.inverters);
  } catch (err) {
    showError(err);
    $('statusPill').dataset.state = 'offline';
    $('statusText').textContent = 'Server unreachable';
  }
}

function renderInverters(inverters) {
  const host = $('inverterBars');
  const empty = $('inverterEmpty');
  if (!inverters.length) {
    host.innerHTML = '';
    empty.hidden = false;
    return;
  }
  empty.hidden = true;
  const max = Math.max(...inverters.map((i) => i.wh), 1);
  host.innerHTML = inverters
    .slice()
    .sort((a, b) => b.wh - a.wh)
    .map((i) => `
      <div class="bar-row">
        <span class="name" title="Serial ${escapeHtml(i.serial)}">${escapeHtml(i.label ?? i.serial)}</span>
        <span class="track"><span class="fill" style="width:${Math.max(1, (i.wh / max) * 100)}%"></span></span>
        <span class="val">${kwh(i.wh)}<span class="unit"> kWh</span></span>
      </div>`)
    .join('');
}

async function refreshLiveChart() {
  const to = Math.floor(Date.now() / 1000);
  try {
    const data = await getJson('/api/series', { from: to - 2 * 3600, to, resolution: 'sample' });
    state.timeZone = state.lastLive?.timeZone ?? state.timeZone;
    liveChart.setData(data.points);
  } catch { /* the live tile already surfaces connectivity problems */ }
}

// ------------------------------------------------------------ history view --

async function refreshHistory() {
  const wrap = $('historyChart');
  wrap.classList.add('loading'); // hold the old render, no skeleton flash
  const to = Math.floor(Date.now() / 1000);
  const from = to - RANGES[state.range];

  try {
    const data = await getJson('/api/series', { from, to });
    clearError();
    historyChart.setData(data.points);

    const grain = {
      sample: `${Math.round(data.bucketSeconds / 60) || 1}-minute averages`,
      hour: 'hourly averages',
      day: 'daily averages',
    }[data.resolution];
    $('historyNote').textContent = `${data.points.length} points · ${grain}`;

    renderHistoryTable(data);
  } catch (err) {
    showError(err);
  } finally {
    wrap.classList.remove('loading');
  }
}

function renderHistoryTable(data) {
  const rows = data.points.slice(-500).reverse();
  $('historyTable').innerHTML = `
    <table>
      <caption class="visually-hidden">Array output over the selected range</caption>
      <thead><tr><th>Time</th><th>Average W</th><th>Peak W</th></tr></thead>
      <tbody>${rows.map((p) => `
        <tr>
          <td>${fmtFull().format(new Date(p.t * 1000))}</td>
          <td>${watts(p.w)}</td>
          <td>${watts(p.peak ?? p.w)}</td>
        </tr>`).join('')}
      </tbody>
    </table>`;
}

// ----------------------------------------------------------- summary view --

function bucketLabels(bucket, period) {
  const d = new Date(`${bucket.from}T12:00:00Z`);
  if (period === 'day') {
    return {
      shortLabel: fmtDayShort().format(d),
      longLabel: new Intl.DateTimeFormat(undefined, { dateStyle: 'full' }).format(d),
    };
  }
  if (period === 'week') {
    const end = new Date(`${bucket.to}T12:00:00Z`);
    return {
      shortLabel: fmtDayShort().format(d),
      longLabel: `${bucket.key} · ${fmtDayShort().format(d)} – ${fmtDayShort().format(end)}`,
    };
  }
  const monthFmt = new Intl.DateTimeFormat(undefined, { month: 'short', year: '2-digit' });
  const longFmt = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' });
  return { shortLabel: monthFmt.format(d), longLabel: longFmt.format(d) };
}

async function refreshSummary() {
  const wrap = $('summaryChart');
  wrap.classList.add('loading');
  const limit = { day: 30, week: 26, month: 24 }[state.period];

  try {
    const data = await getJson('/api/summary', { period: state.period, limit });
    clearError();

    const bars = data.buckets.map((b) => ({
      ...b,
      ...bucketLabels(b, data.period),
      value: b.wh,
    }));

    $('summaryTitle').textContent = {
      day: 'Energy per day', week: 'Energy per week', month: 'Energy per month',
    }[data.period];

    const total = data.total.wh;
    const best = data.total.best;
    $('summaryNote').textContent = bars.length
      ? `${kwh(total)} kWh total · best ${kwh(best.wh)} kWh`
      : '';

    summaryChart.setData(bars);
    renderSummaryTable(bars, data.period, total);
  } catch (err) {
    showError(err);
  } finally {
    wrap.classList.remove('loading');
  }
}

function renderSummaryTable(bars, period, total) {
  const head = { day: 'Day', week: 'Week', month: 'Month' }[period];
  $('summaryTable').innerHTML = `
    <table>
      <caption class="visually-hidden">Generated energy per ${period}</caption>
      <thead><tr>
        <th>${head}</th><th>kWh</th><th>Peak W</th>${period === 'day' ? '' : '<th>Days</th><th>kWh/day</th>'}
      </tr></thead>
      <tbody>${bars.slice().reverse().map((b) => `
        <tr>
          <td>${escapeHtml(b.longLabel)}</td>
          <td>${kwh(b.wh)}</td>
          <td>${watts(b.peakWatts)}</td>
          ${period === 'day' ? '' : `<td>${b.days}</td><td>${kwh(b.wh / b.days)}</td>`}
        </tr>`).join('')}
      </tbody>
      <tfoot><tr>
        <td>Total</td><td>${kwh(total)}</td><td></td>
        ${period === 'day' ? '' : '<td></td><td></td>'}
      </tr></tfoot>
    </table>`;
}

// ---------------------------------------------------------------- chrome --

async function refreshFooter() {
  try {
    const s = await getJson('/api/status');
    const db = s.database;
    const parts = [
      `${s.listenPorts.join(', ')} · ${s.connections} connection${s.connections === 1 ? '' : 's'}`,
      `${s.framesReceived.toLocaleString()} frames`,
      `${db.days} days stored · ${(db.sizeBytes / 1e6).toFixed(1)} MB`,
      `up ${Math.floor(s.uptimeSeconds / 3600)}h ${Math.floor((s.uptimeSeconds % 3600) / 60)}m`,
      s.timeZone,
    ];
    if (s.unlabelledSerials.length) {
      parts.push(`unlabelled inverters: ${s.unlabelledSerials.join(', ')}`);
    }
    $('footer').innerHTML = parts.map((p) => `<span>${escapeHtml(p)}</span>`).join('');
  } catch { /* footer is decoration; the error banner covers real outages */ }
}

function selectTab(name) {
  state.tab = name;
  for (const id of ['live', 'history', 'summary']) {
    $(`tab-${id}`).setAttribute('aria-selected', String(id === name));
    $(`panel-${id}`).hidden = id !== name;
  }
  if (name === 'live') refreshLiveChart();
  if (name === 'history') refreshHistory();
  if (name === 'summary') refreshSummary();
}

function toggleTable(btn, el, chartWrap) {
  const showing = btn.getAttribute('aria-pressed') === 'true';
  btn.setAttribute('aria-pressed', String(!showing));
  el.hidden = showing;
  chartWrap.hidden = !showing;
}

function applyTheme(mode) {
  if (mode === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', mode);
  try { localStorage.setItem('theme', mode); } catch { /* private mode */ }
}

function initTheme() {
  let saved = 'system';
  try { saved = localStorage.getItem('theme') ?? 'system'; } catch { /* private mode */ }
  applyTheme(saved);
  $('themeBtn').addEventListener('click', () => {
    const order = ['system', 'light', 'dark'];
    let current = 'system';
    try { current = localStorage.getItem('theme') ?? 'system'; } catch { /* ignore */ }
    applyTheme(order[(order.indexOf(current) + 1) % order.length]);
  });
}

function wireFilters() {
  $('rangeFilters').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-range]');
    if (!btn) return;
    state.range = btn.dataset.range;
    for (const b of $('rangeFilters').querySelectorAll('button')) {
      b.setAttribute('aria-pressed', String(b === btn));
    }
    refreshHistory();
  });

  $('periodFilters').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-period]');
    if (!btn) return;
    state.period = btn.dataset.period;
    for (const b of $('periodFilters').querySelectorAll('button')) {
      b.setAttribute('aria-pressed', String(b === btn));
    }
    refreshSummary();
  });

  for (const id of ['live', 'history', 'summary']) {
    $(`tab-${id}`).addEventListener('click', () => selectTab(id));
  }

  $('historyTableBtn').addEventListener('click', (e) => toggleTable(
    e.currentTarget, $('historyTable'), $('historyChart'),
  ));
  $('summaryTableBtn').addEventListener('click', (e) => toggleTable(
    e.currentTarget, $('summaryTable'), $('summaryChart'),
  ));
}

async function monthToDate() {
  try {
    const data = await getJson('/api/summary', { period: 'month', limit: 1 });
    const m = data.buckets.at(-1);
    $('monthKwh').textContent = m ? kwh(m.wh) : '0';
    $('monthSub').textContent = m ? `${m.days} day${m.days === 1 ? '' : 's'} recorded` : 'No data yet';
  } catch { /* covered by the error banner */ }
}

async function init() {
  initTheme();
  wireFilters();

  await refreshLive();
  await Promise.all([refreshLiveChart(), monthToDate(), refreshFooter()]);

  setInterval(refreshLive, LIVE_POLL_MS);
  setInterval(() => {
    // Only the visible tab refetches; a hidden page stops polling entirely.
    if (document.hidden) return;
    if (state.tab === 'live') refreshLiveChart();
  }, LIVE_POLL_MS * 2);
  setInterval(() => {
    if (document.hidden) return;
    monthToDate();
    refreshFooter();
  }, 60_000);

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refreshLive();
  });
}

init();
