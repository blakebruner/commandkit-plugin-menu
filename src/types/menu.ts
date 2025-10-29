import type { ColorResolvable, ContainerComponentBuilder } from "discord.js"
import type { ActionHandlers } from "./action"
import type { SessionContext, SessionOptions } from "./session"

/**
 * Base interface for menu data types
 */
export interface MenuData<Params = any, Item = any, Session = any> {
  params: Params
  item: Item
  session: Session
}

/**
 * Extract the params type from MenuData
 */
export type MenuParams<Data extends MenuData> = Data["params"]

/**
 * Extract the item type from MenuData
 */
export type MenuItem<Data extends MenuData> = Data["item"]

/**
 * Extract the session type from MenuData
 */
export type MenuSession<Data extends MenuData> = Data["session"]

/**
 * A component or array of components (fragment)
 */
export type ContainerComponentOrFragment =
  | ContainerComponentBuilder
  | ContainerComponentBuilder[]

/**
 * Base definition for all menu types
 */
export interface BaseMenuDefinition<Data extends MenuData> {
  /** Type of menu that this is */
  type: "single" | "pagination"

  /** Unique name for this menu type */
  name: string

  /** Menu accent color */
  color?: ColorResolvable

  /** Session behavior options */
  sessionOptions?: SessionOptions

  /** Create a unique key to store the session */
  createKey: (params: MenuParams<Data>) => Promise<string> | string

  /** Initialize session data when session starts */
  onSessionStart?: (
    params: MenuParams<Data>
  ) => Promise<MenuSession<Data>> | MenuSession<Data>

  /** Cleanup when session ends */
  onSessionEnd?: (ctx: SessionContext<Data>) => Promise<void>

  /** Render the menu title */
  renderTitle?: (
    ctx: SessionContext<Data>
  ) => Promise<ContainerComponentOrFragment> | ContainerComponentOrFragment

  /**
   * Define custom actions for this menu
   * Action names should be simple strings (e.g., 'delete', 'favorite', 'edit')
   */
  actions?: ActionHandlers<Data>
}

/**
 * Definition for a single-page menu
 */
export interface SinglePageMenuDefinition<Data extends MenuData>
  extends BaseMenuDefinition<Data> {
  /** Type of page */
  type: "single"

  /** Fetch a single item for this menu */
  fetch: (params: MenuParams<Data>) => Promise<MenuItem<Data>> | MenuItem<Data>

  /** Render the menu body */
  renderBody: (
    item: MenuItem<Data>,
    ctx: SessionContext<Data>
  ) => Promise<ContainerComponentOrFragment> | ContainerComponentOrFragment
}

/**
 * Definition for a paginated menu
 */
export interface PaginationMenuDefinition<Data extends MenuData>
  extends BaseMenuDefinition<Data> {
  /** Type of page */
  type: "pagination"

  /** Number of items to display per page */
  perPage: number

  /** Fetch all items for pagination */
  fetch: (
    params: MenuParams<Data>
  ) => Promise<MenuItem<Data>[]> | MenuItem<Data>[]

  /** Render a single item */
  renderItem: (
    item: MenuItem<Data>,
    index: number,
    pageIndex: number,
    ctx: SessionContext<Data>
  ) => Promise<ContainerComponentOrFragment> | ContainerComponentOrFragment
}

/**
 * Union of all menu definition types
 */
export type MenuDefinition<Data extends MenuData> =
  | SinglePageMenuDefinition<Data>
  | PaginationMenuDefinition<Data>
