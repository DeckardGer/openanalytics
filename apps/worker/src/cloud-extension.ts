import type { ServiceEnv } from '@openanalytics/domain'
import type { Logger } from '@openanalytics/observability'
import type { Database } from '@openanalytics/postgres'

/**
 * Background loops a registered surface adds to the worker.
 *
 * Most of what an optional surface contributes to this service registers itself
 * beside the code it extends — a sweeper duty, an outbox handler, a deletion
 * phase, the usage ledger's windowed attribution. This registry exists for the
 * one thing that cannot: a loop with its own timer, which `main.ts` has to start
 * and, more importantly, has to *stop* in the shutdown sequence. The telegram
 * drain is that shape, and it is here for the reason its own header gives — a
 * topic with a transport dependency must not be able to stop the others.
 */

export interface WorkerDrainContext {
  readonly db: Database
  readonly env: ServiceEnv<'worker'>
  readonly logger: Logger
}

export interface WorkerDrain {
  stop(): Promise<void>
}

export interface WorkerDrainRegistration {
  readonly name: string
  readonly start: (ctx: WorkerDrainContext) => WorkerDrain
}

const drains: WorkerDrainRegistration[] = []

/** Idempotent by name, so importing the surface twice registers one loop. */
export function registerWorkerDrain(registration: WorkerDrainRegistration): void {
  if (drains.some((registered) => registered.name === registration.name)) return
  drains.push(registration)
}

export function workerDrains(): readonly WorkerDrainRegistration[] {
  return drains
}
