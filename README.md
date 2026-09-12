# involar2pvoutput

Receives telemetry from an Involar/Sedas **Egate** solar gateway and forwards it
to [PVOutput.org](https://pvoutput.org).

Involar is gone and the service the Egate talks to no longer exists. The Egate
has `involar.com` hardcoded, so you point that name at a box on your own LAN
using a DNS override, and this service answers in Involar's place.

```
 Egate ──TCP 1020/9800──▶ [ DNS override ] ──▶ involar2pvoutput ──HTTPS──▶ PVOutput.org
```

---

## Quick start (Docker)

On the Debian VM:

```bash
git clone https://github.com/emilbm/involar2pvoutput.git
cd involar2pvoutput
cp .env.example .env
```

Edit `.env` and set at minimum `PVOUTPUT_API_KEY`, `PVOUTPUT_SYSTEM_ID` and
`TZ`. Then:

```bash
docker compose up -d --build
```

Watch it come up:

```bash
docker compose logs -f
```

Check its state at any time:

```bash
curl -s localhost:8080 | jq
```

### First run, before you trust it

Set `PVOUTPUT_DRY_RUN=true` and `LOG_LEVEL=debug` in `.env`. Everything runs
normally but nothing is uploaded — the log shows exactly what *would* be sent,
and which inverter serials the Egate is reporting. Flip it back to `false` once
the numbers look right.

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

The container runs as a non-root user, which cannot bind ports below 1024.
So the host publishes the well-known ports and the app listens high inside:

```yaml
ports:
  - "1020:11020"
  - "9800:19800"
```

The Egate still connects to port 1020 on the VM. If you change `LISTEN_PORTS`,
change the right-hand side of these mappings to match.

---

## Configuration

Everything is set through environment variables — see [`.env.example`](.env.example)
for the annotated list. The ones that matter most:

| Variable | Default | Notes |
|---|---|---|
| `PVOUTPUT_API_KEY` | — | Required. pvoutput.org → Settings → API Settings. |
| `PVOUTPUT_SYSTEM_ID` | — | Required. Numeric System Id of the whole array. |
| `TZ` | `Europe/Amsterdam` | **Set this.** PVOutput records local wall-clock time. |
| `PVOUTPUT_POST_INTERVAL_SECONDS` | `300` | How often the array power is published. |
| `PVOUTPUT_RATE_LIMIT_PER_HOUR` | `60` | 60 free, 300 donator. The uploader paces itself to fit. |
| `PVOUTPUT_DRY_RUN` | `false` | Log uploads instead of sending them. |
| `LOG_LEVEL` | `info` | `debug` shows every decoded frame. |

Bad configuration fails at startup with a specific message, rather than at the
first upload hours later.

### Per-inverter output (optional)

If you have a PVOutput system per micro-inverter, map the last four hex digits
of each serial to its system id:

```dotenv
PVOUTPUT_MICROINVERTER_MODE=true
PVOUTPUT_MICROINVERTER_MAPPING=1a2b=11111,3c4d=22222
```

Run once with `LOG_LEVEL=debug` and the serials the Egate reports show up in the
log, including any that have no mapping yet.

**Mind the rate limit.** Each mapped inverter costs one request per cycle. With
the defaults (array every 5 min, inverters every 15 min) seven inverters comes
to 12 + 28 = 40 requests/hour, inside the free-tier 60. Raise
`PVOUTPUT_MICROINVERTER_INTERVAL_SECONDS` if you have more.

---

## Operating it

**Status endpoint** — `GET http://<vm>:8080` returns connection count, frames
received, last frame time, upload queue depth, remaining rate-limit budget and
the last error. The Docker `HEALTHCHECK` uses it.

Health deliberately means *"the listeners are up"*, nothing more. Solar output
stops every night; tying health to recent telemetry would restart-loop the
container after dark. Use `lastStatusAt` in the JSON body to spot a silent Egate.

**Persistence** — the retry queue lives in the `involar-data` volume, so a
restart, a reboot or a `docker compose pull` never drops buffered readings.

**Frame logging** — set `RAW_LOG=true` to append every frame as hex to
`/app/data/frames.log` for decoding work. It rotates at 5 MB × 3 files. Off by
default; v1 wrote these files unbounded until the disk filled.

**Updating**

```bash
git pull && docker compose up -d --build
```

---

## Reliability notes

This rework fixes a set of problems in v1 that would have bitten you on a
long-running box:

- **Both ports now bind.** v1 called `listen()` twice on one `net.Server`, which
  throws `ERR_SERVER_ALREADY_LISTEN`; port 9800 never came up.
- **TCP is treated as a stream.** v1 assumed one `data` event was one message
  and guessed the message type from the event's length. A detail dump split
  across segments was mis-parsed. Frames are now reassembled on 32-byte
  boundaries and classified by their type byte.
- **Uploads are paced and retried.** v1 posted on *every* status frame — far past
  PVOutput's 60 req/hour limit — and only `console.log`ged the response, so
  failures were invisible. Readings are now averaged over a window, published on
  a fixed cadence, queued durably, retried with exponential backoff, batched via
  `addbatchstatus` when a backlog exists, and paused when PVOutput's rate-limit
  headers say to stop.
- **Retries keep the reading's own timestamp**, so a recovered outage back-fills
  correctly instead of stacking everything at the recovery time.
- **The rolling average is correct.** v1 pruned with `splice()` inside a
  `forEach()`, which skips elements.
- **Serials with hex letters work.** v1's `if (serial > 0)` is `NaN > 0` for a
  serial like `1a2b`, silently dropping those inverters.
- **The process stays up.** The relay socket had no `error` handler, so an
  unreachable Involar host crashed the process on an unhandled `'error'` event.
  Idle connections are now reaped, listeners survive stray socket errors, and a
  genuine crash exits cleanly so Docker restarts it.
- **Nothing grows without bound** — frame logs rotate, container logs are capped,
  and the upload queue has a size and age limit.
- **No dependencies.** `request` and `moment` are both unmaintained; the app now
  uses built-in `fetch` and `Intl`. Zero `node_modules`, nothing to audit.
- **Secrets are out of the repo.** v1 kept the API key in a tracked `config.js`.

## Development

Requires Node 20+. No dependencies to install.

```bash
npm test
```

Run against a simulated Egate without any hardware:

```bash
PVOUTPUT_DRY_RUN=true LOG_LEVEL=debug LISTEN_PORTS=11020 node src/index.js
node test/tools/fake-egate.js 127.0.0.1 11020
```

The simulator deliberately splits a detail dump mid-frame to exercise the stream
reassembly.

## Credits

Original implementation and Egate protocol decoding by
[m4rtinvdbij](https://github.com/m4rtinvdbij/involar2pvoutput), with thanks to
Ad Boerma for working out the Egate message format and scaling factors.

## License

MIT — see [LICENSE](LICENSE).
