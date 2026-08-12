# @openanalytics/web

The Next.js App Router frontend: the signed-in dashboard, the public share and
widget pages, the login and onboarding flows, and the marketing/docs site.

## Layout

| Path              | What lives there                                                              |
| ----------------- | ----------------------------------------------------------------------------- |
| `app/dashboard/`  | The signed-in product — sites, analytics, funnels, widgets, settings           |
| `app/share/`      | Public dashboards served from a share slug, no session required                |
| `app/login/`      | Magic link and OAuth entry; `app/onboarding/` is the first-run flow            |
| `app/docs/`       | Product documentation; `app/home/`, `app/vs/`, `app/oss/` the marketing pages  |
| `app/api/`        | The app's own route handlers (favicon proxy, status probe)                     |
| `components/ui/`  | Design-system primitives; `components/charts/` the visualisation layer         |
| `lib/`, `hooks/`  | The API client wrapper, formatting helpers and shared React hooks              |

## Talking to the backend

Every read and write goes through `@openanalytics/contracts` — the generated
client and types built from `packages/contracts/openapi/openapi.yaml`. That is
the only workspace package this app may import: the contract is the seam, so a
backend change that would break the frontend shows up as a type error rather
than a runtime 4xx. Do not hand-roll `fetch` calls against `/v1` paths.

The API, realtime and collector origins the client talks to come from
`NEXT_PUBLIC_*` environment variables (`lib/api.ts`), so a deployment points at
its own backend without a code change.

## Running it

```bash
pnpm install                      # from the repository root
pnpm --filter @openanalytics/web dev
```

`prebuild` builds the contracts package first, so `pnpm --filter
@openanalytics/web build` is enough for a production build. Authenticated flows
need a reachable API — see the repository README for bringing the backend up.
