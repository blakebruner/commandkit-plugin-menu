import {
  type APIMessageTopLevelComponent,
  type Awaitable,
  type ColorResolvable,
  ComponentType,
  resolveColor
} from "discord.js"
import { type BaseMenuConfig, createDefinition, type MenuDefinition } from "./define"
import { getMenuEngine, type NavigationOptions } from "./engine"
import { toComponentJSON } from "./render"
import type { ActionContext, ActionHandler, ComponentTree, RenderContext } from "./types"

/** State every paginated view has. `page` is zero-based. */
export interface PageState {
  page: number
}

export interface PageContext<Params, State, Data, Item> extends RenderContext<Params, State, Data> {
  /** Zero-based page being shown (already clamped to the available pages). */
  page: number
  pageCount: number
  /** Every item. */
  items: Item[]
  /** Items on this page. */
  pageItems: Item[]
  total: number
}

export interface PaginatedMenuConfig<Params, State, Data, Item>
  extends BaseMenuConfig<Params, State & PageState, Data> {
  /** Items per page. Default 5. */
  perPage?: number
  /** Pick the list out of the loaded data. Defaults to the data itself (when `load` returns an array). */
  items?: (data: Data, ctx: RenderContext<Params, State & PageState, Data>) => Item[]
  /** Container accent color. */
  color?: ColorResolvable
  /** Rendered above the items. */
  renderHeader?: (
    ctx: PageContext<Params, State & PageState, Data, Item>
  ) => Awaitable<ComponentTree>
  /** Render one item. `index` is the item's position in the full list. */
  renderItem: (
    item: Item,
    index: number,
    ctx: PageContext<Params, State & PageState, Data, Item>
  ) => Awaitable<ComponentTree>
  /** Rendered below the items, above the navigation. */
  renderFooter?: (
    ctx: PageContext<Params, State & PageState, Data, Item>
  ) => Awaitable<ComponentTree>
  /** Rendered instead of the items when the list is empty. */
  renderEmpty?: (
    ctx: PageContext<Params, State & PageState, Data, Item>
  ) => Awaitable<ComponentTree>
  /** Override the plugin's navigation buttons/labels for this menu. */
  navigation?: Partial<NavigationOptions>
}

/** Built-in navigation actions (the `$` prefix keeps them apart from user actions). */
export const NAV = {
  first: "$first",
  previous: "$prev",
  next: "$next",
  last: "$last",
  jump: "$jump"
} as const

const MAX_SELECT_OPTIONS = 25

/**
 * Define a paginated menu: a list of items split into pages, with navigation buttons and an optional
 * page-jump select. Each viewer's page is stored in the view's state.
 */
export function definePaginatedMenu<
  Params = void,
  State = Record<string, never>,
  Data = unknown[],
  Item = Data extends readonly (infer I)[] ? I : unknown
>(
  config: PaginatedMenuConfig<Params, State, Data, Item>
): MenuDefinition<Params, State & PageState, Data> {
  const perPage = Math.max(1, Math.floor(config.perPage ?? 5))
  type S = State & PageState

  const listOf = (data: Data, ctx: RenderContext<Params, S, Data>): Item[] => {
    const items = config.items ? config.items(data, ctx) : data
    if (!Array.isArray(items)) {
      throw new TypeError(
        `Paginated menu "${config.name}": load() must return an array, or provide items(data)`
      )
    }
    return items as Item[]
  }

  const pageCountOf = (total: number) => Math.max(1, Math.ceil(total / perPage))

  const goTo =
    (pick: (page: number, pageCount: number, ctx: ActionContext<Params, S, Data>) => number) =>
    async (ctx: ActionContext<Params, S, Data>) => {
      const data = await ctx.load()
      const renderCtx = { ...ctx, data, state: ctx.state } as unknown as RenderContext<
        Params,
        S,
        Data
      >
      const pageCount = pageCountOf(listOf(data, renderCtx).length)
      const current = Math.min(Math.max(0, ctx.state.page ?? 0), pageCount - 1)
      const page = pick(current, pageCount, ctx)
      ctx.setState({ page: Math.min(Math.max(0, page), pageCount - 1) } as Partial<S>)
    }

  const wraps = () => ({ ...getMenuEngine().options.navigation, ...config.navigation }).wrap
  const builtins: Record<string, ActionHandler<Params, S, Data>> = {
    [NAV.first]: goTo(() => 0),
    [NAV.previous]: goTo((page, pageCount) => (page <= 0 && wraps() ? pageCount - 1 : page - 1)),
    [NAV.next]: goTo((page, pageCount) => (page >= pageCount - 1 && wraps() ? 0 : page + 1)),
    [NAV.last]: goTo((_, pageCount) => pageCount - 1),
    [NAV.jump]: goTo((page, _, ctx) => {
      const value = Number(ctx.values[0])
      return Number.isFinite(value) ? value : page
    })
  }

  const render = async (ctx: RenderContext<Params, S, Data>) => {
    const nav: NavigationOptions = { ...getMenuEngine().options.navigation, ...config.navigation }
    const items = listOf(ctx.data, ctx)
    const pageCount = pageCountOf(items.length)
    const page = Math.min(Math.max(0, ctx.state.page ?? 0), pageCount - 1)
    const start = page * perPage
    const pageItems = items.slice(start, start + perPage)
    const pageCtx: PageContext<Params, S, Data, Item> = {
      ...ctx,
      state: { ...ctx.state, page },
      page,
      pageCount,
      items,
      pageItems,
      total: items.length
    }

    const children: Record<string, any>[] = []
    if (config.renderHeader) children.push(...toComponentJSON(await config.renderHeader(pageCtx)))
    if (!items.length && config.renderEmpty) {
      children.push(...toComponentJSON(await config.renderEmpty(pageCtx)))
    }
    for (let i = 0; i < pageItems.length; i++) {
      children.push(...toComponentJSON(await config.renderItem(pageItems[i]!, start + i, pageCtx)))
    }
    if (config.renderFooter) children.push(...toComponentJSON(await config.renderFooter(pageCtx)))
    if (!children.length) {
      // Discord rejects an empty container
      children.push({ type: ComponentType.TextDisplay, content: "Nothing to show." })
    }
    if (pageCount > 1) children.push(...navigation(ctx, nav, page, pageCount, items.length))

    const container: Record<string, any> = { type: ComponentType.Container, components: children }
    if (config.color !== undefined) container.accent_color = resolveColor(config.color)
    return container as APIMessageTopLevelComponent
  }

  return createDefinition<Params, S, Data>(
    {
      ...config,
      initialState: params => ({ ...(config.initialState?.(params) as S), page: 0 }) as S
    },
    "paginated",
    render,
    builtins
  )
}

