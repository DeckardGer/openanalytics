/**
 * Dead-letter replay (docs snapshot 02 §7.4, `docs/dev/launch-alert-drill.md`
 * § 3.2 "Remaining work — DLQ replay").
 *
 * A batch that exhausts `WORKER_BATCH_MAX_ATTEMPTS` has its payloads copied to
 * `event_stream_dlq`, its manifest marked `dead_lettered`, and its messages
 * ACKed. From that moment nothing in the system will look at it again:
 * `recoveryActionFor('dead_lettered')` is `'none'`, so pointing a healthy worker
 * at the queue does not bring the rows back. §7.4 calls for a manual replay and
 * there was no tool to perform one — the same shape of gap ADR-0053 found in
 * the disaster-replay path, found the same way: by running the drill.
 *
 * ## What it does, and what it deliberately does not
 *
 * - Reads `event_stream_dlq` with `XRANGE`, never through a consumer group, and
 *   **deletes nothing**. The dead-letter stream is the evidence that the
 *   incident happened; a recovery that erased it would erase the incident.
 * - Rebuilds each batch **in manifest order** and inserts under
 *   `insert_deduplication_token = batch_id` — the token the original attempt
 *   used. Re-running over the same batches is a no-op inside ClickHouse's
 *   deduplication window, and a batch whose insert had ambiguously landed
 *   cannot double-count.
 * - Applies both fences the disaster-replay runner applies, for the same
 *   reasons: the **stored** `ingest_batch_sites` decision, so a site the D-210
 *   fence already refused is not resurrected; and a **tombstone** check against
 *   `sites.status` now, so a site deleted after the incident is not un-deleted
 *   by its own recovery.
 * - Routes `test_mode` rows to `events_preview` and everything else to
 *   `events_raw` (ADR-0034 D6) — replaying preview traffic into the production
 *   table would push it through thirteen materialized views.
 * - Writes **nothing** to Postgres. The manifest stays `dead_lettered`, which is
 *   the truthful record, and — the consequence worth stating plainly — **the
 *   usage those events would have billed is never recorded.** A dead-lettered
 *   batch is free for the customer even after its rows are restored. Changing
 *   that means reopening a terminal manifest, which is a decision for a
 *   milestone, not for a recovery script.
 *
 * Usage (inside the worker image, which carries every dist this imports):
 *
 *   docker run --rm --network host --env-file /opt/oa/edge/worker.env \
 *     -e REPLAY_MODE=dry-run -e REPLAY_SINCE=2026-08-09T22:00:00Z \
 *     -v /root/dlq-replay.mjs:/replay.mjs:ro \
 *     --entrypoint node oa-worker /replay.mjs
 *
 * `REPLAY_MODE=execute` performs the inserts. `REPLAY_BATCH_IDS` (comma
 * separated) narrows the run; without it every dead-letter entry at or after
 * `REPLAY_SINCE` is considered.
 */

const REPO = process.env.REPLAY_REPO_ROOT ?? '/repo'

// Absolute dist paths, not bare specifiers: the script is mounted at the
// filesystem root, so Node's resolver would walk up from `/` and never reach
// `/repo/node_modules`.
const { createPool, createDatabase, getManifest, listBatchSites } = await import(
  `${REPO}/packages/postgres/dist/index.js`
)
const { createEventsIngest, toEventsPreviewRow, toEventsRawRow } = await import(
  `${REPO}/packages/clickhouse/dist/index.js`
)
const { createQueueClient } = await import(`${REPO}/packages/redis/dist/index.js`)
const { persistedEventSchema } = await import(`${REPO}/packages/contracts/dist/index.js`)

function required(name) {
  const value = process.env[name]
  // The name only. A misconfigured run must not be diagnosed by printing the
  // environment it was handed.
  if (!value) throw new Error(`Missing required environment variable ${name}`)
  return value
}

const MODE = process.env.REPLAY_MODE ?? 'dry-run'
if (MODE !== 'dry-run' && MODE !== 'execute') {
  throw new Error('REPLAY_MODE must be dry-run or execute')
}

const SINCE = process.env.REPLAY_SINCE ? new Date(process.env.REPLAY_SINCE) : null
if (SINCE !== null && Number.isNaN(SINCE.getTime())) {
  throw new Error('REPLAY_SINCE is not a parseable timestamp')
}
const ONLY = new Set(
  (process.env.REPLAY_BATCH_IDS ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id !== ''),
)

const DLQ_KEY = 'event_stream_dlq'
const minId = SINCE === null ? '-' : `${SINCE.getTime()}-0`

const client = createQueueClient({
  mode: 'worker',
  url: required('EVENT_STREAM_REDIS_URL'),
  connectionName: 'dlq-replay',
})
const pool = createPool(required('DATABASE_URL'))
const db = createDatabase(pool)
const clickhouse = createEventsIngest({
  url: required('CLICKHOUSE_URL'),
  username: required('CLICKHOUSE_INGEST_USER'),
  password: required('CLICKHOUSE_INGEST_PASSWORD'),
  database: required('CLICKHOUSE_DB'),
})

