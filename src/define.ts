import type { Awaitable, RepliableInteraction } from "discord.js"
import { validateActionName } from "./custom-id"
import {
  MENU_BRAND,
  type MenuDefinitionBase,
  type MenuRuntime,
  normalizeUpdates,
  validateMenuName
} from "./definition"
import { getMenuEngine } from "./engine"
import type {
  AccessRule,
  ActionHandler,
  CloseMode,
  LoadContext,
  MenuOutput,
  OpenOptions,
  RenderContext,
  ReplacePolicy,
  TtlOptions,
  UpdateMode,
  UpdatePolicy,
  ViewRecord,
  ViewRef
} from "./types"
import { stableStringify } from "./utils"

/** Options shared by every kind of menu. */
export interface BaseMenuConfig<Params, State, Data> {
  /** Unique name. Stored with each view, so renaming a menu expires its open messages. */
  name: string
  /**
   * Which data this view shows. Views with the same key share one `load` per push and are refreshed
   * together by `invalidate(params)`. Defaults to the params themselves (stable JSON).
   */
  key?: (params: Params) => string
  /** Fetch the data to render. Called on every render, so read from your source of truth. */
  load?: (params: Params, ctx: LoadContext) => Awaitable<Data>
  /** Per-view state for a new view (current tab, filters, ...). Must be JSON-serializable. */
  initialState?: (params: Params) => State
  /** Click, select and modal handlers. Reference them with `ctx.id("name")` in render. */
  actions?: Record<string, ActionHandler<Params, State, Data>>
  /**
   * `"live"` (default) pushes changes to open messages; `"lazy"` refreshes only when someone clicks.
   * Pass `{ public, ephemeral }` to choose separately, e.g. `{ public: "live", ephemeral: "lazy" }`.
   */
  updates?: UpdateMode | Partial<UpdatePolicy>
  /** Default for `.reply()`: send as an ephemeral (hidden) message. Default `false`. */
  ephemeral?: boolean
  /** Who may click. Default `"anyone"` (ephemeral menus are only visible to their owner anyway). */
  access?: AccessRule<Params, State>
  /**
   * When opening a view, close older views of the same key: `"owner"` (same user), `"channel"`
   * (same channel, e.g. one ticket panel per ticket) or `"none"`. Default: `"owner"` for ephemeral
   * views, `"none"` for public ones.
   */
  replace?: ReplacePolicy
  /** View lifetime in ms (`null` = forever), overriding the plugin defaults. */
  ttl?: number | null | TtlOptions
  /** What happens to the message when the view expires. Defaults to the plugin's `onExpire`. */
  onExpire?: CloseMode
  /** Re-render this menu's live views when the bot starts, to catch changes made while it was off. */
  resyncOnStart?: boolean
  /** Debounce for `invalidate()` in ms, overriding the plugin default. */
  debounce?: number
}

export interface MenuConfig<Params, State, Data> extends BaseMenuConfig<Params, State, Data> {
  /** Build the message. Return CommandKit JSX, discord.js builders or API JSON (Components V2). */
  render: (ctx: RenderContext<Params, State, Data>) => Awaitable<MenuOutput>
}

// `void` marks menus that take no params, so `.send(channel)` needs no second argument.
// biome-ignore lint/suspicious/noConfusingVoidType: intentional, see above
type ParamsArg<Params> = [Params] extends [void]
  ? [params?: undefined]
  : undefined extends Params
    ? [params?: Params]
    : [params: Params]

/** A menu definition, with typed helpers bound to the shared engine. */
export interface MenuDefinition<Params = any, State = any, Data = any> extends MenuDefinitionBase {
  /** Reply to an interaction with this menu (ephemeral if the menu or `options` say so). */
  reply(
    interaction: RepliableInteraction,
    ...args: [...ParamsArg<Params>, options?: OpenOptions]
  ): Promise<ViewRef>
  /** Post this menu as a public message in a channel. */
  send(
    channel: string | { id: string; guildId?: string | null },
    ...args: [...ParamsArg<Params>, options?: Omit<OpenOptions, "ephemeral">]
  ): Promise<ViewRef>
  /** Re-render open views for `params` (or every view when omitted). */
  invalidate(params?: Params, options?: { force?: boolean; immediate?: boolean }): Promise<void>
  /** Close open views for `params` (or every view when omitted). Returns how many were closed. */
  close(params?: Params, mode?: CloseMode): Promise<number>
  /** Open views for `params` (or every view when omitted). */
  views(params?: Params): Promise<ViewRecord[]>
  /** @internal phantom types */
  readonly __types?: { params: Params; state: State; data: Data }
}