function fill(template: string, values: Record<string, number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key) =>
    key in values ? String(values[key]) : match
  )
}

function button(
  options: NavigationOptions["previous"],
  customId: string,
  disabled: boolean
): Record<string, any> {
  const json: Record<string, any> = {
    type: ComponentType.Button,
    style: options.style,
    custom_id: customId,
    disabled
  }
  if (options.label) json.label = options.label
  if (options.emoji) json.emoji = parseEmoji(options.emoji)
  if (!options.label && !options.emoji) json.label = "​"
  return json
}

/** Accepts unicode emoji or custom emoji strings like `<:name:id>` / `<a:name:id>`. */
function parseEmoji(emoji: string): Record<string, any> {
  const custom = /^<(a)?:(\w+):(\d+)>$/.exec(emoji)
  if (custom) return { animated: Boolean(custom[1]), name: custom[2], id: custom[3] }
  return { name: emoji }
}

function navigation(
  ctx: RenderContext<any, any, any>,
  nav: NavigationOptions,
  page: number,
  pageCount: number,
  total: number
): Record<string, any>[] {
  const values = { page: page + 1, pages: pageCount, total }
  const out: Record<string, any>[] = [{ type: ComponentType.Separator, divider: true, spacing: 1 }]
  if (nav.indicator) {
    out.push({ type: ComponentType.TextDisplay, content: fill(nav.indicator, values) })
  }
  // With wrap on, previous/next go around, so nothing is ever disabled.
  const atStart = !nav.wrap && page <= 0
  const atEnd = !nav.wrap && page >= pageCount - 1
  const buttons: Record<string, any>[] = []
  if (nav.first) buttons.push(button(nav.first, ctx.id(NAV.first), atStart))
  buttons.push(button(nav.previous, ctx.id(NAV.previous), atStart))
  buttons.push(button(nav.next, ctx.id(NAV.next), atEnd))
  if (nav.last) buttons.push(button(nav.last, ctx.id(NAV.last), atEnd))
  out.push({ type: ComponentType.ActionRow, components: buttons })

  const showJump = nav.jump === "auto" ? pageCount > 3 : nav.jump
  if (showJump) {
    // A window of nearby pages, centred on the current one.
    const size = Math.min(MAX_SELECT_OPTIONS, Math.max(1, Math.floor(nav.jumpWindow)))
    let start = Math.max(0, page - Math.floor(size / 2))
    const end = Math.min(pageCount, start + size)
    start = Math.max(0, end - size)
    const options = []
    for (let i = start; i < end; i++) {
      // No default option, so the placeholder (with the page count) stays visible.
      options.push({
        label: fill(nav.jumpOption, { page: i + 1, pages: pageCount, total }),
        value: String(i)
      })
    }
    out.push({
      type: ComponentType.ActionRow,
      components: [
        {
          type: ComponentType.StringSelect,
          custom_id: ctx.id(NAV.jump),
          placeholder: fill(nav.jumpPlaceholder, values),
          options
        }
      ]
    })
  }
  return out
}
