# involar-monitor

Receives telemetry from an Involar/Sedas **Egate** solar gateway, stores it
locally, and serves a dashboard for it.

Involar is gone and the service the Egate talks to no longer exists. The Egate
has `involar.com` hardcoded, so you point that name at a box on your own LAN
using a DNS override, and this service answers in Involar's place.

```
 Egate ──TCP 1020/9800──▶ [ DNS override ] ──▶ involar-monitor ──▶ SQLite ──▶ dashboard :8080
```

Nothing leaves the house and there are no accounts, keys, or third-party
services involved.

---

## Quick start (Docker)

On the Debian VM:

```bash
git clone https://github.com/emilbm/involar-monitor.git
cd involar-monitor
cp .env.example .env
```

Set `TZ` in `.env` (everything else has a working default), then:

```bash
docker compose up -d --build
```

Open **http://\<vm-ip\>:8080**. Follow the logs with `docker compose logs -f`.

---

## The dashboard

Three views, plus a row of stat tiles that is always visible (current output,
today's energy, today's peak, month to date).

**Live** — current output with a two-hour chart that refreshes every five
seconds, and each micro-inverter's contribution today. The "Now" figure is a
short rolling mean, which is far steadier to read than the raw reading; the raw
one is shown underneath it.

**History** — output over 6 hours to a year. The resolution switches itself:
raw samples under three days, hourly means out to ninety, daily beyond that.
Each point carries its bucket's peak as well as its mean, so smoothing never
hides a real spike.

**Summaries** — energy per day, week or month. Weeks are ISO weeks, starting
Monday.

Every chart has a hover tooltip, arrow-key navigation, and a **Table** toggle
that shows the same numbers as text.

---

## Pointing the Egate at this host

The Egate resolves `involar.com` / `involar.net` (some units use
`data.involar.com` / `data.involar.net`) and connects on TCP 1020.

1. In your DNS server — Pi-hole, AdGuard Home, OPNsense/pfSense Unbound, or your
   router — add A records for all four names pointing at the Debian VM's IP.
2. Make sure the LAN actually uses that DNS server (DHCP option 6).
3. Power-cycle the Egate and watch `docker compose logs -f` for
   `Egate connected`.

If nothing connects, confirm the override works from another machine:

```bash
dig +short involar.com @<your-dns-ip>
```

### Why ports are mapped 1020→11020

The container runs as a non-root user, which cannot bind ports below 1024. So
the host publishes the well-known ports and the app listens high inside:

```yaml
ports:
  - "1020:11020"
  - "9800:19800"
```

The Egate still connects to port 1020 on the VM. If you change `LISTEN_PORTS`,
change the right-hand side of these mappings to match.

---

## Storage

Everything lives in one SQLite file, `solar.db`, in the `solar-data` volume.

| Table | What it holds | Kept |
|---|---|---|
| `samples` | one row per reading the Egate sends | `SAMPLE_RETENTION_DAYS` (400) |
| `hourly` | mean, peak and energy per hour | forever |
| `daily` | energy, peak and peak time per day | forever |
| `inverter_daily` | each micro-inverter's daily total | forever |

The rollups are maintained as readings arrive, not recomputed on read, so a
year-long chart is as fast as an hour-long one — and long-range history stays
readable after the raw samples are pruned.

Energy is integrated trapezoidally between consecutive readings. A gap longer
than `ENERGY_MAX_GAP_SECONDS` (15 minutes) contributes nothing, so an outage or
the overnight silence can never invent generation that did not happen.

Any wattage the Egate reports is stored exactly as received. This is one
household's own array; there is nothing to filter against.

The database runs in WAL mode with `synchronous=NORMAL`, which is the right
trade for data that is nice to have rather than a ledger: fast writes, and a
hard power cut at the wrong moment costs you recent history, never the live
readings.

To back it up, use SQLite's own backup API rather than copying the file - a
plain copy of a live WAL database can be inconsistent. Nothing has to stop:

```bash
docker compose exec solar node src/backup.js
```

That writes `solar-backup-YYYY-MM-DD.db` next to the database, inside the
volume. To pull a copy out to the host:

