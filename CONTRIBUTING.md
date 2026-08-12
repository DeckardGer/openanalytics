# Contributing to OpenAnalytics

Thank you for wanting to improve OpenAnalytics.

## How this repository works

This is the working repository for the product. Pull requests are reviewed and
**merged here**, with your name on the commit.

Until August 2026 that was not true: this repository received a periodic
verified export from a private monorepo, and a merged PR was flattened by the
next one. That model has ended. The private repository still exists — it carries
the hosted service's commercial half and our operational record — but the two
are now independent, and neither is generated from the other.

We sign contributions with a **CLA**, which the bot will ask you for on your
first pull request. There is no DCO sign-off requirement; one provenance step is
enough.

Issues are the right place for discussion.

## Development setup

```sh
pnpm install --frozen-lockfile
pnpm run test        # unit + contract + tracker — no infrastructure needed
pnpm run verify      # the full CI gauntlet: boundaries, format, lint,
                     # OpenAPI lint + drift check, typecheck, tests, tracker budget
```

Node is pinned (`.node-version`), and `engine-strict` is on: an install on
the wrong major fails loudly by design.

Integration and migration suites need real backing stores; CI provides them as
service containers, and locally `infra/selfhost/docker-compose.yml` brings up
the same four (`docker compose up -d postgres clickhouse valkey-queue
valkey-realtime`). They run with `pnpm run test:integration` /
`pnpm run test:migration` and `TEST_*` env vars (see
`.github/workflows/ci.yml` for the exact set).

## Ground rules for changes

- **The contract is the seam.** `apps/web` imports only `packages/contracts`;
  server packages never leak into the frontend. `pnpm run boundaries`
  enforces this and CI runs it first.
- **OpenAPI first.** API surface changes start in
  `packages/contracts/openapi/openapi.yaml`; `pnpm run contracts:generate`
  regenerates the client, and CI fails if the committed client drifts.
- **The tracker has a byte budget.** `pnpm run tracker:build` enforces it;
  a feature that cannot pay for its bytes needs a discussion first.
- **Tests are not optional.** A behavior change without a test that pins it
  will be asked for one.
- Match the style around you; `pnpm run format:check` and `pnpm run lint`
  are both CI gates.

## Reporting bugs

Use the issue templates. For anything security-sensitive, **do not open an
issue** — see [SECURITY.md](SECURITY.md).
