# Self-host package

The supported way to run OpenAnalytics on your own hardware.
**The instructions are in [`/SELF-HOSTING.md`](../../SELF-HOSTING.md)** at the
repository root — this file only says what is in this directory.

```sh
./generate-secrets.sh --domain analytics.example --email admin@analytics.example
docker compose up -d
```

| Path                  | What                                                                     |
| --------------------- | ------------------------------------------------------------------------ |
| `docker-compose.yml`  | The whole stack. Its header explains the three load-bearing choices.     |
| `generate-secrets.sh` | Writes `.env`, `env/*.env` and the key-pair override, in one pass        |
| `.env.example`        | The values compose interpolates — hostnames and the network. No secrets. |
| `env/*.env.example`   | One template per service. There is no shared environment; see below.     |
| `Caddyfile`           | TLS front for the four public names. **Read its header before editing.** |
| `nginx.conf.example`  | The same shape for nginx, if you already run one                         |
| `web.Dockerfile`      | The dashboard image (the backend uses `../docker/node-app.Dockerfile`)   |
| `clickhouse/`         | Entrypoint that provisions the four least-privilege users, and config    |
| `valkey/`             | Entrypoint and the two policy files — durable queue, losable cache       |
| `geoip/`              | Where you put a City-schema `.mmdb`. Empty: it may not be redistributed. |

Two things that surprise people, both explained at length in the compose
header and in `/SELF-HOSTING.md`:

- **There is no shared `.env` for the services.** Each one validates its own
  environment and exits if handed a secret it must not hold. That boundary is
  what keeps the internet-facing collector away from ClickHouse and the query
  gateway away from the key it verifies with.
- **The Valkey URLs are IP addresses, not service names.** The queue client
  refuses a plaintext URL to a host it cannot prove is private, and a compose
  service name is not one.

This directory is generic on purpose: it describes a reference deployment. The
hosted service's own machine configuration is maintained outside this tree and
is not part of the self-hosting path.
