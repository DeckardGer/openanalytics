import { REALTIME_SNAPSHOT_MAX_AGE_SECONDS } from '@openanalytics/contracts'
import { PolicyValidationError, loadPolicy, policySchema } from '@openanalytics/domain'
import { describe, expect, it } from 'vitest'

/**
 * The cross-field invariants are the point of this suite. Each one, if violated,
 * fails silently in production — no exception, just wrong data or lost events.
 */
describe('policy configuration', () => {
  it('applies the documented defaults', () => {
    const policy = loadPolicy({})

    expect(policy.EVENT_MAX_LATENESS_HOURS).toBe(24)
    expect(policy.EVENT_MAX_FUTURE_SKEW_SECONDS).toBe(300)
    expect(policy.INGEST_DEDUP_TTL_DAYS).toBe(7)
    expect(policy.SESSION_INACTIVITY_MINUTES).toBe(30)
    expect(policy.SESSION_MAX_LENGTH_HOURS).toBe(24)
  })

  it('carries the ADR-0018 session cap default of 24 hours and bounds it 1..48', () => {
    // A session lasts at most 24h (closed product decision 2026-07-25, ADR-0018):
    // the bound that keeps the finalizer watermark advancing past a never-ending
    // stream (ADR-0012's open item).
    expect(loadPolicy({}).SESSION_MAX_LENGTH_HOURS).toBe(24)
    expect(policySchema.safeParse({ SESSION_MAX_LENGTH_HOURS: '0' }).success).toBe(false)
    expect(policySchema.safeParse({ SESSION_MAX_LENGTH_HOURS: '49' }).success).toBe(false)
    expect(policySchema.safeParse({ SESSION_MAX_LENGTH_HOURS: '48' }).success).toBe(true)
    expect(policySchema.safeParse({ SESSION_MAX_LENGTH_HOURS: '1' }).success).toBe(true)
  })

  it('rejects a session cap that does not exceed the inactivity window (ADR-0018)', () => {
    // A cap shorter than the meaningful-inactivity gap would fire before an
    // inactivity split ever could, silently ending every session at the cap. In
    // hours the cap must sit strictly above the 30-minute rule.
    expect(() =>
      loadPolicy({ SESSION_MAX_LENGTH_HOURS: '1', SESSION_INACTIVITY_MINUTES: '90' }),
    ).toThrow(PolicyValidationError)
    // 1h == 60min is not strictly greater than a 60-minute window.
    expect(() =>
      loadPolicy({ SESSION_MAX_LENGTH_HOURS: '1', SESSION_INACTIVITY_MINUTES: '60' }),
    ).toThrow(PolicyValidationError)
    expect(() =>
      loadPolicy({ SESSION_MAX_LENGTH_HOURS: '1', SESSION_INACTIVITY_MINUTES: '59' }),
    ).not.toThrow()
  })

  it('rejects a dedup window that does not outlast accepted event lateness', () => {
    // A tracker may retry for the full lateness window. If the dedup record
    // expires first, that retry is stored and billed as a new event.
    expect(() =>
      loadPolicy({ INGEST_DEDUP_TTL_DAYS: '1', EVENT_MAX_LATENESS_HOURS: '24' }),
    ).toThrow(PolicyValidationError)

    expect(() =>
      loadPolicy({ INGEST_DEDUP_TTL_DAYS: '2', EVENT_MAX_LATENESS_HOURS: '24' }),
    ).not.toThrow()
  })

  it('rejects a queue index TTL that expires before the payloads it indexes', () => {
    // Deletion locates retained stream entries through the index. If the index
    // goes first, deletion cannot prove it removed everything.
    expect(() =>
      loadPolicy({ SITE_QUEUE_INDEX_TTL_DAYS: '7', ACKED_QUEUE_RETENTION_DAYS: '7' }),
    ).toThrow(PolicyValidationError)
  })

  it('rejects an idempotency orphan horizon that the replay horizon already covers', () => {
    // The in-flight disjunct only ever fires between the two horizons. Set the
    // orphan horizon at or past the replay one and the sweep still deletes
    // expired rows — it simply never frees a key held by a dead handler, which
    // is the half that cannot be observed from the outside.
    expect(() =>
      loadPolicy({
        IDEMPOTENCY_CLAIM_MAX_AGE_HOURS: '24',
        IDEMPOTENCY_KEY_RETENTION_HOURS: '24',
      }),
    ).toThrow(PolicyValidationError)
    expect(() =>
      loadPolicy({
        IDEMPOTENCY_CLAIM_MAX_AGE_HOURS: '48',
        IDEMPOTENCY_KEY_RETENTION_HOURS: '24',
      }),
    ).toThrow(PolicyValidationError)
    expect(
      loadPolicy({
        IDEMPOTENCY_CLAIM_MAX_AGE_HOURS: '1',
        IDEMPOTENCY_KEY_RETENTION_HOURS: '24',
      }).IDEMPOTENCY_CLAIM_MAX_AGE_HOURS,
    ).toBe(1)
  })

  it('caps the realtime token TTL at 60 seconds', () => {
    // Docs snapshot 05, D-213: a longer-lived token would outlive an access
    // epoch bump and keep a removed member connected.
    expect(policySchema.safeParse({ REALTIME_TOKEN_TTL_SECONDS: '120' }).success).toBe(false)
    expect(policySchema.safeParse({ REALTIME_TOKEN_TTL_SECONDS: '60' }).success).toBe(true)
  })

  it('caps the realtime epoch re-check at 15 seconds', () => {
    expect(policySchema.safeParse({ REALTIME_EPOCH_CHECK_SECONDS: '30' }).success).toBe(false)
  })

  it('caps the realtime snapshot cache at 2 seconds', () => {
    // Docs snapshot 02 §17: "a snapshot may be cached 1–2 seconds" — the 2s is
    // the documented bound, so the schema refuses a longer cache rather than
    // trusting the deployment to keep "realtime" realtime.
    expect(policySchema.safeParse({ REALTIME_SNAPSHOT_CACHE_SECONDS: '3' }).success).toBe(false)
    expect(policySchema.safeParse({ REALTIME_SNAPSHOT_CACHE_SECONDS: '2' }).success).toBe(true)
    expect(loadPolicy({}).REALTIME_SNAPSHOT_CACHE_SECONDS).toBe(2)
  })

  it('refuses a hub refresh faster than the snapshot cache window', () => {
    // ADR-0035 D5. The timer exists so a quiet site's count cannot freeze; a
    // cadence below the cache window would wake the hub only to find the cached
    // snapshot still fresh, so the configured number would stop describing what
    // the stream actually does.
    expect(loadPolicy({}).REALTIME_SNAPSHOT_REFRESH_SECONDS).toBe(10)
    expect(
      policySchema.safeParse({
        REALTIME_SNAPSHOT_CACHE_SECONDS: '2',
        REALTIME_SNAPSHOT_REFRESH_SECONDS: '1',
      }).success,
    ).toBe(false)
    expect(
      policySchema.safeParse({
        REALTIME_SNAPSHOT_CACHE_SECONDS: '2',
        REALTIME_SNAPSHOT_REFRESH_SECONDS: '2',
      }).success,
    ).toBe(true)
  })

  it('leaves a client room for one bad tick before it calls a stream dead', () => {
    // The wire-side threshold mirrors the gateway's cadence the way
    // REALTIME_FEED_MAX_EVENTS mirrors PRESENCE_FEED_MAX: the two packages share
    // no import, so the relation is pinned here or nowhere.
    //
    // The relation is not "some multiple of the tick" — it is the arithmetic the
    // suppression actually produces, because an earlier version of this test
    // asserted `>= 3 x refresh` and was satisfied by a value with **zero**
    // margin. The gateway withholds an unchanged snapshot for maxAge/2, which
    // rounds up to a whole number of ticks; one failed or slow recompute then
    // costs one more tick. That total is what a client must still tolerate.
    const refresh = loadPolicy({}).REALTIME_SNAPSHOT_REFRESH_SECONDS
    const resendFloor = REALTIME_SNAPSHOT_MAX_AGE_SECONDS / 2
    const steadyGap = Math.ceil(resendFloor / refresh) * refresh
    const afterOneMissedTick = steadyGap + refresh

    expect(steadyGap).toBe(20)
    expect(afterOneMissedTick).toBeLessThan(REALTIME_SNAPSHOT_MAX_AGE_SECONDS)
    // And the suppression must still be suppressing something, or the whole
    // mechanism is a no-op dressed up as an optimisation.
    expect(steadyGap).toBeGreaterThan(refresh)
  })

  it('bounds the realtime snapshot visitor sample', () => {
    // A model bound (plan M9 item 6), not a gate value: the snapshot is computed
    // once per site and must stay cheap, so the sample is bounded and the schema
    // refuses an unbounded or trivially tiny value.
    expect(policySchema.safeParse({ REALTIME_SNAPSHOT_MAX_VISITORS: '99' }).success).toBe(false)
    expect(policySchema.safeParse({ REALTIME_SNAPSHOT_MAX_VISITORS: '20001' }).success).toBe(false)
    expect(loadPolicy({}).REALTIME_SNAPSHOT_MAX_VISITORS).toBe(5_000)
  })

  it('reports every problem at once rather than one per restart', () => {
    try {
      loadPolicy({ INGEST_DEDUP_TTL_DAYS: '1', REALTIME_TOKEN_TTL_SECONDS: '600' })
      expect.unreachable('expected PolicyValidationError')
    } catch (error) {
      expect(error).toBeInstanceOf(PolicyValidationError)
      expect((error as PolicyValidationError).issues.length).toBeGreaterThan(1)
    }
  })
})

