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

## Deploying

Published images live at `ghcr.io/emilbm/involar-monitor`, built and smoke-tested
by CI on every push to `master`. The target host needs Docker, this compose
file, and a `.env` - no source checkout, no build step, no git.

On a fresh Debian VM:

```bash
curl -fsSL https://get.docker.com | sudo sh
```

```bash
sudo usermod -aG docker $USER && newgrp docker
```

```bash
mkdir -p ~/involar-monitor && cd ~/involar-monitor
```

```bash
curl -fsSLO https://raw.githubusercontent.com/emilbm/involar-monitor/master/compose.yaml
```

```bash
curl -fsSL https://raw.githubusercontent.com/emilbm/involar-monitor/master/.env.example -o .env
```

Set `TZ` in `.env` - everything else has a working default. Then:

```bash
docker compose up -d
```

Open **http://\<vm-ip\>:8080**. It will show zeros until the Egate finds it;
see [Pointing the Egate at this host](#pointing-the-egate-at-this-host).

`restart: unless-stopped` plus Docker's own systemd unit means it comes back
after a reboot. Confirm rather than assume:

```bash
systemctl is-enabled docker && docker inspect -f '{{.HostConfig.RestartPolicy.Name}}' involar-monitor
```

### Updating

```bash
docker compose pull && docker compose up -d
```

The database lives in a named volume, so this never touches your history. To
decide when you move instead of tracking `master`, pin a release in
`compose.yaml`:

```yaml
image: ghcr.io/emilbm/involar-monitor:3.0.0
```

Rolling back is then a tag change and `docker compose up -d`.

### Ports and firewall

Three inbound ports, all of which should stay on the LAN:

| Port | From | Why |
|---|---|---|
| 1020/tcp | the Egate | where it connects; the name and port are hardcoded in its firmware |
| 9800/tcp | the Egate | some units use this instead - harmless to leave open |
| 8080/tcp | your browser | dashboard and JSON API |

The app makes **no outbound connections at all** - nothing leaves the house.
The VM only needs outbound HTTPS for `docker compose pull` and apt.

**Do not forward any of these from the internet.** The dashboard has no
authentication, and the Egate listener speaks an unauthenticated protocol from
a defunct vendor. If you want access from outside, use a VPN into the LAN, or
put a reverse proxy with auth in front of 8080 - not a port forward.

If you have not enabled a host firewall, there is nothing to configure: the VM
sits behind NAT and Docker publishes the ports itself. If you *have* enabled
`ufw`, know that **Docker bypasses it** - published ports are DNAT'd in the
`DOCKER` chain, which is traversed before ufw's rules, so `ufw deny 8080` does
nothing. The supported hook is the `DOCKER-USER` chain. To restrict the
dashboard to your LAN subnet:

```bash
sudo iptables -I DOCKER-USER -p tcp --dport 8080 ! -s 192.168.1.0/24 -j DROP
```

Persist it with `iptables-persistent`, and adjust the subnet to match yours.

The simpler alternative, if you just want the dashboard off other interfaces,
is to bind the published port to one address in `compose.yaml`:

```yaml
- "192.168.1.50:8080:8080"
```

Proxmox's own firewall (Datacenter / Node / VM → Firewall) is off by default.
If you have turned it on, the three ports above need allow rules there too.

### Building from source instead

Only if you have the checkout and want to run your own changes:

```bash
docker compose -f compose.yaml -f compose.build.yaml up -d --build
```

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

## Error reporting

Optional, off unless you set a DSN. It speaks the Sentry envelope protocol
directly, which is what GlitchTip ingests, so there is no SDK and the project
keeps its zero dependencies.

```dotenv
SENTRY_DSN=https://<key>@glitchtip.example.com/<project-id>
SENTRY_ENVIRONMENT=production
SENTRY_RELEASE=3.0.0
```

A malformed DSN fails at startup with a specific message rather than quietly
dropping errors for weeks. With no DSN the reporter is an inert no-op - nothing
is sent and no connection is attempted.

Reported automatically: uncaught exceptions, unhandled promise rejections,
startup failures, and any 5xx from the dashboard or API. Each event carries the
stack trace, release, environment, hostname and - for HTTP errors - the route.

### Testing it

`GET /throw` raises a real exception inside the request handler, so it
exercises the whole path rather than fabricating an event:

```bash
curl -s http://<vm-ip>:8080/throw
```

```json
{"error":"Test exception from /throw - error reporting is wired up",
 "eventId":"b4f333d0d7f6477eae8f26cad7c184d6"}
```

That `eventId` is searchable in GlitchTip, so you can confirm the round trip.
The process is unaffected - the handler catches, reports, and answers 500.

Whether reporting is working at all is visible without causing an error:

```bash
curl -s localhost:8080/api/status | jq .errorReporting
```

`sent`, `dropped` and `failed` counters tell you if events are leaving.

### Deliberate limits

Reporting can never take the service down. An unreachable server, a rejected
event or a malformed DSN is logged and forgotten - never thrown, never retried
into a storm. Events are capped at `SENTRY_MAX_EVENTS_PER_MINUTE` (30), and a
429 mutes reporting for as long as the server's `Retry-After` says.

The cost of going SDK-free is no breadcrumbs, no automatic instrumentation and
no source context on frames - you get the exception, its cause chain, and the
stack. For a service this size that is the part that matters.

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
| `GET /api/status` | uptime, frame counts, database and error-reporting stats |
| `GET /throw` | raises a test exception, to verify error reporting |
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

### Releases

CI publishes `ghcr.io/emilbm/involar-monitor` on every push to `master`
(`:latest` plus `:sha-<commit>`), after running the tests and smoke-testing the
built image. Tagging cuts a version:

```bash
git tag v3.1.0 && git push origin v3.1.0
```

That adds `:3.1.0` and `:3.1`, which is what a pinned deployment follows.

## Credits

Original implementation and Egate protocol decoding by
[m4rtinvdbij](https://github.com/m4rtinvdbij/involar2pvoutput), with thanks to
Ad Boerma for working out the Egate message format and scaling factors.

## License

MIT — see [LICENSE](LICENSE).