/** XRANGE yields [[id, [field, value, field, value, …]], …]. */
function fieldsToObject(fields) {
  const out = {}
  for (let i = 0; i < fields.length; i += 2) out[fields[i]] = fields[i + 1]
  return out
}

const summary = {
  mode: MODE,
  since: SINCE?.toISOString() ?? null,
  dlqEntriesScanned: 0,
  batches: 0,
  batchesReplayed: 0,
  batchesSkipped: 0,
  payloadsInvalid: 0,
  droppedStoredFence: 0,
  droppedTombstone: 0,
  rowsRaw: 0,
  rowsPreview: 0,
  rowsInserted: 0,
  previewRowsInserted: 0,
  insertErrors: [],
  perBatch: [],
}

try {
  const entries = (await client.call('XRANGE', DLQ_KEY, minId, '+')) ?? []
  summary.dlqEntriesScanned = entries.length

  const byBatch = new Map()
  for (const [dlqId, fields] of entries) {
    const entry = fieldsToObject(fields)
    if (ONLY.size > 0 && !ONLY.has(entry.batch_id)) continue
    const bucket = byBatch.get(entry.batch_id)
    if (bucket) bucket.push({ dlqId, ...entry })
    else byBatch.set(entry.batch_id, [{ dlqId, ...entry }])
  }
  summary.batches = byBatch.size

  // The current tombstone set, read once. A site that reaches `deleting` while
  // this run is in flight keeps its rows for one replay — the same race the live
  // fence has, and the deletion job re-sweeps ClickHouse anyway.
  const tombstoned = new Set(
    (await pool.query("SELECT id FROM sites WHERE status IN ('deleting', 'deleted')")).rows.map(
      (row) => row.id,
    ),
  )

  for (const [batchId, dlqEntries] of byBatch) {
    const outcome = {
      batchId,
      dlqEntries: dlqEntries.length,
      reason: dlqEntries[0]?.reason ?? null,
      rowsRaw: 0,
      rowsPreview: 0,
      inserted: false,
    }

    const manifest = await getManifest(db, batchId)
    if (!manifest) {
      outcome.skipped = 'manifest missing'
      summary.batchesSkipped += 1
      summary.perBatch.push(outcome)
      continue
    }
    outcome.manifestState = manifest.state
    if (manifest.state !== 'dead_lettered') {
      // Only a dead-lettered batch is unreachable by the worker. Anything else
      // is still the pipeline's own business and replaying it here would race
      // the process that owns it.
      outcome.skipped = `manifest is ${manifest.state}`
      summary.batchesSkipped += 1
      summary.perBatch.push(outcome)
      continue
    }

    const storedDropped = new Set(
      (await listBatchSites(db, batchId))
        .filter((decision) => !decision.admitted)
        .map((decision) => decision.siteId),
    )

    // Manifest order, never dead-letter order: the deduplication token only
    // recognises a re-issue of the same rows in the same order (02 §7.5).
    const position = new Map(manifest.items.map((item, index) => [item.messageId, index]))
    const ordered = [...dlqEntries].sort(
      (a, b) =>
        (position.get(a.original_id) ?? Number.MAX_SAFE_INTEGER) -
        (position.get(b.original_id) ?? Number.MAX_SAFE_INTEGER),
    )

    const rows = []
    const previewRows = []
    for (const entry of ordered) {
      let parsed
      try {
        parsed = JSON.parse(entry.payload)
      } catch {
        summary.payloadsInvalid += 1
        continue
      }
      const result = persistedEventSchema.safeParse(parsed)
      if (!result.success) {
        summary.payloadsInvalid += 1
        continue
      }
      const event = result.data
      if (storedDropped.has(event.site_id)) {
        summary.droppedStoredFence += 1
        continue
      }
      if (tombstoned.has(event.site_id)) {
        summary.droppedTombstone += 1
        continue
      }
      if (event.test_mode) previewRows.push(toEventsPreviewRow(event, { batchId }))
      else rows.push(toEventsRawRow(event, { batchId }))
    }

    outcome.rowsRaw = rows.length
    outcome.rowsPreview = previewRows.length
    summary.rowsRaw += rows.length
    summary.rowsPreview += previewRows.length

    if (MODE === 'execute') {
      try {
        if (rows.length > 0) {
          const result = await clickhouse.insertEvents(rows, { token: batchId })
          summary.rowsInserted += result.rows ?? rows.length
        }
        if (previewRows.length > 0) {
          const result = await clickhouse.insertPreviewEvents(previewRows, { token: batchId })
          summary.previewRowsInserted += result.rows ?? previewRows.length
        }
        outcome.inserted = true
        summary.batchesReplayed += 1
      } catch (error) {
        outcome.error = error?.constructor?.name ?? 'Error'
        summary.insertErrors.push({ batchId, error: outcome.error })
      }
    }

    summary.perBatch.push(outcome)
  }
} finally {
  console.log(JSON.stringify(summary, null, 2))
  await pool.end()
  await client.quit()
}