/**
 * G-005 closed on 22 July 2026 with exact numbers. They are reproduced here so
 * that changing one in `policy.ts` fails a test naming the decision, rather than
 * silently loosening an abuse ceiling. Every value below is quoted from
 * `docs/snapshot/05-aciq-qerarlar.md` G-005 or D-103 — none is chosen here.
 */
describe('G-005 abuse ceilings and collector limits', () => {
  it('carries the closed G-005 values as defaults', () => {
    const policy = loadPolicy({})

    expect(policy.SITE_DAILY_EVENT_CEILING).toBe(6_000_000)
    expect(policy.SITE_CEILING_ALERT_CONSECUTIVE_DAYS).toBe(3)
    expect(policy.RAPID_BURN_DAILY_FRACTION).toBe(0.5)

    expect(policy.RATE_LIMIT_IP_SITE_BURST).toBe(120)
    expect(policy.RATE_LIMIT_IDENTITY_PER_MINUTE).toBe(100)
    expect(policy.RATE_LIMIT_SITE_PER_MINUTE).toBe(60_000)

    expect(policy.LIMITER_FAIL_OPEN_MAX_SECONDS).toBe(300)
    expect(policy.LIMITER_FALLBACK_IP_PER_MINUTE).toBe(120)

    expect(policy.BOT_RULESET_VERSION).toBe(1)
  })

  it('carries the D-103 buffer', () => {
    // Docs snapshot 05, D-103: at most 5,000 unpaid events past the window
    // limit, then a stable QUOTA_EXCEEDED.
    expect(loadPolicy({}).QUOTA_BUFFER_EVENTS).toBe(5_000)
  })

  it('requires the daily ceiling to be a ceiling at all', () => {
    // It was checked against the largest plan's monthly limit until the open-core
    // split — G-005's reasoning for 6,000,000 was that Pro's legitimate "all 5M in
    // one day" had to fit underneath it. That check left with the catalog it read:
    // a deployment that sells nothing has no largest plan, and an operator who
    // raises the ceiling is the only party who knows their own traffic. What
    // remains is the one thing this schema can still state.
    expect(loadPolicy({}).SITE_DAILY_EVENT_CEILING).toBeGreaterThanOrEqual(1)
    expect(() => loadPolicy({ SITE_DAILY_EVENT_CEILING: '0' })).toThrow(PolicyValidationError)
  })

  it('rejects a site-wide guard tighter than one IP is allowed to burst', () => {
    // The site total is an infrastructure guard, not a per-visitor rule. Set
    // below one IP's burst it would reject a single ordinary visitor.
    expect(() =>
      loadPolicy({ RATE_LIMIT_SITE_PER_MINUTE: '100', RATE_LIMIT_IP_SITE_BURST: '120' }),
    ).toThrow(PolicyValidationError)
  })

  it('caps fail-open at the five minutes G-005 allows', () => {
    // "≤5 minutes of fail-open"; past that the in-process fallback limiter takes
    // over. A longer window is an unbounded hole in the abuse defence, so the
    // schema refuses it rather than trusting the deployment.
    expect(policySchema.safeParse({ LIMITER_FAIL_OPEN_MAX_SECONDS: '301' }).success).toBe(false)
    expect(policySchema.safeParse({ LIMITER_FAIL_OPEN_MAX_SECONDS: '300' }).success).toBe(true)
  })

  it('keeps the rapid-burn threshold a fraction of a window', () => {
    expect(policySchema.safeParse({ RAPID_BURN_DAILY_FRACTION: '1.5' }).success).toBe(false)
    expect(policySchema.safeParse({ RAPID_BURN_DAILY_FRACTION: '0.5' }).success).toBe(true)
  })
})

