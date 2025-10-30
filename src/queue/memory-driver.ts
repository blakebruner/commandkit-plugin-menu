import { Logger } from "commandkit"
import type { QueueDriver } from "../types"

type QueueHandler<T> = (message: T) => Promise<void> | void

export class MemoryQueueDriver implements QueueDriver {
  private handlers = new Map<string, Set<QueueHandler<any>>>()
  private processing = false
  private messageQueue: Array<{ topic: string; message: any }> = []

  /**
   * Subscribe to messages on a topic
   */
  public subscribe<T>(topic: string, handler: QueueHandler<T>): void {
    if (!this.handlers.has(topic)) {
      this.handlers.set(topic, new Set())
    }
    this.handlers.get(topic)!.add(handler)
  }

  /**
   * Publish a message to a topic
   */
  public async publish<T>(topic: string, message: T): Promise<void> {
    this.messageQueue.push({ topic, message })

    if (!this.processing) {
      await this.processQueue()
    }
  }

  /**
   * Process queued messages
   */
  private async processQueue(): Promise<void> {
    this.processing = true

    while (this.messageQueue.length > 0) {
      const { topic, message } = this.messageQueue.shift()!
      const handlers = this.handlers.get(topic)

      if (handlers) {
        await Promise.all(
          Array.from(handlers).map(handler =>
            Promise.resolve(handler(message)).catch(err =>
              Logger.error(`Error in handler for topic ${topic}: ${err}`)
            )
          )
        )
      }
    }

    this.processing = false
  }

  /**
   * Clear all handlers
   */
  public async close(): Promise<void> {
    this.handlers.clear()
    this.messageQueue = []
  }
}
