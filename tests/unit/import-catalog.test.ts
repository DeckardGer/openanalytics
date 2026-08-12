import {
  IMPORT_PROVIDERS,
  IMPORT_RUN_DISCARDABLE_STATES,
  IMPORT_RUN_LIVE_STATES,
  IMPORT_RUN_STATES,
  findImportProvider,
  importArchiveObjectKey,
  importRunStatusFor,
  isLiveImportRunState,
  type ImportRunState,
  type ImportRunStatus,
} from '@openanalytics/domain'
import { describe, expect, it } from 'vitest'

/**
 * The two pure vocabularies M11 publishes (ADR-0032, D7 and D11).
 *
 * Both are contracts with the frontend rather than internal helpers: the catalog
 * decides what a picker may offer, and the status derivation decides what a
 * progress component renders. A silent change to either is a screen that lies,
 * which is why the table below is transcribed from the ADR rather than derived
 * from the implementation.
 */

describe('import provider catalog', () => {
  it('offers Plausible and only Plausible in this build', () => {
    // D11's scope cut: the adapter framework plus Plausible complete. Anything
    // else marked available would promise a parser that does not exist.
    const available = IMPORT_PROVIDERS.filter((provider) => provider.available)
    expect(available.map((provider) => provider.id)).toEqual(['plausible'])
  })

  it('lists the five follow-up providers rather than hiding them', () => {
    // "Supported later" and "not something we do" are different answers, and a
    // catalog carrying only working adapters could give only the second.
    expect(IMPORT_PROVIDERS.map((provider) => provider.id)).toEqual([
      'plausible',
      'umami',
      'matomo',
      'fathom',
      'google_analytics',
      'openpanel',
    ])
  })

  it('records Plausible as aggregate-only, which is what forces the read design', () => {
    // The whole D2/D4/D5 apparatus — no fake visitor ids, a cutover, widened
    // `accuracy` — exists because this value is `aggregate_only`. If it ever
    // read `event_level` the pipeline would be entitled to assumptions the
    // provider's export cannot support.
    expect(findImportProvider('plausible')?.capability).toBe('aggregate_only')
  })

  it('gives every descriptor a display name and a stable id', () => {
    for (const provider of IMPORT_PROVIDERS) {
      expect(provider.id).toMatch(/^[a-z0-9_]+$/u)
      expect(provider.displayName.length).toBeGreaterThan(0)
    }
  })

  it('answers null for an unknown or non-string id', () => {
    expect(findImportProvider('not-a-provider')).toBeNull()
    expect(findImportProvider(42)).toBeNull()
    expect(findImportProvider(undefined)).toBeNull()
  })
})

describe('import run status derivation (ADR-0032, D7)', () => {
  /** The ADR's table, transcribed. Every state appears exactly once. */
  const TABLE: readonly [ImportRunState, ImportRunStatus][] = [
    ['uploading', 'queued'],
    ['uploaded', 'queued'],
    ['validating', 'running'],
    ['processing', 'running'],
    ['ready_for_review', 'running'],
    ['publishing', 'running'],
    ['published', 'succeeded'],
    ['failed', 'failed_terminal'],
    ['discarded', 'cancelled'],
    ['superseded', 'succeeded'],
    ['rolled_back', 'cancelled'],
  ]

  it('covers every declared state, with none left over', () => {
    // A state added to the vocabulary without a status is a run the frontend
    // cannot render at all; the two lists have to move together.
    expect(TABLE.map(([state]) => state).sort()).toEqual([...IMPORT_RUN_STATES].sort())
  })

  it.each(TABLE)('derives %s → %s', (state, status) => {
    expect(importRunStatusFor(state)).toBe(status)
  })

  it('lets a live job refine the three phases it owns', () => {
    // Between retries the job is `failed_retryable`, and reporting that rather
    // than a flat `running` is the difference between "this is working" and
    // "this keeps failing and will be tried again".
    expect(importRunStatusFor('validating', 'failed_retryable')).toBe('failed_retryable')
    expect(importRunStatusFor('processing', 'failed_retryable')).toBe('failed_retryable')
    expect(importRunStatusFor('publishing', 'running')).toBe('running')
  })

  it('never lets a job status override a settled run', () => {
    // A stale job row must not make a published import look unfinished, nor a
    // discarded one look alive.
    expect(importRunStatusFor('published', 'failed_retryable')).toBe('succeeded')
    expect(importRunStatusFor('failed', 'running')).toBe('failed_terminal')
    expect(importRunStatusFor('discarded', 'running')).toBe('cancelled')
    // `ready_for_review` holds no lease at all (D7), so there is no job whose
    // status could apply — it is `running` because the customer's operation is
    // unfinished, not because something is executing.
    expect(importRunStatusFor('ready_for_review', 'failed_retryable')).toBe('running')
  })
})

describe('import run liveness', () => {
  it('holds the site slot through review, and releases it at every terminal', () => {
    // D3: a review that takes days still blocks a second import. That is the
    // whole reason `ready_for_review` is inside the partial unique's predicate.
    expect(isLiveImportRunState('ready_for_review')).toBe(true)
    for (const state of [
      'published',
      'failed',
      'discarded',
      'superseded',
      'rolled_back',
    ] as const) {
      expect(isLiveImportRunState(state)).toBe(false)
    }
  })

  it('keeps the live set a subset of the declared states', () => {
    for (const state of IMPORT_RUN_LIVE_STATES) {
      expect(IMPORT_RUN_STATES).toContain(state)
    }
  })

  it('allows a discard only where nothing is running and nothing is published', () => {
    // Past these three the run either holds a job lease or is the published
    // pointer, and undoing it is a rollback — a different operation.
    expect([...IMPORT_RUN_DISCARDABLE_STATES]).toEqual([
      'uploading',
      'uploaded',
      'ready_for_review',
    ])
  })
})

describe('import object key', () => {
  it('is id-addressed, so nothing customer-supplied steers where bytes land', () => {
    expect(importArchiveObjectKey('site-1', 'run-9')).toBe('imports/site-1/run-9/archive.zip')
  })
})