/**
 * The M11 import budgets (ADR-0032, D6).
 *
 * Every one of them is enforced in two places — the api's door, which binds the
 * declared size into the upload signature, and the worker's streaming parser,
 * which enforces the rest *during* inflation. Two enforcement points and one
 * number is exactly the situation this module exists for.
 */
describe('import limits', () => {
  it('carries the ADR-0032 D6 defaults', () => {
    const policy = loadPolicy({})

    expect(policy.IMPORT_MAX_ARCHIVE_BYTES).toBe(268_435_456) // 256 MiB
    expect(policy.IMPORT_MAX_ENTRY_BYTES).toBe(1_073_741_824) // 1 GiB uncompressed
    expect(policy.IMPORT_MAX_TOTAL_UNCOMPRESSED_BYTES).toBe(2_147_483_648) // 2 GiB
    expect(policy.IMPORT_MAX_ENTRIES).toBe(32)
    expect(policy.IMPORT_MAX_ROW_BYTES).toBe(65_536) // 64 KiB
    expect(policy.IMPORT_STAGING_CHUNK_BYTES).toBe(8_388_608) // 8 MiB
    expect(policy.IMPORT_UPLOAD_TTL_DAYS).toBe(7)
  })

  it('rejects an entry cap below the archive that has to fit inside it', () => {
    // The three budgets are a chain: archive ≤ entry ≤ total. Inverted here, the
    // per-entry cap could never be the rule that fires, so a deployment raising
    // it would believe it had loosened something it had not.
    expect(() =>
      loadPolicy({ IMPORT_MAX_ARCHIVE_BYTES: '1000', IMPORT_MAX_ENTRY_BYTES: '999' }),
    ).toThrow(PolicyValidationError)
    expect(() =>
      loadPolicy({
        IMPORT_MAX_ARCHIVE_BYTES: '1000',
        IMPORT_MAX_ENTRY_BYTES: '1000',
        IMPORT_MAX_TOTAL_UNCOMPRESSED_BYTES: '1000',
      }),
    ).not.toThrow()
  })

  it('rejects a total below the single entry it has to contain', () => {
    expect(() =>
      loadPolicy({
        IMPORT_MAX_ENTRY_BYTES: '2000',
        IMPORT_MAX_TOTAL_UNCOMPRESSED_BYTES: '1999',
      }),
    ).toThrow(PolicyValidationError)
  })

  it('refuses a zero or negative budget outright', () => {
    // A zero cap is not "no limit"; it is a parser that rejects everything, and
    // the failure would look like every archive being malformed.
    expect(policySchema.safeParse({ IMPORT_MAX_ENTRIES: '0' }).success).toBe(false)
    expect(policySchema.safeParse({ IMPORT_MAX_ROW_BYTES: '0' }).success).toBe(false)
    expect(policySchema.safeParse({ IMPORT_UPLOAD_TTL_DAYS: '0' }).success).toBe(false)
  })
})
