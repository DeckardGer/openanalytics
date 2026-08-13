import type { ListedObject, ObjectStorage } from '@openanalytics/integrations'
import type { Metrics } from '@openanalytics/observability'
import { describe, expect, it } from 'vitest'
import {
  BACKUP_DAILY_PREFIX,
  BACKUP_WEEKLY_PREFIX,
  checkBackupsOnce,
} from '../../apps/worker/src/backup-watch.ts'
import { WORKER_METRICS } from '../../apps/worker/src/ingest/metrics.ts'

/**
 * The backup watcher (ADR-0052, D10).
 *
 * What is pinned here is the one property the whole alert rests on: the gauge
 * reports the age of an OBJECT IN THE BUCKET, and an empty prefix is loud
 * rather than absent. Both are failure shapes that a naive implementation gets
 * wrong in the same direction — quietly reporting nothing, which reads on a
 * dashboard as "fine".
 */

const NEVER_SECONDS = 315_360_000

const collectMetrics = () => {
  const gauges = new Map<string, number>()
  const counters = new Map<string, number>()
  const metrics: Metrics = {
    gauge: (name, value) => {
      gauges.set(name, value)
    },
    increment: (name, _labels, value) => {
      counters.set(name, (counters.get(name) ?? 0) + (value ?? 1))
    },
  }
  return { metrics, gauges, counters }
}

const silentLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
} as never

const storageWith = (objects: Record<string, ListedObject | null>): ObjectStorage =>
  ({
    newestUnder: async (prefix: string) => {
      await Promise.resolve()
      return objects[prefix] ?? null
    },
  }) as unknown as ObjectStorage

const NOW = new Date('2026-08-09T12:00:00Z')

describe('backup watcher — the gauge is the age of a real object', () => {
  it('reports the age of the newest daily object, in seconds', async () => {
    const { metrics, gauges } = collectMetrics()
    await checkBackupsOnce({
      storage: storageWith({
        [BACKUP_DAILY_PREFIX]: {
          key: 'backups/daily/k1/analytics-20260809T023000Z.zip',
          size: 19302,
          lastModified: new Date('2026-08-09T02:30:00Z'),
        },
        [BACKUP_WEEKLY_PREFIX]: null,
      }),
      logger: silentLogger,
      metrics,
      now: () => NOW,
    })

    // 09:30 elapsed.
    expect(gauges.get(WORKER_METRICS.clickhouseBackupAgeSeconds)).toBe(34_200)
    expect(gauges.get(WORKER_METRICS.clickhouseBackupBytes)).toBe(19_302)
  })

  it('crosses the 24-hour RPO threshold when the backup is a day and a half old', async () => {
    const { metrics, gauges } = collectMetrics()
    await checkBackupsOnce({
      storage: storageWith({
        [BACKUP_DAILY_PREFIX]: {
          key: 'backups/daily/k1/old.zip',
          size: 19302,
          lastModified: new Date('2026-08-08T00:00:00Z'),
        },
      }),
      logger: silentLogger,
      metrics,
      now: () => NOW,
    })

    expect(gauges.get(WORKER_METRICS.clickhouseBackupAgeSeconds)).toBeGreaterThan(86_400)
  })

  it('publishes a very large age for an empty prefix rather than nothing at all', async () => {
    // The failure this rules out: a watcher that skips the gauge when it finds
    // no objects. The series then does not exist until the first backup lands,
    // which is indistinguishable from a watcher that never ran — and "no backup
    // has ever been taken" is the loudest state this can be in.
    const { metrics, gauges } = collectMetrics()
    await checkBackupsOnce({
      storage: storageWith({}),
      logger: silentLogger,
      metrics,
      now: () => NOW,
    })

    expect(gauges.has(WORKER_METRICS.clickhouseBackupAgeSeconds)).toBe(true)
    expect(gauges.get(WORKER_METRICS.clickhouseBackupAgeSeconds)).toBe(NEVER_SECONDS)
    expect(gauges.get(WORKER_METRICS.clickhouseBackupBytes)).toBe(0)
  })

  it('publishes exactly the gauges the watcher documents — no dial wired to nothing', async () => {
    // The removed rehearsal gauge is the regression this pins: a gauge over a
    // prefix nothing in this package writes can only ever publish the ten-year
    // sentinel, which reads on a dashboard as a permanently broken rehearsal
    // rather than as an absent feature.
    const { metrics, gauges } = collectMetrics()
    await checkBackupsOnce({
      storage: storageWith({}),
      logger: silentLogger,
      metrics,
      now: () => NOW,
    })

    expect([...gauges.keys()].sort()).toEqual(
      [
        WORKER_METRICS.clickhouseBackupAgeSeconds,
        WORKER_METRICS.clickhouseBackupBytes,
        WORKER_METRICS.clickhouseBackupWeeklyAgeSeconds,
      ].sort(),
    )
  })

  it('reports the weekly prefix separately from the daily one', async () => {
    const { metrics, gauges } = collectMetrics()
    await checkBackupsOnce({
      storage: storageWith({
        [BACKUP_DAILY_PREFIX]: {
          key: 'd.zip',
          size: 1,
          lastModified: new Date('2026-08-09T02:30:00Z'),
        },
        [BACKUP_WEEKLY_PREFIX]: {
          key: 'w.zip',
          size: 1,
          lastModified: new Date('2026-08-03T02:30:00Z'),
        },
      }),
      logger: silentLogger,
      metrics,
      now: () => NOW,
    })

    expect(gauges.get(WORKER_METRICS.clickhouseBackupAgeSeconds)).toBe(34_200)
    // 6 days and 9.5 hours: 6 × 86 400 + 34 200.
    expect(gauges.get(WORKER_METRICS.clickhouseBackupWeeklyAgeSeconds)).toBe(552_600)
  })

  it('propagates a storage failure instead of publishing a healthy age', async () => {
    // A blind watcher must not look like a fresh backup. The caller turns this
    // into `clickhouse_backup_check_failed`, which is a different signal from a
    // stale backup on purpose.
    const failing = {
      newestUnder: async () => {
        await Promise.resolve()
        throw new Error('storage unreachable')
      },
    } as unknown as ObjectStorage
    const { metrics, gauges } = collectMetrics()

    await expect(
      checkBackupsOnce({ storage: failing, logger: silentLogger, metrics, now: () => NOW }),
    ).rejects.toThrow('storage unreachable')
    expect(gauges.has(WORKER_METRICS.clickhouseBackupAgeSeconds)).toBe(false)
  })
})