export function createDefinition<Params, State, Data>(
  config: BaseMenuConfig<Params, State, Data>,
  kind: string,
  render: (ctx: RenderContext<Params, State, Data>) => Awaitable<MenuOutput>,
  builtinActions: Record<string, ActionHandler<Params, State, Data>> = {}
): MenuDefinition<Params, State, Data> {
  validateMenuName(config.name)
  const actions = new Map<string, ActionHandler<any, any, any>>()
  for (const [name, handler] of Object.entries(config.actions ?? {})) {
    validateActionName(name, config.name)
    if (typeof handler !== "function") {
      throw new TypeError(`Menu "${config.name}": action "${name}" must be a function`)
    }
    actions.set(name, handler)
  }
  for (const [name, handler] of Object.entries(builtinActions)) actions.set(name, handler)

  const ttl: TtlOptions =
    config.ttl === undefined
      ? {}
      : config.ttl === null || typeof config.ttl === "number"
        ? { public: config.ttl, ephemeral: config.ttl }
        : config.ttl

  const runtime: MenuRuntime = {
    name: config.name,
    kind,
    key: params => (config.key ? config.key(params as Params) : defaultKey(params)),
    load: async (params, ctx) =>
      config.load ? await config.load(params as Params, ctx) : (undefined as Data),
    initialState: params =>
      (config.initialState ? (config.initialState(params as Params) ?? {}) : {}) as Record<
        string,
        unknown
      >,
    render: async ctx => render(ctx as RenderContext<Params, State, Data>),
    actions,
    updates: normalizeUpdates(config.updates),
    access: (config.access ?? "anyone") as AccessRule<any, any>,
    ttl,
    onExpire: config.onExpire,
    replace: config.replace,
    ephemeral: config.ephemeral ?? false,
    resyncOnStart: config.resyncOnStart ?? false,
    debounce: config.debounce
  }

  const definition: MenuDefinition<Params, State, Data> = {
    [MENU_BRAND]: true,
    name: config.name,
    runtime,
    reply(interaction, ...args) {
      const [params, options] = args as unknown as [unknown, OpenOptions | undefined]
      return getMenuEngine().reply(interaction, definition, params, options)
    },
    send(channel, ...args) {
      const [params, options] = args as unknown as [unknown, OpenOptions | undefined]
      return getMenuEngine().send(channel, definition, params, options)
    },
    invalidate(params, options) {
      return getMenuEngine().invalidate(definition, params, options)
    },
    close(params, mode) {
      return getMenuEngine().close(definition, params, mode)
    },
    views(params) {
      return getMenuEngine().views(definition, params)
    }
  }
  return definition
}

function defaultKey(params: unknown): string {
  return params === undefined || params === null ? "_" : stableStringify(params)
}

/**
 * Define a menu: one message whose content is rendered from `load` + `state`.
 *
 * ```tsx
 * export default defineMenu({
 *   name: "ticket-panel",
 *   key: (p: { ticketId: string }) => p.ticketId,
 *   load: p => db.ticket.findUnique({ where: { id: p.ticketId } }),
 *   render: ({ data, id }) => (
 *     <Container>
 *       <TextDisplay content={`Ticket #${data.number} is ${data.status}`} />
 *       <ActionRow><Button customId={id("close")} style={ButtonStyle.Danger}>Close</Button></ActionRow>
 *     </Container>
 *   ),
 *   actions: {
 *     close: async ctx => { await closeTicket(ctx.params.ticketId); ctx.invalidate() }
 *   }
 * })
 * ```
 */
export function defineMenu<Params = void, State = Record<string, never>, Data = undefined>(
  config: MenuConfig<Params, State, Data>
): MenuDefinition<Params, State, Data> {
  if (typeof config.render !== "function") {
    throw new TypeError(`Menu "${config.name}" needs a render function`)
  }
  return createDefinition(config, "static", config.render)
}
