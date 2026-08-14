# OpenAnalytics on Coolify

What this file is: the deployment that has been run, and the things that cost an
afternoon to find. Coolify 4.3.2, a 4 GB Hetzner box, four real hostnames and
real Let's Encrypt certificates.

**Not a supported path yet.** One install on one platform is a demonstration,
not a promise. What it is no longer is a file nobody has run.

## What you need first

- A Coolify install you are an admin of, and a server it can deploy to.
- **Four DNS records**, all pointing at that server. The dashboard, the api, the
  collector and the realtime stream are four hostnames, not four paths. See
  [SELF-HOSTING.md](../../SELF-HOSTING.md#four-names-and-why-it-is-four) for why.
- About 4 GB of RAM for the stack, on top of whatever Coolify itself uses.

## The deployment

New resource, **Docker Compose** from a public repository.

| Field                   | Value                                          |
| ----------------------- | ---------------------------------------------- |
| Repository              | `https://github.com/OpenLabs-so/openanalytics` |
| Branch                  | a release tag, not `main`                      |
| Base directory          | `/infra/selfhost`                              |
| Docker Compose location | `/docker-compose.coolify.yml`                  |

Then set the four domains, one per service, before the first deploy:

| Service     | Domain         |
| ----------- | -------------- |
| `web`       | `app.<domain>` |
| `api`       | `api.<domain>` |
| `collector` | `c.<domain>`   |
| `realtime`  | `rt.<domain>`  |

Everything else generates itself. Coolify reads the compose file and fills in
every password, every base64 secret and every FQDN variable: twenty-one of them,
none typed by hand. The three signing key pairs are made inside the stack by a
one-shot step, because no platform can generate a keypair whose halves must match
across two services.

## What to expect on the first deploy

**Ten images, a few minutes.** Nothing is built. The largest is ClickHouse at
250 MB.

**A one-shot that exits, and that is success.** `migrate`, `keygen` and
`tracker-build` all end in `Exited (0)`. Only the other ten stay up.

**Claim the deployment immediately.** Opening `app.<domain>` on a deployment
nobody has signed into offers to create the first account, and that offer is open
to whoever asks first. Your DNS records are public. It closes permanently the
moment one account exists.

## Things that are true here and nowhere else

**GeoIP starts empty and geo is null.** Two config files could be baked into
images and were; a licensed 125 MB database refreshed monthly could not, and this
platform has no checkout to download one into. To turn it on, copy a database
into the collector's `/geoip` volume and add `GEOIP_DB_PATH` to the env sheet.
See [SELF-HOSTING.md](../../SELF-HOSTING.md#geoip).

**The proxy is Coolify's, so the header rules are Traefik labels.** The stock
install runs Caddy, which strips the headers a fronting proxy is supposed to own
(`CF-Connecting-IP` and its family). Without that, any visitor can pick their own
rate-limit bucket or write their own country into your analytics. This file
rebuilds those rules as a Traefik middleware and attaches it with
`coolify.traefik.middlewares`, which is Coolify's own directive. **Do not rewrite
that as a `traefik.http.routers.<name>.middlewares` label**: Coolify renames the
routers it generates on every redeploy, so a hand-written router name attaches
the middleware to nothing and fails silently, leaving the headers through.

**Every public service declares `expose:`.** Traefik takes a container's port
from the ports it exposes, and the backend services share a Dockerfile that
declares none. Without this the router is dropped as unroutable and its
certificate is never requested: the hostname does not answer, nothing is logged,
and the container beside it is healthy. If you fork this file, keep those lines.

## Two Coolify behaviours worth knowing before you blame yourself

Neither is caused by this stack. Both cost real time.

**A deployment can die silently and still read "in progress".** Twice, the job
ended after the git checkout: the helper container went idle, Coolify's queue
emptied, nothing was written to `laravel.log`, and the deployment record stayed
`in_progress` forever. The way out is to delete the helper container and deploy
again.

**The git clone can crawl.** On the box used here, `github.com` served 1.8 KB/s
while `codeload.github.com` served 3.7 MB/s from the same host at the same
moment, so a 20 MB shallow clone took over half an hour. That is a network path
between the host and GitHub, not Coolify and not this file, but it looks exactly
like a hung deploy. Measure before you conclude:

```sh
curl -o /dev/null -w '%{speed_download} B/s\n' \
  'https://github.com/OpenLabs-so/openanalytics.git/info/refs?service=git-upload-pack'
```

## What was verified, and how

So that the claim above is checkable rather than a summary of good intentions.

| Claim                             | How it was checked                                                                                                            |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Thirteen containers correct       | `docker ps`: ten healthy, three `Exited (0)`                                                                                  |
| Four hostnames on HTTPS           | `200` on each, `ssl_verify_result=0`, Let's Encrypt issuer                                                                    |
| Secrets generated by the platform | twenty-one variables filled from the compose file, none typed                                                                 |
| Signing loop closed               | a read from the api accepted by the gateway; a request correct in every header but its signature refused with `BAD_SIGNATURE` |
| Forged headers stripped           | all eight deleted at an echo service behind the same middleware, `X-Forwarded-For` intact                                     |
| The stripping reaches the product | a page view sent with `CF-IPCountry: XX` stored with its country **empty**                                                    |
| Ingest end to end                 | three page views accepted, queued, drained by the worker, and read back out of ClickHouse                                     |

## If something is wrong

`docker logs` on the service that is unhealthy, first. The services say why they
refuse to start, on one line, on purpose: a missing variable, a path that names
no file, a secret a service is not allowed to hold. That last one is the
least-privilege boundary doing its job rather than a bug.