```bash
docker compose cp solar:/app/data/solar-backup-$(date +%F).db .
```

---

## JSON API

The dashboard is a client of this; so can anything else on your LAN be
(Home Assistant, Grafana, a script).

| Endpoint | Returns |
|---|---|
| `GET /api/live` | current output, today's totals, per-inverter energy |
| `GET /api/series?from=&to=&resolution=` | power over time; `resolution` is `auto`, `sample`, `hour` or `day` |
| `GET /api/summary?period=&limit=` | energy per `day`, `week` or `month` |
| `GET /api/inverters?from=&to=` | per-inverter energy across a day range |
| `GET /api/status` | uptime, frame counts, database stats |
| `GET /health` | 200 while the listeners are up — the Docker healthcheck |

`from`/`to` are unix seconds on `/api/series`, and `YYYY-MM-DD` elsewhere.

```bash
curl -s localhost:8080/api/live | jq '.watts, .today.kwh'
```

**There is no authentication.** It is a LAN dashboard for your own generation
data. Do not forward port 8080 from the internet; put it behind a reverse proxy
with auth, or a VPN, if you want it from outside.

---

## Configuration

Everything is set through environment variables — see [`.env.example`](.env.example)
for the annotated list. The ones that matter:

| Variable | Default | Notes |
|---|---|---|
| `TZ` | `Europe/Amsterdam` | **Set this.** Day/week/month boundaries use it. |
| `SAMPLE_RETENTION_DAYS` | `400` | Raw samples only; rollups are kept forever. `0` keeps everything. |
| `WEB_PORT` | `8080` | Dashboard and API. |
| `LIVE_WINDOW_SECONDS` | `120` | Smoothing window for the "Now" figure. |
| `INVERTER_LABELS` | — | `1a2b=Roof south,3c4d=Garage` |
| `LOG_LEVEL` | `info` | `debug` logs every decoded frame. |

Bad configuration fails at startup with a specific message rather than hours
later.

### Naming your inverters

Unlabelled inverters appear under their 4-hex-digit serial, and the dashboard
footer lists any serial that has no label yet. Copy them into `INVERTER_LABELS`
and restart.

---

## Reliability notes

Carried over from the rework that containerised this, and still true:

- **Both ports bind.** The original called `listen()` twice on one `net.Server`,
  which throws `ERR_SERVER_ALREADY_LISTEN`; port 9800 never came up.
- **TCP is treated as a stream.** The original assumed one `data` event was one
  message and guessed the message type from the event's length, so a detail dump
  split across segments was mis-parsed. Frames are reassembled on 32-byte
  boundaries and classified by their type byte.
- **Serials with hex letters work.** The original's `if (serial > 0)` is
  `NaN > 0` for a serial like `1a2b`, silently dropping those inverters.
- **The process stays up.** The relay socket has an `error` handler (an
  unreachable host used to crash the process), idle connections are reaped,
  listeners survive stray socket errors, and a genuine crash exits cleanly so
  Docker restarts it.
- **Nothing grows without bound** — raw samples are pruned, frame logs rotate,
  container logs are capped.
- **No dependencies.** Built-in `node:sqlite`, `fetch` and `Intl`; zero
  `node_modules`, nothing to audit or update.

---

## Development

Requires Node 24+ (for `node:sqlite` without a flag). Nothing to install.

```bash
npm test
```

Run it against generated history, with no hardware and no waiting for sun:

```bash
node test/tools/seed.js 120 ./data/dev.db
DB_PATH=./data/dev.db TZ=Europe/Copenhagen npm start
```

Or drive it with a simulated Egate, which deliberately splits a detail dump
mid-frame to exercise the stream reassembly:

```bash
LISTEN_PORTS=11020 npm start
node test/tools/fake-egate.js 127.0.0.1 11020
```

## Credits

Original implementation and Egate protocol decoding by
[m4rtinvdbij](https://github.com/m4rtinvdbij/involar2pvoutput), with thanks to
Ad Boerma for working out the Egate message format and scaling factors.

## License

MIT — see [LICENSE](LICENSE).
