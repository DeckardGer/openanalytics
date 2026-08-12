# Self-hosting OpenAnalytics

Everything needed to run the whole product — tracker, ingest, worker, control
plane, query gateway, realtime stream and dashboard — on your own hardware.

Two ways in:

- **[Docker Compose](#docker-compose)** — the supported path. One generator
  script, one `docker compose up -d`, TLS issued automatically.
- **[From source](#running-from-source)** — for development, or for slotting the
  services into infrastructure you already run.

Requirements for the compose path: a Linux host with Docker and the Compose
plugin, four DNS records pointing at it, and about 4 GB of RAM. Everything else
is built from this repository.

---

## What you are actually running

| Piece           | Job                                                                | Public? |
| --------------- | ------------------------------------------------------------------ | ------- |
| `collector`     | Ingest: validates, sanitizes, rate-limits, enqueues                | yes     |
| `worker`        | Drains the queue into ClickHouse, sessions, rollups, mail, deletes | no      |
| `api`           | Control plane: auth, sites, keys, sharing, MCP                     | yes     |
| `query-gateway` | The only process allowed to read ClickHouse                        | no      |
| `realtime`      | The SSE stream behind the live dashboard                           | yes     |
| `web`           | The dashboard (Next.js)                                            | yes     |
| `oa.js`         | The browser tracker, served as a static file by the proxy          | yes     |

Stores: **Postgres** (control plane), **ClickHouse** (events and rollups),
**Valkey ×2** — one durable queue, one losable cache. They are two instances
rather than two databases on one, because they need opposite eviction policies
and one process cannot have both.

### Four names, and why it is four

| Name           | Serves              | Also                                |
| -------------- | ------------------- | ----------------------------------- |
| `app.<domain>` | the dashboard       |                                     |
| `api.<domain>` | the api             | OAuth callbacks, share links        |
| `c.<domain>`   | the collector       | **and `oa.js`**, from the same host |
| `rt.<domain>`  | the realtime stream |                                     |

`oa.js` lives beside the collector because it is what a site owner pastes into
their page: one host to point at, and one fewer certificate to own.

---

## Docker Compose

### 1. DNS first

Point all four names at the host. Certificates are issued by Let's Encrypt on
first start, and issuance fails without the records — Caddy will keep retrying,
but nothing is served on 443 until they resolve.

### 2. Generate the configuration

```sh
git clone https://github.com/OpenLabs-so/openanalytics
cd openanalytics/infra/selfhost
./generate-secrets.sh --domain analytics.example --email admin@analytics.example
```

That writes, in one pass so the values that must match actually do:

- `.env` — the four names and the compose network. No secrets.
- `env/*.env` — **one file per service**, with generated passwords.
- `docker-compose.override.yml` — three Ed25519 key pairs as YAML block
  scalars, split across the services entitled to each half.

All three are git-ignored. **Back them up off this machine before going
further** — see [Losing a secret](#losing-a-secret).

### 3. Bring it up

```sh
docker compose up -d
docker compose logs -f migrate     # schemas, both stores, from empty
docker compose ps                  # everything but migrate/tracker-build healthy
```

The first run builds seven images and takes a while. Order is enforced by the
compose file and is not cosmetic:

1. stores start and become healthy;
2. `migrate` runs Postgres migrations, then ClickHouse migrations, and exits;
3. every application service waits for that exit — a failed migration stops the
   deploy instead of producing a fleet of services against a half-built schema;
4. `tracker-build` compiles `oa.js` into a volume Caddy serves read-only;
5. Caddy starts and requests certificates.

Re-running `docker compose up -d` after a `git pull` is the upgrade path. Both
migration runners keep a ledger and apply only what is pending.

### 4. Claim it

Open `https://app.<domain>`. A deployment nobody has signed into yet does not
ask you to sign in — it offers to **create the first account**, with an email
address and a password, and signs you in the moment you do.

**Do this immediately.** The offer is open to whoever asks first, and your four
DNS records are public. It closes permanently the instant one account exists:
from then on the same screen is an ordinary sign-in, and the route behind it
answers `409` forever. There is no flag to turn off afterwards.

The address is recorded as verified, because the account exists precisely
because no mail transport is configured and there is nothing to verify it with.
That is also what makes it the _same_ account later: configure a provider or a
mail transport, sign in with the same address, and you land here rather than on
a second account.

Password sign-in stays available afterwards — `AUTH_PASSWORD_SIGNIN=enabled`,
which `generate-secrets.sh` writes into `env/api.env` for you. It is a normal
door for an install that runs on its owner's hardware, not a bootstrap flag.

**The two other doors, once you want them:**

- **OAuth** — register an app with Google or GitHub, set the callback to
  `https://api.<domain>/api/auth/callback/google` (or `/github`), and put the id
  and secret in `env/api.env`. A provider is offered only when both are present,
  so a deployment with neither pair simply has no buttons.
- **Magic link** — needs a working mail transport in `env/worker.env`. Mail is a
  worker job: the api only writes the send to an outbox. With no transport,
  nothing is sent, and the log records only that a message existed — its subject
  and the recipient's domain. The link itself is deliberately written nowhere,
  because a sign-in link in a log file is a credential in something every
  operator tails and pastes into issues, so **the log is not a way in**. The
  worker says so at boot: `email_transport_selected` is logged at `warn` naming
  the variables that are missing. `SMTP_HOST` alone is enough to activate SMTP;
  the rest of the block defaults to port 587 with STARTTLS, no credential, and
  `EMAIL_FROM` as the sender.

`docker compose run --rm create-admin --email you@example.com` still exists and
still works. It predates the first-run screen and is now the tool for the case
that screen cannot serve: writing an account on a deployment that already has
one, from the host, with no browser.

### 5. Add a site and check the pipeline

Create a site in the dashboard, paste the snippet it gives you, then:

```sh
curl -s https://c.<domain>/oa.js -o /dev/null -w '%{http_code} %{size_download}\n'
curl -s https://api.<domain>/health | head -c 200
docker compose logs --tail=50 worker | grep -i batch
```

An event should reach ClickHouse within a couple of seconds of a page view.

---

## The configuration, in detail

### Why there is no single `.env`

Each service validates its own environment at startup, and **a service handed a
secret it must not hold exits rather than starting**. That is the boundary the
architecture rests on:

- the internet-facing collector holds no ClickHouse credential, no Stripe key,
  no mail credential and cannot mint the preview tokens it verifies;
- the query gateway holds the public verify key and never the private one, so it
  cannot forge the requests it exists to authenticate;
- only the worker holds the credential that can delete analytics rows;
- only the collector holds the HMAC that turns a visitor's address into an
  anonymous id, because it is the only service that ever sees an address.

One shared environment would hand every service every secret, and nothing would
boot. Hence `env/api.env`, `env/collector.env`, and so on.

**An empty value is not an absent one.** `FOO=` sets `FOO` to the empty string
and the schema rejects it — an optional variable is optional when it is
_missing_. (`PORT=` coerces to `0` and fails the same way.) Leave what you do not
use commented out. This is the single most common way to get a service that
refuses to boot with a puzzling message.

### Secrets you generate

`generate-secrets.sh` writes all of these. Generate them by hand only if you are
wiring this into something else:

```sh
openssl rand -hex 32     # AUTH_SECRET, ANONYMOUS_IDENTITY_SECRET,
                         # TRIAL_IDENTITY_SECRET, CREDENTIAL_SOURCE_SECRET,
                         # and every store password

# OA_CREDENTIAL_KEYRING — one line of JSON
node -e "console.log(JSON.stringify({active:'k1',keys:{k1:require('node:crypto').randomBytes(32).toString('base64')}}))"
```

Four of them are **independent by design** and must not be derived from one
another: they protect different things, and a derivation would make rotating one
force rotating the other.

Two must be **byte-identical across two files**, and a mismatch does not fail
loudly — it produces joins that match nothing while looking exactly like values
that should:

| Secret                      | Must match between                    |
| --------------------------- | ------------------------------------- |
| `ANONYMOUS_IDENTITY_SECRET` | `env/collector.env`, `env/worker.env` |
| `OA_CREDENTIAL_KEYRING`     | `env/api.env`, `env/worker.env`       |

### The three key pairs, and why they are not in an env file

| Pair            | Private half (api mints) | Public half (verifies only) |
| --------------- | ------------------------ | --------------------------- |
| Query signing   | api                      | query gateway               |
| Realtime tokens | api                      | realtime                    |
| Rule preview    | api                      | collector                   |

```sh
openssl genpkey -algorithm ed25519 -out private.pem
openssl pkey -in private.pem -pubout -out public.pem
```

**A PEM cannot live in an env file.** It is multi-line, and writing it with an
escaped `\n` does not help: Docker passes those through as two literal
characters and `createPrivateKey` rejects the result with
`ERR_OSSL_UNSUPPORTED`. A YAML block scalar is the shape that survives, which is
why the generator writes them into `docker-compose.override.yml` — a filename
`docker compose` merges automatically, so there is no `-f` to forget. Forgetting
it would boot an api with the analytics and realtime surfaces silently unmounted.

**Rotating a pair is one window, not two steps.** Neither side supports a key
_set_, so signer and verifier change together: generate the pair, replace both
halves in the override file, bump `QUERY_SIGNING_KEY_ID` in **both**
`env/api.env` and `env/gateway.env`, then
`docker compose up -d gateway api realtime`. Bumping the id is what turns a stale
signer into `Unknown signing key` rather than a signature failure — the more
diagnosable of the two. Generate keys **on the host**, not on a workstation
whose shell history or agent transcript can see them.

### The Valkey URLs are IP addresses on purpose

The connection factory refuses a plaintext `redis://` URL whose host it cannot
prove is private, because that hop can hold the only copy of a customer event.
It recognises loopback, `10/8`, `192.168/16` and `172.16-31/12` — **a compose
service name is none of those**, so `redis://valkey-queue:6379` is rejected
outright with "this hop crosses the public internet". AUTH is required on that
hop whatever the address.

So the compose network pins `172.28.0.0/16` and gives each Valkey a fixed
address in it. If that subnet collides with something on your host, change
`OA_SUBNET`, both `ipv4_address` values and the URLs in `env/*.env` together —
any private range works, none of the public ones do.

To put the queue on a wire you do not control, terminate TLS in Valkey and use
`rediss://` with AUTH. The check accepts that from any host.

### GeoIP

Country and city come from a local City-schema `.mmdb` — MaxMind GeoLite2 or the
DB-IP equivalent. Neither may be redistributed, so neither is committed here.

```sh
# put GeoLite2-City.mmdb (or dbip-city-lite.mmdb) in:
infra/selfhost/geoip/
# then in env/collector.env:
GEOIP_DB_PATH=/geoip/GeoLite2-City.mmdb
```

Refresh it periodically — the databases go stale — and recreate the collector
afterwards. Unset, every event carries null geo. City-level detail is opt-in per
site in the dashboard regardless.

### Putting your own proxy in front

`infra/selfhost/Caddyfile` is what the compose file uses.
`infra/selfhost/nginx.conf.example` is the same shape for nginx.

**Read the header of whichever you use before changing it.** The
`client_identity_hygiene` block is a security control:

The collector reads the visitor's address from headers a fronting platform is
expected to set from the connection itself — `X-Real-IP`, `CF-Connecting-IP`,
`Fly-Client-IP`, `True-Client-IP` — plus country and city headers of the same
kind. On a platform like Vercel or Cloudflare that is safe, because the platform
overwrites them on every request. **Behind your own proxy nothing overwrites them
unless you do.** A visitor who simply sends `CF-Connecting-IP: 203.0.113.10` then
chooses:

- their own rate-limit bucket — a fresh address per request and the per-IP
  limiter never fires, which is the whole of the ingest flood defence;
- their own anonymous visitor identity, since the daily-rotating hash is derived
  from that address — so one client can appear as any number of visitors;
- their own country and city in your analytics.

The fix is two directives: assert `X-Real-IP` from the real connection, and
**delete every other header in that list**. Both configs do it; keep both parts.

If you add a CDN or load balancer _in front_ of the proxy, the snippet becomes
wrong as written — it would assert that layer's address for every visitor.
Configure the outer layer to set `X-Real-IP` from its own connection, keep the
deletions, and drop the assertion.

### Object storage

Data import and export need an S3-compatible bucket. Any provider works; MinIO
ships here so you do not need one:

```sh
docker compose --profile object-storage up -d
```

Create a bucket and credentials in the MinIO console, then fill in the five
`OBJECT_STORAGE_*` variables in **both** `env/api.env` and `env/worker.env` — the
api mints signed URLs and the worker moves the bytes. All five or none: a
partial block is treated as "not configured" and the import surface is simply
not mounted.

---

## What stops working when something is missing

Nothing here refuses to boot. Every one of these degrades a surface and says so
in the log, which is the deliberate shape: a deployment must not fail over a
feature it has not enabled.

| Missing                                                | What breaks                                                                                                                                                             |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mail transport (`RESEND_API_KEY` / SMTP) on the worker | **Magic-link sign-in cannot complete**; invitations never arrive. Nothing is sent and the link is written nowhere. Sign in with the account the first-run screen made.  |
| `AUTH_TRUSTED_ORIGINS` on the api                      | **Every browser call from the dashboard is refused.** No `Access-Control-Allow-Origin` is emitted at all — fail-closed by design.                                       |
| `APP_BASE_URL` on the api                              | Human-facing links (invitation acceptance, billing returns) point at pages the api does not serve.                                                                      |
| `GOOGLE_*` / `GITHUB_*`                                | No Google/GitHub button. A provider appears only when both its id and secret are present.                                                                               |
| `GEOIP_DB_PATH`                                        | Every event carries null geo. No country, no city.                                                                                                                      |
| `CLICKHOUSE_MAINTENANCE_*` on the worker               | **Site and account deletion queue and retry forever** instead of erasing anything. A wait, not a loss — but a silent one.                                               |
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET`          | Billing surfaces disable themselves. Normally what a self-hosted install wants.                                                                                         |
| `OPENAI_API_KEY`                                       | The AI assistant answers `503 not configured` — _before_ any question is charged.                                                                                       |
| `OA_CREDENTIAL_KEYRING`                                | Revenue-connection routes that encrypt are not mounted (404). Reading and disconnecting still work.                                                                     |
| `CREDENTIAL_SOURCE_SECRET`                             | No credential events are journalled at all. Reads are untouched.                                                                                                        |
| `OBJECT_STORAGE_*`                                     | Data import and export are not mounted.                                                                                                                                 |
| `PREVIEW_TOKEN_*`                                      | Rule preview is unavailable; the published rule set is served instead. A preview that cannot be authenticated is served as no preview, never as an unauthenticated one. |
| `REALTIME_CACHE_REDIS_URL` on the gateway              | Replay defence becomes per-process — correct only with a single gateway instance. It warns.                                                                             |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_NOTIFY_CHAT_ID`       | Notifications use the log transport.                                                                                                                                    |
| `METRICS_REMOTE_WRITE_*`                               | No metrics pipeline; the structured-log metrics floor remains.                                                                                                          |

---

## Backups

**Nothing in this repository takes a backup for you.** `apps/worker/src/backup-watch.ts`
is a _watcher_: given object-storage credentials it publishes
`clickhouse_backup_age_seconds` from the newest object under `backups/daily/`, so
an alert can fire on the **absence** of a recent backup. It never writes one. A
timer that quietly stopped produces no error to alert on, which is why the signal
is age rather than failure.

What actually needs backing up, in order of how much it hurts to lose:

1. **`infra/selfhost/env/*.env` and `docker-compose.override.yml`.** Not data,
   but without them the data below is unreadable. Store them somewhere that
   survives losing this host.
2. **Postgres** — every user, site, tracking key, share link and event
   definition. Small, and the thing that makes the ClickHouse data mean
   anything. `pg_dump` on a schedule is enough:
   ```sh
   docker compose exec -T postgres pg_dump -U openanalytics openanalytics | gzip > oa-pg-$(date +%F).sql.gz
   ```
3. **ClickHouse** — the events. Large and append-mostly. ClickHouse's own
   `BACKUP DATABASE analytics TO S3(...)` writes straight from the server to a
   bucket; run it from a timer on the host and keep the object off this machine.
4. The Valkey queue volume, only if you cannot tolerate losing events that are
   in flight — usually seconds' worth.

Two things worth knowing before you rely on any of it:

- **A backup nobody has restored is a guess.** Restore into a scratch database
  on a schedule and compare row counts. The hosted deployment does this weekly,
  because both a rehearsal that fails every week and one that stopped running
  look identical from outside.
- **If you encrypt backups with a customer-supplied key, losing that key is
  worse than having no backups**, because it looks like being covered. Keep a
  copy somewhere that is not the machine it protects.

---

## Operating it

### Upgrades

```sh
git pull
docker compose up -d --build
```

Migrations run first and the rest waits on them. Two orderings the compose file
already encodes, worth knowing if you deploy the services by hand:

- **gateway before api.** The api sends a field on every gateway query that an
  older gateway rejects outright, so an api-first deploy breaks analytics reads
  for the length of the window; gateway-first has no window at all.
- **ClickHouse needs a recreate, not a restart**, whenever its users or grants
  change. `docker compose restart` re-runs the entrypoint with the container's
  _original_ environment, so the new value silently never arrives:
  ```sh
  docker compose up -d --force-recreate clickhouse
  ```
  Every migration that adds a table the worker writes also needs a line in
  `infra/selfhost/clickhouse/oa-entrypoint.sh` and one of these recreates.
  Without it, inserts into the new table fail while ordinary traffic keeps
  flowing — the quiet half of the failure.

### The tracker

`oa.js` is built once per `up` by the `tracker-build` container into a volume
Caddy serves. It is cached for an hour and never versioned: a fixed filename
means a fix reaches every visitor within an hour without anyone editing a
snippet, and that hour is also the ceiling on how long a broken tracker survives
after you fix it. To publish a change immediately after an upgrade:

```sh
docker compose up -d --build --force-recreate tracker-build
```

Both `oa.js` and `oa.js.gz` are written together — a stale `.gz` beside a fresh
`.js` is what almost everyone would be served.

### Health

Every service answers `GET /health` on its own port with a dependency list, and
`503` while a dependency is unavailable. Each image is stamped with the commit
it was built from, published in the same response — so you can ask a running
service which commit it is rather than assuming:

```sh
docker compose exec api node -e "fetch('http://127.0.0.1:8082/health').then(r=>r.json()).then(o=>console.log(o.commit, o.status))"
```

Set `OA_GIT_COMMIT=$(git rev-parse HEAD)` in `infra/selfhost/.env` before
building for that to be useful.

### Losing a secret

| Lost                        | Consequence                                                                                                               |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Store passwords             | Locked out of your own volumes. Recoverable only by resetting them inside the containers.                                 |
| `OA_CREDENTIAL_KEYRING`     | **Every stored provider credential is unrecoverable.** Customers must reconnect.                                          |
| `ANONYMOUS_IDENTITY_SECRET` | Visitor identity re-baselines: returning visitors count as new from that day. Not data loss, but a visible discontinuity. |
| `AUTH_SECRET`               | Every session is invalidated. Everyone signs in again.                                                                    |
| A signing private key       | Rotate the whole pair — see above. Nothing is lost.                                                                       |

---

## Running from source

For development, or to run the services under something other than Docker.
**Order matters, and one obvious order does not work**: the migration runners are
compiled output (`packages/*/dist/cli.js`), so they cannot run before the build.

```sh
git clone https://github.com/OpenLabs-so/openanalytics
cd openanalytics
pnpm install --frozen-lockfile

# 1. build FIRST — this is what produces the migration CLIs
pnpm run build

# 2. start the stores (or point the URLs at your own)
cd infra/selfhost && ./generate-secrets.sh --domain localhost --email you@example.com
docker compose up -d postgres clickhouse valkey-queue valkey-realtime
cd ../..

# 3. now the schemas
set -a; . ./infra/selfhost/env/migrate.env; set +a
pnpm run migrate:postgres
pnpm run migrate:clickhouse

# 4. the tracker bundle, budget enforced
pnpm run tracker:build     # -> apps/tracker/bundle/oa.js
```

Each service is then `node apps/<name>/dist/main.js` with **its own** environment
— see [Why there is no single `.env`](#why-there-is-no-single-env). The dashboard
is `pnpm --filter @openanalytics/web dev`.

The test suite, the way CI runs it:

```sh
pnpm run test       # unit + contract + tracker, no infrastructure needed
pnpm run verify     # everything CI checks, including boundaries and the size budget
```

---

## Troubleshooting

**A service exits immediately with a list of environment problems.** Read the
list: it reports every problem at once rather than one per restart. Two causes
cover almost all of it — a variable left blank instead of commented out, or a
secret in the wrong file (each service refuses secrets it must not hold, by
design). The message names the variable and which of the two it is.

**Everything is healthy but the dashboard shows nothing.** Check
`AUTH_TRUSTED_ORIGINS` in `env/api.env` — it must contain the dashboard's exact
origin. Unset or wrong, the api emits no CORS header and every browser call is
refused. The browser console will say so plainly.

**The dashboard talks to the wrong host.** `NEXT_PUBLIC_*` values are compiled
into the browser bundle, not read at run time. Changing one needs
`docker compose build web && docker compose up -d web`.

**ClickHouse will not start after an edit.** A line beginning `oa-entrypoint:` is
the entrypoint refusing a value and naming it — fix and recreate. Otherwise the
server has rejected a `config.d` file it cannot parse; the classic cause is a
double hyphen inside an XML comment, which is not legal XML and which the server
refuses to merge rather than ignore.

**Events are accepted but never appear.** The collector answers `202` when the
event is durable in the _queue_; the worker moves it to ClickHouse. Check the
worker's log and the queue depth. If the queue is growing, the worker is not
draining — usually a ClickHouse credential or a missing grant on a new table.

**Site deletion never completes.** The worker needs
`CLICKHOUSE_MAINTENANCE_USER` and `CLICKHOUSE_MAINTENANCE_PASSWORD`, and the
`oa_maintenance` user must exist in ClickHouse — which needs a container
recreate, not a restart.

---

## License

AGPL-3.0. If you run a modified OpenAnalytics as a network service, the license
requires you to offer your modified source to its users.

The "OpenAnalytics" name and the `getopen.so` domain identify the hosted service
run by its operators and are **not** part of the license grant. Self-hosted
instances run the software, not the brand.
