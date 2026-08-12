import type { IdentityKey, Policy } from '@openanalytics/domain'
import type { Metrics } from '@openanalytics/observability'
import type { EventStreamQueue, RealtimeCache } from '@openanalytics/redis'
import type { IngestConfigStore } from './ingest-config-store.ts'
import type { FallbackLimiter } from './fallback-limiter.ts'
import type { GeoLookup } from './geoip.ts'
import type { CollectorCloudExtension } from './cloud-extension.ts'

/**
 * Everything the ingest routes need, injected rather than imported.
 *
 * The collector's invariants are mostly about what it does *not* reach —
 * ClickHouse, the Postgres usage row, email, a provider API (docs snapshot 02
 * §7.1) — and this list is the enforceable form of that: a route can only call
 * what is here, and nothing here can reach any of them. `tests/unit/collector-*`
 * asserts the shape of this object for exactly that reason.
 */
export interface CollectorDeps {
  /** Tracking key → versioned site ingest config, behind a short-TTL cache. */
  readonly configStore: IngestConfigStore
  /** The durable queue. A 202 is only ever answered after this succeeds. */
  readonly queue: EventStreamQueue
  /** Presence, abuse counters and the D-103 usage counter. Losable state. */
  readonly realtime: RealtimeCache
  readonly policy: Policy
  /** D-102 identity HMAC. The raw IP goes in; nothing that holds one comes out. */
  readonly identityKey: IdentityKey
  readonly metrics: Metrics
  /** G-005's last rung, used only once the bounded fail-open has expired. */
  readonly fallbackLimiter: FallbackLimiter
  /**
   * Local MMDB geo lookup (ADR-0015 addendum). Optional: without it geo is
   * simply null on every event — a degradation, never a failure.
   */
  readonly geo?: GeoLookup
  /** Injectable clock, so acceptance-time boundaries are testable. */
  readonly now?: () => Date
  /**
   * The hosted quota and suspension gates (`cloud-extension.ts`).
   *
   * Absent means those gates do not exist in this build — not that they pass.
   * The collector's invariant list above is about what it cannot reach; this is
   * the one entry that adds reach, and it adds exactly two things: the same
   * `realtime` counter already listed, and the site's plan facts resolved with
   * its config.
   */
  readonly cloud?: CollectorCloudExtension
}
