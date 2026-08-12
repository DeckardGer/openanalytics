/**
 * Realtime gateway metric names.
 *
 * Mirrors `apps/collector/src/metrics.ts`: the set of things this service
 * reports lives in one table so an alert rule and the code that fires it cannot
 * drift, and so a reviewer sees the whole surface in one place rather than
 * scattered across call sites. The Metrics port (observability) reaches the
 * structured-log sink today and the G-006 remote-write pipeline when a service
 * is wired to it; no service code names the backend.
 *
 * Every name is a legal Prometheus metric name (`realtime_x`, never
 * `realtime.x`), for the reason spelled out in `apps/collector/src/metrics.ts`:
 * a dotted name was dropped by the remote-write exporter, so this whole table
 * was invisible in Grafana while every test that watched the in-memory sink
 * stayed green.
 *
 * Labels are low-cardinality by contract. `scope` is `private`|`public`;
 * `reason` is one of the stable control reasons. A site id, a subject or a jti
 * is never a label — that would be one series per customer or per token, and
 * subject/jti are identifiers this store does not redact.
 */
export const REALTIME_METRICS = {
  /** A stream opened after auth passed. Labelled by scope. */
  connectionOpened: 'realtime_connection_opened',
  /** A stream closed (any cause). Labelled by scope. */
  connectionClosed: 'realtime_connection_closed',
  /** A stream was closed against the client's wishes. Labelled by reason. */
  disconnect: 'realtime_disconnect',

  /** A presence snapshot was recomputed for a site. */
  snapshotComputed: 'realtime_snapshot_computed',
  /** A presence recompute failed; the stream stays open, degraded. */
  snapshotFailed: 'realtime_snapshot_failed',

  /** A per-client access-epoch re-check could not be completed (fail-closed). */
  epochCheckFailed: 'realtime_epoch_check_failed',
  /** A control-channel message was received and handled. */
  controlHandled: 'realtime_control_message_handled',
} as const

export type RealtimeMetric = (typeof REALTIME_METRICS)[keyof typeof REALTIME_METRICS]
