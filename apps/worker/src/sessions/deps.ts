import type { SessionConfig } from '@openanalytics/domain'
import type { SessionFactsStore } from '@openanalytics/clickhouse'
import type { Logger, Metrics } from '@openanalytics/observability'
import type { FinalizerState } from './state.ts'

/**
 * Everything the session finalizer may reach — a closed surface, the same
 * discipline the ingest pipeline follows (ADR-0009): what a component cannot
 * name, it cannot accidentally depend on, and every dependency is substitutable
 * in a test.
 */
export interface FinalizerDeps {
  readonly store: SessionFactsStore
  readonly state: FinalizerState
  /**
   * The lifecycle fence (ADR-0030, decision 7).
   *
   * Discovery is a ClickHouse read — it finds sites that have *events*, which is
   * a fact about the past and says nothing about whether the site still exists.
   * A site being deleted still has raw events right up until the purge, so
   * without this filter the finalizer would keep recomputing it and could insert
   * fact and rollup rows into tables the purge has already verified as empty.
   *
   * Returns only the ids whose Postgres status is `active` or `suspended`.
   * Blocked sites keep finalizing on purpose: their data is retained for the
   * whole retention window and has to be correct if the customer reactivates.
   *
   * Injected rather than reached for so the finalizer keeps its closed
   * dependency surface (ADR-0009) and stays testable without a database.
   */
  readonly filterFinalizable: (siteIds: readonly string[]) => Promise<string[]>
  /** The §10 canonical session constants the pure sessionizer is driven with. */
  readonly sessionConfig: SessionConfig
  /** Lateness allowance in ms (policy `EVENT_MAX_LATENESS_HOURS`), the watermark's other half. */
  readonly latenessMs: number
  readonly logger: Logger
  readonly metrics: Metrics
  /** Injected so tests can drive time without sleeping. */
  readonly now: () => Date
}
