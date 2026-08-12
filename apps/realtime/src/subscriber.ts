/**
 * The one dedicated Pub/Sub connection for the whole process.
 *
 * A subscribed ioredis connection cannot run ordinary commands, so it must be a
 * separate socket from the command client that serves `readPresenceSnapshot` and
 * `getEpoch` (docs snapshot 02 §17). One subscriber carries every site's
 * `rt_updates:{site}` and `rt_control:{site}` channels; the hub manager routes an
 * inbound message to the right site by its channel name.
 *
 * The interface is intentionally the small slice of ioredis the manager uses, so
 * a test can drive the fan-out with an in-memory fake and the app never imports
 * ioredis directly.
 */
export interface RealtimeSubscriber {
  subscribe(channel: string): Promise<void>
  unsubscribe(channel: string): Promise<void>
  /** Registers the single message listener the manager fans out from. */
  onMessage(listener: (channel: string, message: string) => void): void
  close(): Promise<void>
}

/** The structural slice of an ioredis client a subscriber needs. */
export interface SubscriberClient {
  subscribe(...channels: string[]): Promise<unknown>
  unsubscribe(...channels: string[]): Promise<unknown>
  on(event: 'message', listener: (channel: string, message: string) => void): unknown
  quit(): Promise<unknown>
}

/** Adapts a subscriber-mode ioredis connection to the `RealtimeSubscriber` port. */
export function createIoRedisSubscriber(client: SubscriberClient): RealtimeSubscriber {
  return {
    async subscribe(channel: string): Promise<void> {
      await client.subscribe(channel)
    },
    async unsubscribe(channel: string): Promise<void> {
      await client.unsubscribe(channel)
    },
    onMessage(listener: (channel: string, message: string) => void): void {
      client.on('message', listener)
    },
    async close(): Promise<void> {
      await client.quit()
    },
  }
}
