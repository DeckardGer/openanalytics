# ClickHouse migrations

Files are named `NNNN_snake_case_name.sql` and applied in version order by the
dedicated migration credential. No DDL ever runs from a request handler
(docs snapshot 02 §15).

Table names are written **unqualified**. The runner applies statements with the
configured database as the session default, which is what lets the same files
build the production `analytics` database and a throwaway one in CI.

Rules:

- **Statements must be idempotent.** ClickHouse has no multi-statement
  transaction, so the ledger marks a migration `pending` before the DDL and
  `applied` after. A crash in between leaves a visible unfinished row, and the
  re-run must be safe — use `IF NOT EXISTS`.
- **No semicolon inside a comment.** The runner splits statements on the
  semicolon before it strips comment lines, so one in a comment cuts a statement
  in half. Found the hard way while applying 0001 (ADR-0010).
- **Every MergeTree-family table sets `non_replicated_deduplication_window`**,
  including every materialized-view target. On a non-replicated MergeTree,
  insert deduplication is off by default and the stable batch token is accepted
  and ignored; setting it only on the raw table deduplicates the raw rows while
  the view fires again on every retry (ADR-0005 measured a silent 3x).
  `tests/migration/clickhouse-analytics.test.ts` fails a migration that forgets
  it, because this is the kind of mistake that is invisible when wrong.
- **Forward-only**, same as Postgres (docs snapshot 05, D-214).
- **A materialized view change is a multi-step migration.** Creating the new
  target, backfilling it and swapping to it are separate, explicit steps. A
  source-table change does not retroactively fix an MV target
  (docs snapshot 02 §15).
- **Deletion is not inherited.** Dropping rows from the raw table does not clean
  the rollup, session, import, attribution or revenue targets. Each is deleted
  and verified separately by the deletion workflow (docs snapshot 05, D-210).

## Milestone 6

| Version | Subject                                                                |
| ------- | ---------------------------------------------------------------------- |
| 0001    | `events_raw` — the canonical raw analytics fact (docs snapshot 02 §15) |
| 0002    | `performance_events` + its materialized view over `events_raw`         |
| 0003    | `metrics_1m` + its materialized view — the first additive fact rollup  |
| 0004    | Repoint `performance_events_mv` at the server-owned `oa_` payload keys |

## Milestone 7 — the additive rollup family

Checkpoint A (plan Milestone 7 items 1–3). Every rollup view reads **directly
from `events_raw`**, never from another rollup: ADR-0005 measured the
single-level dependent-view dedup behaviour, and reading straight from the raw
table keeps the whole family inside that proven model rather than a two-level
cascade whose second-level token derivation is unmeasured (0006 argues this in
full). Unique visitors are kept as a mergeable `uniqState` everywhere — bucket
uniques are never summed (plan item 2). The identity is
`if(user_id != '', user_id, anonymous_id)` (docs snapshot 02 §10; 0005).

| Version | Subject                                                                  |
| ------- | ------------------------------------------------------------------------ |
| 0005    | `metrics_1m` unique-visitor `uniqState` column by `ALTER` + view repoint |
| 0006    | `metrics_1h` / `metrics_1d` + views — the overview/timeseries rollups    |
| 0007    | `pages_1h` / `pages_1d` + views                                          |
| 0008    | `sources_1h` / `sources_1d` + views                                      |
| 0009    | `geography_1h` / `geography_1d` + views                                  |
| 0010    | `devices_1h` / `devices_1d` + views                                      |
| 0011    | `custom_events_1h` / `custom_events_1d` + views                          |
| 0012    | `performance_1h` / `performance_1d` + views (t-digest percentile states) |

Revenue rollups are **not** incremental views at all and are deliberately not
created in M7 (docs snapshot 05, D-211/D-212). They come from the revenue
normalize → fact → attribution → rollup sequence.

## Milestone 8 — session facts and rollups (Checkpoint A)

Session and bounce are **not** an incremental materialized view either (D-211): a
late second pageview must be able to undo a recorded bounce, which an insert-once
view cannot do. There is no `CREATE MATERIALIZED VIEW` in either file below.
`session_facts_versions` is written by the finalizer as versioned rows (latest
version per session is the truth, selected with `argMax`/`LIMIT 1 BY` — never
`FINAL` for correctness). The rollups are recompute/swap targets keyed by a
`generation` column the reader filters on, chosen over `REPLACE PARTITION` because
the swap must be per-(site, bucket) without an unbounded partition count. Every
table stays read-correct before any merge (ADR-0005); the engine's replacement
only reclaims space from superseded versions/generations.

| Version | Subject                                                                     |
| ------- | --------------------------------------------------------------------------- |
| 0013    | `session_facts_versions` — versioned canonical session facts, no MV         |
| 0014    | `session_rollups_1h` / `session_rollups_1d` — finalizer swap targets, no MV |

## Milestone 11 — imported aggregates

Imported provider data never enters `events_raw` or the additive rollup family
(ADR-0032, D2). It is staged into its own eight day-grain tables keyed by
`(site_id, import_run_id, date)`, and a run becomes visible by a Postgres pointer
swap rather than by a write — which is what makes a publish, a rollback and a
per-run cleanup all cheap and reversible.

| Version | Subject                                                                                 |
| ------- | --------------------------------------------------------------------------------------- |
| 0015    | the eight `imported_*_1d` staging targets — written by the worker on `oa_ingest`, no MV |

## Milestone 12 — revenue

D-212 fixes the order and the migration ledger is what proves it: the normalized
fact comes first, attribution second, the rollups last. **The rollups cannot
predate the fact**, because the runner applies files in version order and refuses
to skip — so a database holding `revenue_1h` necessarily holds `revenue_events`.
That is plan 04 M12's fourth acceptance criterion, and
`tests/unit/revenue-migration-order.test.ts` asserts it against the files on disk
so a future checkpoint cannot land a rollup under a lower number.

Revenue rollups are **not** incremental materialized views (D-211/D7): revenue is
refundable and versioned, so an insert-only view is structurally wrong. They are
generation-swapped recompute targets built by reading the fact through the
`argMax(col, version)` rule — never `FINAL`, never a pre-filter on a column a
version can change.

| Version | Subject                                                                     |
| ------- | --------------------------------------------------------------------------- |
| 0016    | `revenue_events` — the canonical fact, `ReplacingMergeTree(version)`, no MV |
| 0017    | `revenue_attributions` + session-fact `utm_content`/`utm_term` (CP4)        |
| 0018    | `revenue_1h` / `revenue_1d` — attribution-job swap targets (CP5)            |
| 0019    | `revenue_events.fee_currency` — fees become readable (M12 follow-up)        |

0017 is two halves of one decision and they ship together: the touchpoints an
attribution names **are** session-fact rows (D6 refuses a second
`attribution_touchpoints` table), so widening the fact and creating the table
that points at it must not be separable. The two `ALTER TABLE ... ADD COLUMN IF
NOT EXISTS` do not re-version a single stored session on their own — ClickHouse
fills an added column with its type default in older parts, and `''` is exactly
the value `sessionize` already produces for an absent utm, so a stored fact
compares unequal to its recompute only when the session genuinely carried one.
