# Postgres migrations — product stream

Files are named `NNNN_snake_case_name.sql` and applied in version order into the
`schema_migrations` ledger. The runner refuses duplicate versions, out-of-order
versions and any edit to a migration that has already been applied.

There are **two independent migration streams**:

- **Product** (this directory, ledger `schema_migrations`) — the complete
  product schema. It carries no commercial concept: no subscriptions, no trial,
  no billing assignments.
- **Cloud** (`packages/postgres/cloud/migrations`, ledger
  `cloud_schema_migrations`) — the hosted-cloud additions layered on top:
  billing history, subscriptions, trial, usage windows, the cloud lifecycle
  columns on `sites`.

**Deploy order: product first, then cloud.** The cloud stream references product
tables (`sites`, `users`, `usage_batch_deltas`) and must never run against a
database whose product stream is behind. Run them as
`pnpm run migrate:postgres` followed by `pnpm run migrate:postgres -- --stream cloud`
(see `packages/postgres/src/cli.ts`).

Rules:

- **Forward-only.** Production changes follow expand → migrate/backfill →
  contract (docs snapshot 05, D-214). There is no `down` runner; an automatic
  destructive rollback is not a rollback strategy. An app rollback happens inside
  the schema-compatibility window instead.
- **One migration, one commit.** Schema change, migration and rollout note ship
  in the same PR (docs snapshot 04 §2).
- **Never edit an applied migration.** The checksum ledger will refuse the next
  run. Add a new forward migration.
- **Timestamps are `timestamptz`.** Legacy stored timezone-less timestamps and
  left billing boundaries dependent on an implicit server timezone
  (docs snapshot 01 §15).

## Foundation

| Version | Subject                                                                                          |
| ------- | ------------------------------------------------------------------------------------------------ |
| 0001    | Better Auth core: users, sessions, accounts, verifications                                       |
| 0002    | sites, site_domains, site_members, site_invites (owner_user_id; status incl. `suspended`)        |
| 0003    | api_keys (public tracking write / private read, hash-only)                                       |
| 0004    | audit_logs, outbox                                                                               |
| 0005    | jobs, deletion_requests, deletion_targets (skeleton)                                             |
| 0006    | ownership invariants: deferred constraint triggers (≥1 owner; owner is an accepted owner member) |
| 0007    | usage_batches, usage_batch_deltas (exactly-once usage ledger, D-209)                             |
| 0008    | sites lifecycle columns: ingest_generation, config_version, suspended_at                         |

Later versions each carry their own header comment; read the file for the
rollout note and the reasoning.

Migrations here have a Drizzle mirror under `packages/postgres/src/schema`
(cloud tables mirror under `packages/postgres/src/cloud/schema`); the SQL is
the DDL source of truth (ADR-0006), and
`tests/migration/postgres-schema.test.ts` builds an empty database from these
files and fails if a Drizzle table or column has drifted from what the
migrations create.

0006 is enforcement, not table shape. The ownership invariants — a site keeps at
least one owner, and the owner is an accepted owner member — are cross-row
predicates a plain foreign key cannot state, so they are a
`DEFERRABLE INITIALLY DEFERRED` constraint trigger checked at commit. They are
maintained by the transaction service in `src/repositories/sites.ts` and proven
in `tests/migration/ownership.test.ts`, including a concurrency case.
