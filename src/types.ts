import type CommandKit from "commandkit"
import type {
  ButtonStyle,
  ColorResolvable,
  ContainerComponentBuilder
} from "discord.js"

export type ButtonWithCustomId =
  | ButtonStyle.Danger
  | ButtonStyle.Primary
  | ButtonStyle.Secondary
  | ButtonStyle.Success

export interface PageNavigationButtonOptions {
  label?: string
  style: ButtonWithCustomId
  emoji?: string
}

export interface PageNavigation {
  first: PageNavigationButtonOptions
  previous: PageNavigationButtonOptions
  next: PageNavigationButtonOptions
  last: PageNavigationButtonOptions
}

export type PageNavigationType = keyof PageNavigation

export interface PaginationPluginOptions {
  actionPrefix: string
  preloadAll: boolean
  navigation: PageNavigation
}

/** What callers can pass: everything optional, deep */
export type PaginationPluginUserOptions = PartialDeep<PaginationPluginOptions>

/** Minimal context given to a page when it's built */
export interface BaseBuildCtx {
  commandkit: CommandKit
}

// ----------------------- UPDATE ABOVE THIS LINE ----------------------- //

export interface MenuData<Params = any, Item = any, Session = any> {
  params: Params
  item: Item
  session: Session
}

export type MenuParams<Data extends MenuData> = Data["params"]
export type MenuItem<Data extends MenuData> = Data["item"]
export type MenuSession<Data extends MenuData> = Data["session"]

export interface SessionContext<Data extends MenuData> {
  params: MenuParams<Data>
  sessionId: string
  sessionData: MenuSession<Data>
}

export interface BaseMenuDefinition<Data extends MenuData> {
  /** Unique name for this menu type */
  name: string

  color?: ColorResolvable

  /** Session behavior options */
  sessionOptions?: {
    /**
     * Session sharing mode
     * - 'shared': All users share the same session (default)
     * - 'private': Each user gets their own session
     * - 'locked': Session belongs to creator, others can view but not interact
     */
    mode?: "shared" | "private" | "locked"

    /** Time-to-live in milliseconds before session auto-destroys (default: no TTL) */
    ttl?: number

    /** Delete the message when session ends (default: false) */
    deleteOnEnd?: boolean

    /** Update the message with final state when session ends (default: false) */
    updateOnEnd?: boolean

    /** How to merge final render with existing content (default: 'replace') */
    endRenderMode?: "replace" | "merge" | "append"
  }

  /** Initialize session data when session starts */
  onSessionStart?: (
    params: MenuParams<Data>
  ) => Promise<MenuSession<Data>> | MenuSession<Data>

  /** Cleanup when session ends */
  onSessionEnd?: (ctx: SessionContext<Data>) => Promise<void>

  /** Render the menu title */
  renderTitle?: (
    ctx: SessionContext<Data>
  ) => Promise<ContainerComponentBuilder> | ContainerComponentBuilder
}

export interface SinglePageMenuDefinition<Data extends MenuData>
  extends BaseMenuDefinition<Data> {
  /** Fetch a single item for this menu */
  fetch: (params: MenuParams<Data>) => Promise<MenuItem<Data>> | MenuItem<Data>

  renderBody: (
    item: MenuItem<Data>,
    ctx: SessionContext<Data>
  ) => Promise<ContainerComponentBuilder> | ContainerComponentBuilder
}

export interface PaginationMenuDefinition<Data extends MenuData>
  extends BaseMenuDefinition<Data> {
  perPage: number

  /** Fetch all items for pagination */
  fetch: (
    params: MenuParams<Data>
  ) => Promise<MenuItem<Data>[]> | MenuItem<Data>[]

  renderItem: (
    item: MenuItem<Data>,
    index: number,
    pageIndex: number,
    ctx: SessionContext<Data>
  ) => Promise<ContainerComponentBuilder> | ContainerComponentBuilder
}

export type MenuDefinition<Data extends MenuData> =
  | SinglePageMenuDefinition<Data>
  | PaginationMenuDefinition<Data>

export type PartialDeep<T> = {
  [K in keyof T]?: T[K] extends object ? PartialDeep<T[K]> : T[K]
}
