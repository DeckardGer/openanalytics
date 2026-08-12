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

[Discussions](https://github.com/OpenLabs-so/openanalytics/discussions) are for
questions and for ideas you want to talk through first; issues are for something
that is wrong or missing.

## Where to start

**Say what you are doing before you do it** if the change is more than a fix —
an issue or a discussion first. Not ceremony: a lot of this codebase is shaped
by decisions with reasons that are not visible from the file you are editing,
and it is cheaper for us to say "that seam exists because…" in a comment than in
a review of finished work.

Good first ground, in rough order of how self-contained it is:

- **The dashboard** (`apps/web`) — it talks to the API through the generated
  client and nothing else, so a change here cannot break a boundary by accident.
- **Docs.** [SELF-HOSTING.md](SELF-HOSTING.md) is the document most read by
  people who are not us, and the places where it is wrong are the places we
  cannot see, because we already know what it meant to say.
- **The tracker** (`apps/tracker`) — small, heavily tested, and every change has
  a byte budget to argue with.
- **Import adapters** (`packages/integrations`) — one shape, one parser, and the
  framework around them already exists.

Harder, and worth an issue first: anything touching ingest, the query gateway,
or a migration. Those carry invariants CI enforces without explaining — the
reasoning lives in the module headers and in the migration files themselves, and
a change that satisfies the check without reading the argument tends to be right
in a way that is wrong.

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
- **Migrations are forward-only and expand-first.** There are no down
  migrations; a rollback is a restore. So a migration that cannot be deployed
  ahead of the code that needs it is a migration to split in two.
- Match the style around you; `pnpm run format:check` and `pnpm run lint`
  are both CI gates.

**On comments.** This codebase explains _why_, not _what_ — the reasoning that
would otherwise be lost, and often the failure that caused a rule to exist. A
comment restating the line below it will be asked for or removed; one naming the
thing that breaks if the line changes is the point.

## Reporting bugs

Use the issue templates. For anything security-sensitive, **do not open an
issue** — see [SECURITY.md](SECURITY.md).

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).
