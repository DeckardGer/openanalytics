import type { ObjectStorage } from '@openanalytics/integrations'
import type { Logger, Metrics } from '@openanalytics/observability'
import { WORKER_METRICS } from './ingest/metrics.ts'

/**
 * Watch the off-host ClickHouse backup from the one process that can see it
 * (ADR-0052, D10).
 *
 * ## Why here, of all places
 *
 * The backup itself runs on the ClickHouse host as a systemd timer, and that
 * host has no metrics pipeline: it holds one container and no application code.
 * The worker already holds the bucket credentials and already pushes metrics
 * through the observability port. So the watcher lives where
 * the pipe is, and it observes the backup the way an outsider would — by
 * looking for the object.
 *
 * ## Why age, and why from the bucket
 *
 * The failure that has to be caught produces no event: a timer that stopped
 * emits nothing, and there is no error to count. Age climbs by itself.
 *
 * Deriving it from the newest object rather than from the script's exit status
 * matters for a second reason — a backup job can exit `0` having uploaded
 * nothing, and only the bucket knows the difference. It is also the only
 * durable record: ClickHouse's `system.backups` is in-memory and empty after a
 * restart, so the server itself cannot say when it was last backed up.
 *
 * ## What this never needs
 *
 * The encryption key. Listing returns metadata; only reading a body needs the
 * customer key. The monitoring path therefore holds nothing that could decrypt
 * a backup, which is the property that let the alert live on a different host
 * from the key.
 */

export const BACKUP_DAILY_PREFIX = 'backups/daily/'
export const BACKUP_WEEKLY_PREFIX = 'backups/weekly/'
// There is deliberately no verify-marker gauge here. A restore rehearsal —
// something that periodically restores a backup, compares it and writes a
// green marker — is not part of this package, so a gauge over its markers
// could only ever publish "never". If a rehearsal is added, the whole bundle
// arrives together: the job that writes the marker, the gauge that ages it,
// and the alert that reads the gauge. A gauge alone is a dial wired to
// nothing, permanently reading the worst value.

export interface BackupWatchDeps {
  readonly storage: ObjectStorage
  readonly logger: Logger
  readonly metrics: Metrics
  readonly intervalMs?: number
  /** Injected in tests; defaults to the wall clock. */
  readonly now?: () => Date
}

export interface BackupWatch {
  stop(): Promise<void>
}

/**
 * Fifteen minutes. The threshold is 24 hours, so this is far finer than it needs
 * to be, and it is cheap: two listings.
 *
 * It does **not** make the series continuous, and the sentence claiming it did
 * was wrong — measured on 2026-08-09, the day this deployed. A gauge is written
 * once per interval and the remote-write adapter sends a gauge only on the flush
 * that follows a write, so Prometheus receives one sample per quarter hour while
 * an instant query looks back five minutes. Grafana Explore showed "No data" over
 * a one-hour window and the full series over six hours, at the same moment.
 *
 * The alert rule carries the fix (`last_over_time(...[1h])` in
 * `infra/grafana/alert-rules.yaml`) rather than this constant, because widening
 * the query costs nothing and shortening this interval would buy resolution
 * nobody reads against a 24-hour threshold. Anything that queries this gauge
 * must span the cadence — do not assume a sample is there right now.
 */
const DEFAULT_INTERVAL_MS = 900_000

const ageSeconds = (now: Date, at: Date): number =>
  Math.max(0, Math.round((now.getTime() - at.getTime()) / 1000))

export async function checkBackupsOnce(deps: BackupWatchDeps): Promise<void> {
  const now = (deps.now ?? (() => new Date()))()

  const daily = await deps.storage.newestUnder(BACKUP_DAILY_PREFIX)
  const weekly = await deps.storage.newestUnder(BACKUP_WEEKLY_PREFIX)

  // An empty prefix is reported as a very large age rather than skipped. A
  // series that simply does not exist until the first backup lands is
  // indistinguishable from a watcher that never ran, and "no backup has ever
  // been taken" is the loudest case this can encounter, not a reason to stay
  // silent. `noDataState: Alerting` on the rule covers the watcher dying; this
  // covers the bucket being empty.
  const NEVER_SECONDS = 315_360_000 // ten years

  if (daily === null) {
    deps.metrics.gauge(WORKER_METRICS.clickhouseBackupAgeSeconds, NEVER_SECONDS)
    deps.metrics.gauge(WORKER_METRICS.clickhouseBackupBytes, 0)
    deps.logger.warn('clickhouse_backup_absent', { prefix: BACKUP_DAILY_PREFIX })
  } else {
    const age = ageSeconds(now, daily.lastModified)
    deps.metrics.gauge(WORKER_METRICS.clickhouseBackupAgeSeconds, age)
    deps.metrics.gauge(WORKER_METRICS.clickhouseBackupBytes, daily.size)
    deps.logger.info('clickhouse_backup_seen', {
      key: daily.key,
      age_seconds: age,
      bytes: daily.size,
    })
  }

  deps.metrics.gauge(
    WORKER_METRICS.clickhouseBackupWeeklyAgeSeconds,
    weekly === null ? NEVER_SECONDS : ageSeconds(now, weekly.lastModified),
  )
}

export function startBackupWatch(deps: BackupWatchDeps): BackupWatch {
  let running = false
  let stopped = false

  const tick = async (): Promise<void> => {
    if (running || stopped) return
    running = true
    try {
      await checkBackupsOnce(deps)
    } catch (err) {
      // A failed check is its own signal, and deliberately not the same one as
      // a stale backup: this says the watcher is blind (storage unreachable,
      // credentials rejected), not that the backup is old. Publishing a large
      // age here instead would page the operator about backups when the actual
      // fault is in the monitoring path.
      deps.metrics.increment(WORKER_METRICS.clickhouseBackupCheckFailed)
      deps.logger.error('clickhouse_backup_check_failed', { err, retryable: true })
    } finally {
      running = false
    }
  }

  // One immediate pass, so a restarted worker republishes the gauge without
  // waiting a quarter of an hour for its first sample.
  void tick()

  const timer = setInterval(() => void tick(), deps.intervalMs ?? DEFAULT_INTERVAL_MS)
  timer.unref()

  return {
    async stop() {
      stopped = true
      clearInterval(timer)
      while (running) {
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
    },
  }
}
