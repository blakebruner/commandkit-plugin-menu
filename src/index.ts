import type { RepliableInteraction } from "discord.js"
import { getMenuEngine } from "./engine"
import type { CloseMode, OpenOptions, ViewRef } from "./types"

export { decodeCustomId, encodeCustomId } from "./custom-id"
export {
  type BaseMenuConfig,
  defineMenu,
  type MenuConfig,
  type MenuDefinition
} from "./define"
export { isMenuDefinition } from "./definition"
export {
  DEFAULT_OPTIONS,
  getMenuEngine,
  type MenuEngine,
  type MenuEngineOptions,
  type MenuMessages,
  type NavigationButton,
  type NavigationOptions
} from "./engine"
export {
  definePaginatedMenu,
  NAV,
  type PageContext,
  type PageState,
  type PaginatedMenuConfig
} from "./pagination"
export {
  MenuPlugin,
  type MenuPluginOptions,
  menu,
  registerMenu,
  setMenuStorage
} from "./plugin"
export { disableComponents, type RenderedMenu } from "./render"
export { MemoryMenuStorage } from "./storage/memory"
export {
  type RedisLike,
  RedisMenuStorage,
  type RedisMenuStorageOptions,
  type RedisMultiLike
} from "./storage/redis"
export {
  type SqliteDatabaseLike,
  SqliteMenuStorage,
  type SqliteMenuStorageOptions,
  type SqliteStatementLike
} from "./storage/sqlite"
export type { MenuStorage } from "./storage/types"
export type { MenuTransport, MessageTarget } from "./transport"
export type * from "./types"

type MenuRef = string | { name: string }

/** Reply to an interaction with a menu, by name or definition. */
export function replyMenu(
  interaction: RepliableInteraction,
  menu: MenuRef,
  params?: unknown,
  options?: OpenOptions
): Promise<ViewRef> {
  return getMenuEngine().reply(interaction, menu, params, options)
}

/** Post a menu as a public message in a channel. */
export function sendMenu(
  channel: string | { id: string; guildId?: string | null },
  menu: MenuRef,
  params?: unknown,
  options?: Omit<OpenOptions, "ephemeral">
): Promise<ViewRef> {
  return getMenuEngine().send(channel, menu, params, options)
}

/** Re-render a menu's open views for `params` (or all of its views when `params` is omitted). */
export function invalidateMenu(
  menu: MenuRef,
  params?: unknown,
  options?: { force?: boolean; immediate?: boolean }
): Promise<void> {
  return getMenuEngine().invalidate(menu, params, options)
}

/** Close a menu's open views for `params` (or all of them). */
export function closeMenu(menu: MenuRef, params?: unknown, mode?: CloseMode): Promise<number> {
  return getMenuEngine().close(menu, params, mode)
}
