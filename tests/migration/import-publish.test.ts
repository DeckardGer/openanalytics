import {
  claimImportRunForCleanup,
  createDatabase,
  createImportRun,
  createPool,
  createSiteWithOwner,
  listCleanableImportRuns,
  listCleanableSiteImportRuns,
  newId,
  publishImportRun,
  readImportRun,
  recordStagingChunkBytes,
  recordStagingProgress,
  releaseImportRunCleanupClaim,
  rollbackImportRun,
  transitionImportRun,
  type Database,
} from '@openanalytics/postgres'
import { applyPostgresStreams } from '../support/postgres-streams.ts'
import { createCapturedLogger } from '@openanalytics/testkit'
import { Client, type Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * Publish, rollback and cleanup against a real Postgres (ADR-0032, D3/D7;
 * migration 0031).
 *
 * Everything here is a **database fact** rather than a TypeScript one, and each
 * is load-bearing somewhere the application cannot compensate:
 *
 * 1. **The pointer swap is one transaction.** There must be no instant at which
 *    `sites.published_import_run_id` names a run that is not `published`, and
 *    none at which two runs claim to be. Only a real transaction can show that.
 * 2. **`superseded_run_id` is written during the swap**, which is what makes
 *    rollback a lookup instead of "the most recent superseded run" — an
 *    inference that agrees with the truth only until a cleanup fails or two runs
 *    settle in the same millisecond.
 * 3. **Double publish is idempotent by state**, because the guard is in the
 *    `WHERE`. A lease stolen between the commit and the settlement re-runs the
 *    executor, and it must find "already published" rather than swap again — a
 *    second swap would record the run as its own predecessor and destroy the
 *    rollback generation.
 * 4. **Rollback has two branches** and both must move the pointer: to the
 *    predecessor when there is one, to NULL when there is not. A first import
 *    rolled back leaves the site exactly where it was.
 * 5. **The cleanup queries keep exactly one rollback generation.** A
 *    `superseded` run that is still some run's `superseded_run_id` must never be
 *    selected — erasing its ClickHouse rows would make the customer's next
 *    rollback produce an empty dashboard.
 * 6. **The backstop's deadline is SQL `now()`** against a database-stamped
 *    column, the M10 rule.
 */

const CONNECTION_STRING = process.env['TEST_POSTGRES_URL']
const describeIfPostgres = CONNECTION_STRING ? describe : describe.skip

describeIfPostgres('import publish and rollback', () => {
  const connectionString = CONNECTION_STRING as string
  const schemaName = `m11pub_${Date.now()}_${Math.floor(Math.random() * 1e6)}`
  let pool: Pool
  let db: Database
  let ownerId: string

  const makeSite = async (): Promise<string> => {
    const { siteId } = await createSiteWithOwner(db, {
      slug: `s-${newId()}`,
      name: 'S',
      ownerUserId: ownerId,
    })
    return siteId
  }

  /** A run parked in `ready_for_review`, the state a publish starts from. */
  const reviewedRun = async (siteId: string): Promise<string> => {
    const created = await createImportRun(db, {
      siteId,
      provider: 'plausible',
      declaredBytes: 1_024,
      contentType: 'application/zip',
    })
    if (!created.ok) throw new Error(`could not create a run: ${created.conflict}`)
    const runId = created.run.id
    for (const [from, to] of [
      ['uploading', 'uploaded'],
      ['uploaded', 'validating'],
      ['validating', 'processing'],
      ['processing', 'ready_for_review'],
    ] as const) {
      await transitionImportRun(db, { importRunId: runId, from: [from], to })
    }
    return runId
  }

  /** Take a reviewed run all the way to `published`. */
  const publish = async (siteId: string, runId: string) => {
    await transitionImportRun(db, {
      importRunId: runId,
      from: ['ready_for_review'],
      to: 'publishing',
      cutoverDate: '2024-04-01',
    })
    return await publishImportRun(db, { siteId, importRunId: runId })
  }

  const pointerOf = async (siteId: string): Promise<string | null> => {
    const r = await pool.query<{ published_import_run_id: string | null }>(
      `SELECT published_import_run_id FROM sites WHERE id = $1`,
      [siteId],
    )
    return r.rows[0]?.published_import_run_id ?? null
  }

  const stateOf = async (runId: string): Promise<string | null> => {
    const r = await pool.query<{ state: string }>(`SELECT state FROM import_runs WHERE id = $1`, [
      runId,
    ])
    return r.rows[0]?.state ?? null
  }

  /** Backdate a run so the TTL-based cleanup queries can see it. The column is
   * database-stamped, so a test that wants it in the past has to say so. */
  const age = async (runId: string, days: number): Promise<void> => {
    await pool.query(
      `UPDATE import_runs SET updated_at = now() - make_interval(days => $2) WHERE id = $1`,
      [runId, days],
    )
  }

  beforeAll(async () => {
    const admin = new Client({ connectionString })
    await admin.connect()
    try {
      await admin.query(`CREATE SCHEMA ${schemaName}`)
    } finally {
      await admin.end()
    }

    const url = new URL(connectionString)
    url.searchParams.set('options', `-c search_path=${schemaName}`)
    const scoped = url.toString()

    const { logger } = createCapturedLogger()
    await applyPostgresStreams({ connectionString: scoped, logger })

    pool = createPool(scoped)
    db = createDatabase(pool)

    ownerId = newId()
    await pool.query(
      `INSERT INTO users (id, name, email, email_verified) VALUES ($1, 'U', $2, true)`,
      [ownerId, `${ownerId}@example.com`],
    )
  }, 120_000)

  afterAll(async () => {
    await pool?.end()
    const admin = new Client({ connectionString })
    await admin.connect()
    try {
      await admin.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`)
    } finally {
      await admin.end()
    }
  })

  describe('migration 0031 shape', () => {
    it('adds the three columns and their indexes', async () => {
      const columns = await pool.query<{ column_name: string; data_type: string }>(
        `SELECT column_name, data_type FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = 'import_runs'
            AND column_name IN ('superseded_run_id', 'staging_progress', 'swept_at')`,
        [schemaName],
      )
      expect(
        Object.fromEntries(columns.rows.map((row) => [row.column_name, row.data_type])),
      ).toEqual({
        superseded_run_id: 'uuid',
        staging_progress: 'jsonb',
        swept_at: 'timestamp with time zone',
      })

      const indexes = await pool.query<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND tablename = 'import_runs'`,
        [schemaName],
      )
      const names = indexes.rows.map((row) => row.indexname)
      // The global backstop scan (ordered by age), the rollback lookup, and the
      // site-scoped publish-time cleanup scan. The last one cannot use the first:
      // that index leads with `updated_at` for the sweeper's ordered global page,
      // while a publish filters by site and state.
      expect(names).toContain('import_runs_sweep_idx')
      expect(names).toContain('import_runs_superseded_idx')
      expect(names).toContain('import_runs_site_sweep_idx')
    })

    it('declares the self-FK as ON DELETE SET NULL, not CASCADE', async () => {
      // CASCADE here would delete the site's *published* run because its
      // long-dead predecessor was purged.
      const r = await pool.query<{ confdeltype: string }>(
        `SELECT confdeltype FROM pg_constraint
          WHERE conrelid = ($1 || '.import_runs')::regclass
            AND contype = 'f'
            AND confrelid = ($1 || '.import_runs')::regclass`,
        [schemaName],
      )
      expect(r.rows.map((row) => row.confdeltype)).toEqual(['n'])
    })
  })

  describe('staging progress', () => {
    it('records the chunk size once and reuses it however the default moves', async () => {
      // The D7 guarantee as a database fact: `COALESCE`, not an unconditional
      // write. A deploy that retuned the policy default mid-run must not make
      // the token `{run}:{report}:{chunk}` name a different set of rows.
      const siteId = await makeSite()
      const runId = await reviewedRun(siteId)

      expect(
        await recordStagingChunkBytes(db, { importRunId: runId, proposedBytes: 8_388_608 }),
      ).toBe(8_388_608)
      expect(await recordStagingChunkBytes(db, { importRunId: runId, proposedBytes: 111 })).toBe(
        8_388_608,
      )
    })

    it('builds the per-report progress object one report at a time', async () => {
      const siteId = await makeSite()
      const runId = await reviewedRun(siteId)

      await recordStagingProgress(db, { importRunId: runId, report: 'metrics', nextChunk: 3 })
      await recordStagingProgress(db, { importRunId: runId, report: 'pages', nextChunk: 1 })
      await recordStagingProgress(db, { importRunId: runId, report: 'metrics', nextChunk: 4 })

      const run = await readImportRun(db, { siteId, importRunId: runId })
      expect(run?.stagingProgress).toEqual({ metrics: 4, pages: 1 })
    })
  })

  describe('the publish swap', () => {
    it('moves the pointer, publishes the run and supersedes the previous one', async () => {
      const siteId = await makeSite()
      const first = await reviewedRun(siteId)
      const firstResult = await publish(siteId, first)

      expect(firstResult).toMatchObject({ ok: true, swapped: true, predecessorRunId: null })
      expect(await pointerOf(siteId)).toBe(first)
      expect(await stateOf(first)).toBe('published')

      const second = await reviewedRun(siteId)
      const secondResult = await publish(siteId, second)

      expect(secondResult).toMatchObject({ ok: true, swapped: true, predecessorRunId: first })
      expect(await pointerOf(siteId)).toBe(second)
      expect(await stateOf(second)).toBe('published')
      expect(await stateOf(first)).toBe('superseded')

      // The rollback generation, recorded rather than inferred.
      const run = await readImportRun(db, { siteId, importRunId: second })
      expect(run?.supersededRunId).toBe(first)
      expect(run?.cutoverDate).toBe('2024-04-01')
    })

    it('is idempotent: a second publish of the same run swaps nothing', async () => {
      // The case a stolen lease produces. A second swap would record the run as
      // its own predecessor and destroy the rollback generation.
      const siteId = await makeSite()
      const first = await reviewedRun(siteId)
      await publish(siteId, first)
      const second = await reviewedRun(siteId)
      await publish(siteId, second)

      const again = await publishImportRun(db, { siteId, importRunId: second })
      expect(again).toMatchObject({ ok: true, swapped: false, predecessorRunId: first })
      expect(await pointerOf(siteId)).toBe(second)
      expect(await stateOf(first)).toBe('superseded')
    })

    it('refuses a run that is not `publishing`', async () => {
      const siteId = await makeSite()
      const runId = await reviewedRun(siteId)
      expect(await publishImportRun(db, { siteId, importRunId: runId })).toEqual({
        ok: false,
        conflict: 'state',
      })
      expect(await pointerOf(siteId)).toBeNull()
    })

    it('refuses a site that is being deleted', async () => {
      const siteId = await makeSite()
      const runId = await reviewedRun(siteId)
      await transitionImportRun(db, {
        importRunId: runId,
        from: ['ready_for_review'],
        to: 'publishing',
      })
      await pool.query(`UPDATE sites SET status = 'deleting' WHERE id = $1`, [siteId])

      expect(await publishImportRun(db, { siteId, importRunId: runId })).toEqual({
        ok: false,
        conflict: 'site_unavailable',
      })
      await pool.query(`UPDATE sites SET status = 'active' WHERE id = $1`, [siteId])
    })
  })

  describe('rollback', () => {
    it('restores the predecessor and repoints the site', async () => {
      const siteId = await makeSite()
      const first = await reviewedRun(siteId)
      await publish(siteId, first)
      const second = await reviewedRun(siteId)
      await publish(siteId, second)

      expect(await rollbackImportRun(db, { siteId, importRunId: second })).toEqual({
        ok: true,
        restoredRunId: first,
      })
      expect(await pointerOf(siteId)).toBe(first)
      expect(await stateOf(first)).toBe('published')
      expect(await stateOf(second)).toBe('rolled_back')
    })

    it('nulls the pointer when the run was the first import of the site', async () => {
      // A valid rollback, not an error: the site returns to having no imported
      // history, which is exactly where it was before the import.
      const siteId = await makeSite()
      const only = await reviewedRun(siteId)
      await publish(siteId, only)

      expect(await rollbackImportRun(db, { siteId, importRunId: only })).toEqual({
        ok: true,
        restoredRunId: null,
      })
      expect(await pointerOf(siteId)).toBeNull()
      expect(await stateOf(only)).toBe('rolled_back')
    })

    it('refuses a run that is not the one the pointer names', async () => {
      const siteId = await makeSite()
      const first = await reviewedRun(siteId)
      await publish(siteId, first)
      const second = await reviewedRun(siteId)
      await publish(siteId, second)

      // `first` is published history, but `second` is what the site shows.
      expect(await rollbackImportRun(db, { siteId, importRunId: first })).toEqual({
        ok: false,
        conflict: 'not_published',
      })
      expect(await pointerOf(siteId)).toBe(second)
    })

    it('REFUSES when the generation it would restore has already been cleaned', async () => {
      // ADR-0032 D3 keeps exactly one rollback generation, so publishing C
      // cleans A. Rolling C back restores B; rolling B back would have to
      // restore A, and A's staged rows are gone.
      //
      // The old behaviour was to restore nothing and null the pointer, which
      // turned "undo this import" into "lose this import AND the one before it"
      // — a customer asking to go back one step would land on an empty
      // dashboard. Refusing leaves the published run exactly where it is.
      const siteId = await makeSite()
      const a = await reviewedRun(siteId)
      await publish(siteId, a)
      const b = await reviewedRun(siteId)
      await publish(siteId, b)
      const c = await reviewedRun(siteId)
      await publish(siteId, c)

      // What the publish of C does to the grandparent, done here directly.
      expect(await claimImportRunForCleanup(db, { importRunId: a })).toBe(true)

      expect(await rollbackImportRun(db, { siteId, importRunId: c })).toEqual({
        ok: true,
        restoredRunId: b,
      })
      expect(await pointerOf(siteId)).toBe(b)

      expect(await rollbackImportRun(db, { siteId, importRunId: b })).toEqual({
        ok: false,
        conflict: 'generation_erased',
      })
      // Nothing moved: B is still published and still the pointer.
      expect(await pointerOf(siteId)).toBe(b)
      expect(await stateOf(b)).toBe('published')
      expect(await stateOf(a)).toBe('superseded')
    })

    it('refuses rather than half-applying when the predecessor moved state', async () => {
      // Same guard, different cause: an operator or a later publish moved the
      // predecessor out of `superseded`. Resurrecting it into `published` would
      // put two runs in that state.
      const siteId = await makeSite()
      const first = await reviewedRun(siteId)
      await publish(siteId, first)
      const second = await reviewedRun(siteId)
      await publish(siteId, second)

      await pool.query(`UPDATE import_runs SET state = 'failed' WHERE id = $1`, [first])

      expect(await rollbackImportRun(db, { siteId, importRunId: second })).toEqual({
        ok: false,
        conflict: 'generation_erased',
      })
      expect(await pointerOf(siteId)).toBe(second)
      expect(await stateOf(second)).toBe('published')
    })

    it('leaves the site with no imported history after rolling back twice', async () => {
      // Exactly one rollback generation (D3): after restoring the predecessor,
      // the predecessor's own predecessor is not reachable.
      const siteId = await makeSite()
      const first = await reviewedRun(siteId)
      await publish(siteId, first)
      const second = await reviewedRun(siteId)
      await publish(siteId, second)

      await rollbackImportRun(db, { siteId, importRunId: second })
      expect(await rollbackImportRun(db, { siteId, importRunId: first })).toEqual({
        ok: true,
        restoredRunId: null,
      })
      expect(await pointerOf(siteId)).toBeNull()
    })
  })

  describe('cleanup selection', () => {
    it('offers the grandparent and never the rollback generation', async () => {
      const siteId = await makeSite()
      const a = await reviewedRun(siteId)
      await publish(siteId, a)
      const b = await reviewedRun(siteId)
      await publish(siteId, b)
      const c = await reviewedRun(siteId)
      const result = await publish(siteId, c)
      if (!result.ok) throw new Error('publish failed')

      const candidates = await listCleanableSiteImportRuns(db, {
        siteId,
        predecessorRunId: result.predecessorRunId,
        ttlDays: 7,
      })
      // `a` is the grandparent; `b` is what a rollback of `c` would restore.
      expect(candidates.map((row) => row.importRunId)).toEqual([a])
      // The object key comes from the upload row, which is what makes the
      // archive findable at all — the port has no `list`.
      expect(candidates[0]?.objectKey).toContain(a)
    })

    it('also offers long-dead terminal runs of the same site', async () => {
      const siteId = await makeSite()
      const failed = await reviewedRun(siteId)
      await transitionImportRun(db, {
        importRunId: failed,
        from: ['ready_for_review'],
        to: 'failed',
        errorCode: 'malformed_archive',
        finished: true,
      })
      await age(failed, 30)

      const published = await reviewedRun(siteId)
      const result = await publish(siteId, published)
      if (!result.ok) throw new Error('publish failed')

      const candidates = await listCleanableSiteImportRuns(db, {
        siteId,
        predecessorRunId: result.predecessorRunId,
        ttlDays: 7,
      })
      expect(candidates.map((row) => row.importRunId)).toEqual([failed])
    })

    it('excludes a swept run so a repeated publish does not redo the work', async () => {
      const siteId = await makeSite()
      const a = await reviewedRun(siteId)
      await publish(siteId, a)
      const b = await reviewedRun(siteId)
      await publish(siteId, b)
      const c = await reviewedRun(siteId)
      const result = await publish(siteId, c)
      if (!result.ok) throw new Error('publish failed')

      expect(await claimImportRunForCleanup(db, { importRunId: a })).toBe(true)
      expect(
        await listCleanableSiteImportRuns(db, {
          siteId,
          predecessorRunId: result.predecessorRunId,
          ttlDays: 7,
        }),
      ).toEqual([])
    })
  })

  describe('the cleanup claim', () => {
    it('is exclusive: the second caller gets nothing', async () => {
      // The cleanup runs outside any transaction and issues eight ClickHouse
      // mutations per run, so two cleaners reaching the same candidate is a real
      // interleaving rather than a theoretical one.
      const siteId = await makeSite()
      const runId = await reviewedRun(siteId)
      await transitionImportRun(db, {
        importRunId: runId,
        from: ['ready_for_review'],
        to: 'discarded',
        finished: true,
      })

      expect(await claimImportRunForCleanup(db, { importRunId: runId })).toBe(true)
      expect(await claimImportRunForCleanup(db, { importRunId: runId })).toBe(false)
    })

    it('refuses a run whose state left the cleanable set', async () => {
      // The state guard is what a *republished* run trips. Without it, a rollback
      // landing between the candidate list and the delete would have its restored
      // rows erased underneath it.
      const siteId = await makeSite()
      const runId = await reviewedRun(siteId)
      await publish(siteId, runId)

      expect(await claimImportRunForCleanup(db, { importRunId: runId })).toBe(false)
      const run = await readImportRun(db, { siteId, importRunId: runId })
      expect(run?.sweptAt).toBeNull()
    })

    it('makes the run unrollbackable, which is the other half of the same race', async () => {
      // The claim and the rollback guard are one mechanism seen from two sides:
      // whoever writes first wins, and the loser is told. A cleaner that has
      // claimed the predecessor cannot have it restored underneath it.
      const siteId = await makeSite()
      const first = await reviewedRun(siteId)
      await publish(siteId, first)
      const second = await reviewedRun(siteId)
      await publish(siteId, second)

      expect(await claimImportRunForCleanup(db, { importRunId: first })).toBe(true)
      expect(await rollbackImportRun(db, { siteId, importRunId: second })).toEqual({
        ok: false,
        conflict: 'generation_erased',
      })
    })

    it('can be handed back when the ClickHouse delete fails', async () => {
      const siteId = await makeSite()
      const runId = await reviewedRun(siteId)
      await transitionImportRun(db, {
        importRunId: runId,
        from: ['ready_for_review'],
        to: 'failed',
        errorCode: 'malformed_archive',
        finished: true,
      })

      expect(await claimImportRunForCleanup(db, { importRunId: runId })).toBe(true)
      await releaseImportRunCleanupClaim(db, { importRunId: runId })
      // Available again, which is what keeps a failed delete from becoming a
      // leak nothing revisits.
      expect(await claimImportRunForCleanup(db, { importRunId: runId })).toBe(true)
    })
  })

  describe('the sweeper backstop', () => {
    it('finds terminal runs past the TTL, compared against the DB clock', async () => {
      const siteId = await makeSite()
      const fresh = await reviewedRun(siteId)
      await transitionImportRun(db, {
        importRunId: fresh,
        from: ['ready_for_review'],
        to: 'discarded',
        finished: true,
      })

      // Inside the TTL: not a candidate. The deadline is computed in SQL against
      // `now()`, so a worker whose clock runs ahead cannot pull it in.
      let found = await listCleanableImportRuns(db, { ttlDays: 7, limit: 50 })
      expect(found.map((row) => row.importRunId)).not.toContain(fresh)

      await age(fresh, 30)
      found = await listCleanableImportRuns(db, { ttlDays: 7, limit: 50 })
      expect(found.map((row) => row.importRunId)).toContain(fresh)
    })

    it('never offers a superseded run that is still a predecessor', async () => {
      // This is the clause that keeps the one rollback generation alive. Erasing
      // this run's ClickHouse rows would make the customer's next rollback
      // produce an empty dashboard.
      const siteId = await makeSite()
      const first = await reviewedRun(siteId)
      await publish(siteId, first)
      const second = await reviewedRun(siteId)
      await publish(siteId, second)
      await age(first, 90)

      const found = await listCleanableImportRuns(db, { ttlDays: 7, limit: 50 })
      expect(found.map((row) => row.importRunId)).not.toContain(first)
    })

    it('offers a grandparent whose successor is itself only superseded', async () => {
      // The predicate has to name the *published* successor. Matching any
      // successor at all protects every generation forever: after A -> B -> C,
      // B still points at A, so A — a plain grandparent nothing can reach — would
      // never be swept and its staged rows would sit in ClickHouse for the life
      // of the installation.
      const siteId = await makeSite()
      const a = await reviewedRun(siteId)
      await publish(siteId, a)
      const b = await reviewedRun(siteId)
      await publish(siteId, b)
      const c = await reviewedRun(siteId)
      await publish(siteId, c)
      await age(a, 90)
      await age(b, 90)

      const found = await listCleanableImportRuns(db, { ttlDays: 7, limit: 50 })
      const ids = found.map((row) => row.importRunId)
      // A is reachable by nothing; B is what a rollback of C would restore.
      expect(ids).toContain(a)
      expect(ids).not.toContain(b)
    })

    it('offers it once the successor is gone', async () => {
      const siteId = await makeSite()
      const first = await reviewedRun(siteId)
      await publish(siteId, first)
      const second = await reviewedRun(siteId)
      await publish(siteId, second)
      await age(first, 90)

      // A rollback clears `second.superseded_run_id`'s meaning by moving the
      // pointer back — but the row keeps pointing, so the direct case is the
      // successor being deleted (a purge, or the sweeper's own removal later).
      await pool.query(`UPDATE import_runs SET superseded_run_id = NULL WHERE id = $1`, [second])

      const found = await listCleanableImportRuns(db, { ttlDays: 7, limit: 50 })
      expect(found.map((row) => row.importRunId)).toContain(first)
    })

    it('stops offering a run once it is marked swept', async () => {
      const siteId = await makeSite()
      const runId = await reviewedRun(siteId)
      await transitionImportRun(db, {
        importRunId: runId,
        from: ['ready_for_review'],
        to: 'discarded',
        finished: true,
      })
      await age(runId, 30)

      expect(await claimImportRunForCleanup(db, { importRunId: runId })).toBe(true)
      const found = await listCleanableImportRuns(db, { ttlDays: 7, limit: 50 })
      expect(found.map((row) => row.importRunId)).not.toContain(runId)
    })

    it('never offers a published run', async () => {
      // Its rows are the site's live data.
      const siteId = await makeSite()
      const runId = await reviewedRun(siteId)
      await publish(siteId, runId)
      await age(runId, 90)

      const found = await listCleanableImportRuns(db, { ttlDays: 7, limit: 50 })
      expect(found.map((row) => row.importRunId)).not.toContain(runId)
    })
  })
})
