import type { Policy } from '@openanalytics/domain'
import type { EventsIngest } from '@openanalytics/clickhouse'
import type { Logger, Metrics } from '@openanalytics/observability'
import type { Database } from '@openanalytics/postgres'
import type { EventStreamConsumer, QueueMaintenance, RealtimeCache } from '@openanalytics/redis'

/**
 * Everything the ingest pipeline may reach.
 *
 * A closed surface, for the same reason the collector has one (ADR-0009): what
 * a component cannot name, it cannot accidentally depend on. It also makes the
 * crash matrix testable — every failure the plan enumerates is produced by
 * substituting one of these, so the tests exercise the real pipeline rather than
 * a rehearsal of it.
 */
export interface IngestDeps {
  readonly db: Database
  readonly consumer: EventStreamConsumer
  readonly maintenance: QueueMaintenance
  readonly clickhouse: EventsIngest
  /**
   * The near-realtime usage counter the collector writes (ADR-0009).
   *
   * Optional, and every use is best-effort: it is reconstructible state on the
   * losable Valkey instance (D-205), and a reconciliation that could fail a
   * batch would let a cache outage stop analytics ingest.
   */
  readonly cache: RealtimeCache | null
  readonly logger: Logger
  readonly metrics: Metrics
  readonly policy: Policy
  /** Stable per process: it is the identity the pending list and lease record. */
  readonly consumerName: string
  readonly streamName: string
  readonly consumerGroup: string
  /** Injected so tests can drive time without sleeping. */
  readonly now: () => Date
}
