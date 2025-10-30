import type { Awaitable, MessageComponentInteraction } from "discord.js"
import type { MenuData, MenuItem, MenuParams, MenuSession } from "./menu"

/**
 * Context passed to action handlers
 */
export interface ActionContext<Data extends MenuData> {
  /** The interaction that triggered this action */
  interaction: MessageComponentInteraction

  /** Menu session data */
  sessionData: MenuSession<Data>

  /** Menu parameters */
  params: MenuParams<Data>

  /** Item at the selected index (for item-level actions) */
  item?: MenuItem<Data>

  /** Session ID */
  sessionId: string

  /** User who triggered the action */
  userId: string
}

/**
 * Action handler function
 */
export type ActionHandler<Data extends MenuData> = (
  ctx: ActionContext<Data>
) => Awaitable<void>

/**
 * Record of action handlers
 */
export type ActionHandlers<Data extends MenuData> = Record<
  string,
  ActionHandler<Data>
>
