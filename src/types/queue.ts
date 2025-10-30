import type { Awaitable } from "discord.js"
import type { MenuData, MenuParams, MenuSession } from "./menu"

export interface QueueDriver {
  /**
   * Publish a message to a topic
   */
  publish<T>(topic: string, message: T): Promise<void>

  /**
   * Subscribe to messages on a topic
   */
  subscribe<T>(
    topic: string,
    handler: (message: T) => Promise<void> | void
  ): void

  /**
   * Close the queue driver and clean up resources
   */
  close?(): Promise<void>
}

export interface QueueUpdateOptions<Data extends MenuData = any> {
  /** Menu name to update */
  menu: string

  /** Parameters to identify which menu session to update */
  params: MenuParams<Data>

  /** Control what gets refetched/updated */
  refresh?: {
    /** Refetch items from the fetch function (default: true) */
    items?: boolean

    /** Re-run onSessionStart to update session data (default: false) */
    sessionData?: boolean
  }

  /** Optional: directly update session data without re-running onSessionStart */
  updateSessionData?:
    | Partial<MenuSession<Data>>
    | ((current: MenuSession<Data>) => Awaitable<MenuSession<Data>>)
}

export interface MenuUpdateMessage {
  menuName: string
  contextKey: string
  refresh?: {
    items?: boolean
    sessionData?: boolean
  }
  updateSessionData?: any
  timestamp: number
}

export interface MenuActionMessage {
  sessionId: string
  customId: string
  userId: string
  channelId: string
  messageId: string
  interactionToken: string
  interactionId: string
  ephemeral: boolean
  data?: any
  timestamp: number
}

export interface MenuCloseMessage {
  contextKey: string
  reason?: string
}
