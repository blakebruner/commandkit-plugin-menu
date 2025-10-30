import type { MenuData, MenuParams, MenuSession } from "./menu"

/**
 * User session information for tracking individual user's state
 */
export interface UserSession {
  /** Discord user ID */
  userId: string

  /** Message ID where this user's menu is displayed */
  messageId: string

  /** Channel ID where the message was sent */
  channelId: string

  /** Interaction token for responding to interactions, used for ephemeral */
  interactionToken?: string

  /** Interaction ID for responding to interactions, used for ephemeral */
  interactionId?: string

  /** Timestamp when interaction token expires */
  tokenExpiresAt?: number

  /** Current page number for this user (pagination menus only) */
  currentPage: number

  /** Whether this user's message is ephemeral */
  ephemeral: boolean

  /** Timestamp when the session was created */
  createdAt: number
}

/**
 * Session context passed to menu lifecycle hooks
 */
export interface SessionContext<Data extends MenuData> {
  params: MenuParams<Data>
  sessionId: string
  sessionData: MenuSession<Data>
}

/**
 * Session behavior options
 */
export interface SessionOptions {
  /**
   * Session sharing mode
   * - 'shared': Multiple users can view/interact, each with their own page position
   * - 'private': Only one user can have this menu open at a time
   * @default 'shared'
   */
  mode?: "shared" | "private"

  /** Whether the menu should be ephemeral (only visible to the user) */
  ephemeral?: boolean

  /** Time-to-live in milliseconds before session auto-destroys (default: no TTL) */
  ttl?: number

  /** Delete the message when session ends (default: false) */
  deleteOnEnd?: boolean

  /** Update the message with final state when session ends (default: false) */
  updateOnEnd?: boolean

  /** How to merge final render with existing content (default: 'replace') */
  endRenderMode?: "replace" | "merge" | "append"
}
