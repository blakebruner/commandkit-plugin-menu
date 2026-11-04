import {
  type ButtonStyle,
  type Client,
  type Interaction,
  type InteractionReplyOptions,
  type MessageComponentInteraction,
  MessageFlags,
  type ModalSubmitInteraction,
  type RepliableInteraction
} from "discord.js"
import { BUILTIN_ACTION_PREFIX, decodeCustomId, encodeCustomId } from "./custom-id"
import { isMenuDefinition, type MenuDefinitionBase, validateMenuName } from "./definition"
import { log } from "./logger"
import { disableComponents, normalizeOutput, type RenderedMenu, validateCustomIds } from "./render"
import { MemoryMenuStorage } from "./storage/memory"
import type { MenuStorage } from "./storage/types"
import { DiscordTransport, type MenuTransport, type MessageTarget } from "./transport"
import type {
  ActionContext,
  CloseMode,
  OpenOptions,
  RenderContext,
  ViewInfo,
  ViewRecord,
  ViewRef
} from "./types"
import {
  assertSerializable,
  clone,
  discordErrorCode,
  globalSingleton,
  mapLimit,
  randomId,
  stableStringify
} from "./utils"

/** Interaction tokens last 15 minutes; stop using them a minute early to be safe. */
const TOKEN_LIFETIME = 14 * 60 * 1000

export type NavigationButton = {
  emoji?: string
  label?: string
  style: ButtonStyle.Primary | ButtonStyle.Secondary | ButtonStyle.Success | ButtonStyle.Danger
}

export interface NavigationOptions {
  first: NavigationButton | false
  previous: NavigationButton
  next: NavigationButton
  last: NavigationButton | false
  /** Page-jump select menu: always, never, or `"auto"` (when there are more than 3 pages). */
  jump: boolean | "auto"
  /** Placeholder for the jump select. `{page}` and `{pages}` are replaced. */
  jumpPlaceholder: string
  /** Option label in the jump select. `{page}` is replaced. */
  jumpOption: string
  /** Small text above the buttons. `{page}`, `{pages}` and `{total}` are replaced. `false` hides it. */
  indicator: string | false
}

export interface MenuMessages {
  /** Shown (ephemerally) when someone clicks a menu whose view no longer exists. `null` = silent. */
  expired: string | null
  /** Shown when an `access` rule rejects a click. */
  forbidden: string
  /** Shown when an action throws. */
  error: string
}

export interface MenuEngineOptions {
  /** Custom id prefix. Default `"menu"`. Change it if another library already uses `menu:`. */
  prefix: string
  /** Default delay for coalescing `invalidate()` calls, in ms. Default 250. */
  debounce: number
  /** Default view lifetimes. Public views never expire; ephemeral ones after 6 hours. */
  ttl: { public: number | null; ephemeral: number | null }
  /** What to do with a message when its view expires. Default `"disable"`. */
  onExpire: CloseMode
  /** How often expired views are swept, in ms. Default 60s. `0` disables the sweeper. */
  sweepInterval: number
  /** Max concurrent message edits during one push. Default 4. */
  concurrency: number
  /** Auto-acknowledge a click after this many ms if the action hasn't finished. Default 2000. */
  deferAfter: number
  messages: MenuMessages
  navigation: NavigationOptions
}

export const DEFAULT_OPTIONS: MenuEngineOptions = {
  prefix: "menu",
  debounce: 250,
  ttl: { public: null, ephemeral: 6 * 60 * 60 * 1000 },
  onExpire: "disable",
  sweepInterval: 60_000,
  concurrency: 4,
  deferAfter: 2000,
  messages: {
    expired: "This menu has expired. Run the command again to open a fresh one.",
    forbidden: "You can't use this menu.",
    error: "Something went wrong while handling that. Please try again."
  },
  navigation: {
    first: { emoji: "⏪", style: 2 },
    previous: { emoji: "◀️", style: 1 },
    next: { emoji: "▶️", style: 1 },
    last: { emoji: "⏩", style: 2 },
    jump: "auto",
    jumpPlaceholder: "Jump to page ({page}/{pages})",
    jumpOption: "Page {page}",
    indicator: "-# Page {page} of {pages}"
  }
}

type AnyMenu = MenuDefinitionBase
type MenuRef = string | { name: string }
type MenuInteraction = MessageComponentInteraction | ModalSubmitInteraction

interface LoadedData {
  stamp: number
  data: Promise<unknown>
}
type DataCache = Map<string, LoadedData>

interface DirtyEntry {
  menu: string
  key: string | null
  since: number
  force: boolean
  timer: ReturnType<typeof setTimeout> | null
  waiters: Array<() => void>
}

const ALL_KEYS = null

/**
 * The menu runtime: tracks open views, renders them, routes clicks and pushes updates.
 * One engine is shared per process (see `getMenuEngine()`); the CommandKit plugin configures it.
 */
export class MenuEngine {
  options: MenuEngineOptions = clone(DEFAULT_OPTIONS)
  storage: MenuStorage = new MemoryMenuStorage()
  transport: MenuTransport | null = null
  client: Client | null = null
  readonly menus = new Map<string, AnyMenu>()

  private locks = new Map<string, Promise<void>>()
  private dirty = new Map<string, DirtyEntry>()
  /** Logical clock value when each view last started a render that reached Discord. */
  private renderedAt = new Map<string, number>()
  private clock = 0
  private sweepTimer: ReturnType<typeof setInterval> | null = null
  private sweeping = false

  // ---------------------------------------------------------------- setup

  configure(options: Partial<MenuEngineOptions>): void {
    const base = clone(DEFAULT_OPTIONS)
    this.options = {
      ...base,
      ...options,
      ttl: { ...base.ttl, ...options.ttl },
      messages: { ...base.messages, ...options.messages },
      navigation: { ...base.navigation, ...options.navigation }
    }
  }

  setStorage(storage: MenuStorage): void {
    this.storage = storage
  }

  attachClient(client: Client, transport?: MenuTransport): void {
    this.client = client
    this.transport = transport ?? new DiscordTransport(client)
  }

  startSweeper(): void {
    this.stopSweeper()
    if (this.options.sweepInterval > 0) {
      this.sweepTimer = setInterval(() => void this.sweep(), this.options.sweepInterval)
      this.sweepTimer.unref?.()
    }
  }

  stopSweeper(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer)
    this.sweepTimer = null
  }

  /** Stop timers and drop pending pushes (used on plugin deactivate and in tests). */
  async shutdown(): Promise<void> {
    this.stopSweeper()
    for (const entry of this.dirty.values()) {
      if (entry.timer) clearTimeout(entry.timer)
      for (const resolve of entry.waiters) resolve()
    }
    this.dirty.clear()
  }

  // ---------------------------------------------------------------- registry

  register(menu: AnyMenu): void {
    if (!isMenuDefinition(menu)) {
      throw new TypeError(
        "register() expects a menu created with defineMenu or definePaginatedMenu"
      )
    }
    validateMenuName(menu.name)
    this.menus.set(menu.name, menu)
  }

  /** Register a menu only if no menu with that name is loaded yet. */
  ensure(menu: AnyMenu): void {
    if (!this.menus.has(menu.name)) this.register(menu)
  }

  unregister(name: string): void {
    this.menus.delete(name)
  }

  resolve(ref: MenuRef): AnyMenu {
    const name = typeof ref === "string" ? ref : ref.name
    if (typeof ref !== "string" && isMenuDefinition(ref)) this.ensure(ref)
    const menu = this.menus.get(name)
    if (!menu) {
      throw new Error(
        `Menu "${name}" is not registered. Put it in src/app/menus or call registerMenu() at startup.`
      )
    }
    return menu
  }

  // ---------------------------------------------------------------- opening menus

  /**
   * Reply to an interaction with a menu. Works for fresh, deferred and already-answered interactions
   * (the last one sends a follow-up).
   */
  async reply(
    interaction: RepliableInteraction,
    ref: MenuRef,
    params?: unknown,
    options: OpenOptions = {}
  ): Promise<ViewRef> {
    const menu = this.resolve(ref)
    const deferUpdated =
      interaction.deferred && !interaction.replied && interaction.ephemeral === null
    const useEditReply = interaction.deferred && !interaction.replied && !deferUpdated
    const ephemeral = useEditReply
      ? Boolean(interaction.ephemeral)
      : (options.ephemeral ?? menu.runtime.ephemeral)

    const view = this.createView(menu, params, {
      ephemeral,
      ownerId: options.ownerId ?? interaction.user.id,
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      applicationId: interaction.applicationId,
      state: options.state
    })
    const stamp = ++this.clock
    const rendered = await this.renderView(menu, view)
    const flags = MessageFlags.IsComponentsV2 | (ephemeral ? MessageFlags.Ephemeral : 0)
    const payload = interactionPayload(rendered)

    let messageId: string | null = null
    if (useEditReply) {
      const message = await interaction.editReply({
        ...payload,
        flags: MessageFlags.IsComponentsV2
      })
      messageId = message.id
      view.tokenTarget = "@original"
    } else if (interaction.replied || interaction.deferred) {
      const message = await interaction.followUp({ ...payload, flags })
      messageId = message.id
      view.tokenTarget = message.id
    } else {
      const response = await interaction.reply({ ...payload, flags, withResponse: true })
      messageId = response.resource?.message?.id ?? null
      if (!messageId && !ephemeral) {
        messageId = (await interaction.fetchReply()).id
      }
      view.tokenTarget = "@original"
    }

    view.messageId = messageId
    view.token = interaction.token
    view.tokenExpiresAt = interaction.createdTimestamp + TOKEN_LIFETIME
    await this.storage.save(view)
    this.renderedAt.set(view.id, stamp)
    await this.replaceOlder(menu, view)
    return toRef(view)
  }

  /** Post a menu as a new public message, e.g. a panel in a ticket channel. */
  async send(
    channel: string | { id: string; guildId?: string | null },
    ref: MenuRef,
    params?: unknown,
    options: Omit<OpenOptions, "ephemeral"> = {}
  ): Promise<ViewRef> {
    const menu = this.resolve(ref)
    const channelId = typeof channel === "string" ? channel : channel.id
    const guildId = typeof channel === "string" ? null : (channel.guildId ?? null)
    const view = this.createView(menu, params, {
      ephemeral: false,
      ownerId: options.ownerId ?? null,
      guildId,
      channelId,
      applicationId: this.client?.application?.id ?? null,
      state: options.state
    })
    const stamp = ++this.clock
    const rendered = await this.renderView(menu, view)
    const { id } = await this.requireTransport().send(channelId, rendered)
    view.messageId = id
    await this.storage.save(view)
    this.renderedAt.set(view.id, stamp)
    await this.replaceOlder(menu, view)
    return toRef(view)
  }

  // ---------------------------------------------------------------- updates

  /**
   * Mark a menu's data as changed. Views with update mode `"live"` (or every view, with
   * `force: true`) are re-rendered after a short debounce; rapid calls are merged into one push.
   *
   * Omit `params` to refresh every view of the menu. The promise resolves once the push is done.
   */
  invalidate(
    ref: MenuRef,
    params?: unknown,
    options: { force?: boolean; immediate?: boolean } = {}
  ): Promise<void> {
    const menu = this.resolve(ref)
    const key = params === undefined ? ALL_KEYS : menu.runtime.key(params)
    return this.markDirty(menu, key, options)
  }

  private markDirty(
    menu: AnyMenu,
    key: string | null,
    options: { force?: boolean; immediate?: boolean }
  ): Promise<void> {
    const id = `${menu.name}\u0000${key ?? "\u0000all"}`
    let entry = this.dirty.get(id)
    if (!entry) {
      entry = { menu: menu.name, key, since: 0, force: false, timer: null, waiters: [] }
      this.dirty.set(id, entry)
    }
    entry.since = ++this.clock
    entry.force ||= Boolean(options.force)
    const done = new Promise<void>(resolve => entry.waiters.push(resolve))
    const delay = options.immediate ? 0 : (menu.runtime.debounce ?? this.options.debounce)
    // Keep an already scheduled flush (a throttle, not a sliding debounce), so a steady stream of
    // invalidations still pushes every `debounce` ms. `immediate` only ever pulls the flush forward.
    if (!entry.timer || delay === 0) {
      if (entry.timer) clearTimeout(entry.timer)
      entry.timer = setTimeout(() => void this.flush(id), delay)
    }
    return done
  }

  private async flush(id: string): Promise<void> {
    const entry = this.dirty.get(id)
    if (!entry) return
    this.dirty.delete(id)
    try {
      const menu = this.menus.get(entry.menu)
      if (!menu) return
      const views =
        entry.key === ALL_KEYS
          ? await this.storage.findByMenu(entry.menu)
          : await this.storage.findByKey(entry.menu, entry.key)
      const now = Date.now()
      const targets = views.filter(view => {
        const mode = view.ephemeral ? menu.runtime.updates.ephemeral : menu.runtime.updates.public
        if (mode === "lazy" && !entry.force) return false
        if (view.expiresAt !== null && view.expiresAt <= now) return false
        if (!targetFor(view, now)) return false
        return (this.renderedAt.get(view.id) ?? -1) < entry.since
      })
      const dataCache: DataCache = new Map()
      await mapLimit(targets, this.options.concurrency, view =>
        this.push(view.id, entry.since, dataCache)
      )
    } catch (error) {
      log.error(`Menu push for "${entry.menu}" failed: ${stack(error)}`)
    } finally {
      for (const resolve of entry.waiters) resolve()
    }
  }

  /** Re-render one view and edit its message. */
  private async push(viewId: string, since: number, dataCache?: DataCache): Promise<void> {
    await this.withLock(viewId, async () => {
      const view = await this.storage.get(viewId)
      if (!view) return
      // a click may have re-rendered it while we waited for the lock
      if ((this.renderedAt.get(view.id) ?? -1) >= since) return
      const menu = this.menus.get(view.menu)
      const target = targetFor(view, Date.now())
      if (!menu || !target) return
      const { stamp, data } = this.loadCached(menu, view, dataCache)
      const rendered = await this.renderView(menu, view, data)
      try {
        await this.requireTransport().edit(target, rendered)
        this.renderedAt.set(view.id, stamp)
      } catch (error) {
        await this.handleEditError(view, error)
      }
    })
  }

  /**
   * Load a view's data, sharing one load per params within a push. The returned stamp is the clock
   * value from when that load *started*, so a render of older data is never mistaken for fresh.
   */
  private loadCached(menu: AnyMenu, view: ViewRecord, cache?: DataCache): LoadedData {
    const key = `${menu.name}\u0000${stableStringify(view.params)}`
    let entry = cache?.get(key)
    if (!entry) {
      const stamp = ++this.clock
      entry = { stamp, data: menu.runtime.load(view.params, { client: this.requireClient() }) }
      cache?.set(key, entry)
    }
    return entry
  }

  private async handleEditError(view: ViewRecord, error: unknown): Promise<void> {
    const code = discordErrorCode(error)
    switch (code) {
      case 10003: // Unknown Channel
        // Interaction replies in channels the bot can't see (user apps, DMs) report this too; only
        // treat it as "deleted" for messages the bot posted itself.
        if (view.tokenTarget !== null) {
          log.debug(`Can't reach the channel of view ${view.id}; it will refresh on the next click`)
          return
        }
        log.debug(`Menu channel for view ${view.id} is gone; dropping the view`)
        await this.storage.delete(view.id)
        this.renderedAt.delete(view.id)
        return
      case 10008: // Unknown Message
        log.debug(`Menu message for view ${view.id} is gone; dropping the view`)
        await this.storage.delete(view.id)
        this.renderedAt.delete(view.id)
        return
      case 10015: // Unknown Webhook
      case 50027: // Invalid Webhook Token
        view.token = null
        view.tokenExpiresAt = null
        await this.storage.save(view)
        return
      default:
        log.warn(`Could not update menu "${view.menu}" (view ${view.id}): ${stack(error)}`)
    }
  }

  /** Re-render every live view of the given menus (all menus with `resyncOnStart` by default). */
  async resync(names?: string[]): Promise<void> {
    const menus = names
      ? names.map(name => this.menus.get(name)).filter((m): m is AnyMenu => !!m)
      : [...this.menus.values()].filter(menu => menu.runtime.resyncOnStart)
    await Promise.all(menus.map(menu => this.markDirty(menu, ALL_KEYS, { immediate: true })))
  }

  // ---------------------------------------------------------------- closing

  /** Close views of a menu (all of them, or those matching `params`). */
  async close(ref: MenuRef, params?: unknown, mode: CloseMode = "disable"): Promise<number> {
    const menu = this.resolve(ref)
    const views =
      params === undefined
        ? await this.storage.findByMenu(menu.name)
        : await this.storage.findByKey(menu.name, menu.runtime.key(params))
    await mapLimit(views, this.options.concurrency, view => this.closeView(view.id, mode))
    return views.length
  }

  /**
   * Close a single view by id. With `expiredAt`, the view is only closed if it is still expired at
   * that time (a click may have extended it while the sweeper waited for the lock).
   */
  async closeView(viewId: string, mode: CloseMode, expiredAt?: number): Promise<void> {
    await this.withLock(viewId, async () => {
      const view = await this.storage.get(viewId)
      if (!view) return
      if (expiredAt !== undefined && (view.expiresAt === null || view.expiresAt > expiredAt)) return
      await this.closeUnlocked(view, mode)
    })
  }

  private async closeUnlocked(view: ViewRecord, mode: CloseMode): Promise<void> {
    const target = targetFor(view, Date.now())
    const menu = this.menus.get(view.menu)
    try {
      if (target && mode === "delete") {
        await this.requireTransport().delete(target)
      } else if (target && mode === "disable" && menu) {
        const rendered = await this.renderView(menu, view)
        await this.requireTransport().edit(target, {
          ...rendered,
          components: disableComponents(rendered.components)
        })
      }
    } catch (error) {
      const code = discordErrorCode(error)
      if (code !== 10008 && code !== 10003 && code !== 10015 && code !== 50027) {
        log.warn(`Could not ${mode} menu message for view ${view.id}: ${stack(error)}`)
      }
    }
    await this.storage.delete(view.id)
    this.renderedAt.delete(view.id)
  }

  private async replaceOlder(menu: AnyMenu, view: ViewRecord): Promise<void> {
    const policy = menu.runtime.replace ?? (view.ephemeral ? "owner" : "none")
    if (policy === "none") return
    const others = (await this.storage.findByKey(menu.name, view.key)).filter(other => {
      if (other.id === view.id || other.ephemeral !== view.ephemeral) return false
      if (policy === "owner") return other.ownerId !== null && other.ownerId === view.ownerId
      return other.channelId !== null && other.channelId === view.channelId
    })
    await Promise.all(
      others.map(other =>
        this.closeView(other.id, "delete").catch(error =>
          log.warn(`Could not replace older view ${other.id}: ${stack(error)}`)
        )
      )
    )
  }

  // ---------------------------------------------------------------- housekeeping

  /** Close every view whose lifetime ran out. Runs on an interval once the plugin is active. */
  async sweep(now = Date.now()): Promise<number> {
    if (this.sweeping) return 0
    this.sweeping = true
    let count = 0
    try {
      for (;;) {
        const expired = await this.storage.findExpired(now, 100)
        if (!expired.length) break
        await mapLimit(expired, this.options.concurrency, async view => {
          const mode = this.menus.get(view.menu)?.runtime.onExpire ?? this.options.onExpire
          await this.closeView(view.id, mode, now)
        })
        count += expired.length
        if (expired.length < 100) break
      }
    } catch (error) {
      log.error(`Menu sweep failed: ${stack(error)}`)
    } finally {
      this.sweeping = false
    }
    return count
  }

  /** Forget views whose message was deleted. */
  async handleMessageDelete(messageId: string): Promise<void> {
    const view = await this.storage.findByMessage(messageId)
    if (view && !view.ephemeral) {
      await this.storage.delete(view.id)
      this.renderedAt.delete(view.id)
    }
  }

  /** Forget every view in a deleted channel or thread. */
  async handleChannelDelete(channelId: string): Promise<void> {
    const views = await this.storage.findByChannel(channelId)
    await Promise.all(views.map(view => this.storage.delete(view.id)))
    for (const view of views) this.renderedAt.delete(view.id)
  }

  /** Look up open views of a menu, optionally only those for `params`. */
  async views(ref: MenuRef, params?: unknown): Promise<ViewRecord[]> {
    const menu = this.resolve(ref)
    return params === undefined
      ? this.storage.findByMenu(menu.name)
      : this.storage.findByKey(menu.name, menu.runtime.key(params))
  }

  // ---------------------------------------------------------------- interactions

  /**
   * Handle a button, select menu or modal submit. Returns `false` if the interaction doesn't belong
   * to a menu.
   */
  async handleInteraction(interaction: Interaction): Promise<boolean> {
    if (!interaction.isMessageComponent() && !interaction.isModalSubmit()) return false
    const parsed = decodeCustomId(this.options.prefix, interaction.customId)
    if (!parsed) return false

    const responder = new Responder(interaction, this.options.deferAfter)
    try {
      const after = await this.withLock(parsed.viewId, () =>
        this.runInteraction(interaction, parsed.viewId, parsed.action, parsed.arg, responder)
      )
      // Outside the lock: opening a menu may replace (and so lock) the view that was clicked.
      await after?.()
    } catch (error) {
      log.error(`Menu interaction "${interaction.customId}" failed: ${stack(error)}`)
      await responder.notify(this.options.messages.error).catch(() => {})
    } finally {
      responder.dispose()
    }
    return true
  }

  private async runInteraction(
    interaction: MenuInteraction,
    viewId: string,
    action: string,
    arg: string | undefined,
    responder: Responder
  ): Promise<(() => Promise<void>) | undefined> {
    const now = Date.now()
    const view = await this.storage.get(viewId)
    const menu = view ? this.menus.get(view.menu) : undefined
    if (view && !menu) {
      // The menu isn't loaded (being hot-reloaded, or its file failed to import). Keep the view so
      // the buttons work again once the menu is back.
      log.warn(`Menu "${view.menu}" is not registered; keeping view ${view.id} for later clicks`)
      await responder.notify(this.options.messages.error)
      return
    }
    if (!view || !menu || (view.expiresAt !== null && view.expiresAt <= now)) {
      if (view) await this.storage.delete(view.id)
      await this.respondExpired(interaction, responder)
      return
    }

    const info = viewInfo(view)
    const access = await this.checkAccess(menu, view, interaction)
    if (access !== true) {
      await responder.notify(typeof access === "string" ? access : this.options.messages.forbidden)
      return
    }

    const handler = menu.runtime.actions.get(action)
    if (!handler) {
      log.warn(`Menu "${menu.name}" has no action "${action}"; refreshing the menu instead`)
    }

    // ---- run the action
    let state = clone(view.state) as Record<string, unknown>
    let loaded: LoadedData | null = null
    let invalidated: { force: boolean } | null = null
    let navigateTo: { menu: AnyMenu; params: unknown; state: unknown } | null = null
    let closeMode: CloseMode | null = null
    const followUps: InteractionReplyOptions[] = []
    const opens: Array<{ menu: MenuRef; params: unknown; options?: OpenOptions }> = []
    const client = this.requireClient()

    const ctx: ActionContext<any, any, any> = {
      interaction,
      user: interaction.user,
      client,
      params: clone(view.params),
      get state() {
        return state
      },
      arg,
      values: interaction.isAnySelectMenu() ? [...interaction.values] : [],
      fields: interaction.isModalSubmit() ? interaction.fields : null,
      view: info,
      setState: patch => {
        const next = typeof patch === "function" ? patch(state) : patch
        state = { ...state, ...next }
      },
      load: () => {
        loaded ??= { stamp: ++this.clock, data: menu.runtime.load(view.params, { client }) }
        return loaded.data
      },
      id: (name, value) => this.customId(menu, view, name, value),
      invalidate: options => {
        invalidated = { force: Boolean(invalidated?.force || options?.force) }
      },
      reply: message => {
        const { ephemeral = true, ...rest } =
          typeof message === "string" ? { content: message } : (message as Record<string, any>)
        followUps.push({
          allowedMentions: { parse: [] },
          ...rest,
          flags:
            ((rest.flags as number | undefined) ?? 0) | (ephemeral ? MessageFlags.Ephemeral : 0)
        } as InteractionReplyOptions)
      },
      showModal: modal => responder.showModal(modal),
      open: (target, params, options) => {
        opens.push({ menu: target, params, options })
      },
      navigate: (target, params, nextState) => {
        navigateTo = { menu: this.resolve(target), params, state: nextState }
      },
      close: mode => {
        closeMode = mode ?? "disable"
      }
    }

    if (handler) await handler(ctx)

    // ---- apply what the action asked for
    const originalMenu = menu
    const originalKey = view.key
    let current = menu
    const nav = navigateTo as { menu: AnyMenu; params: unknown; state: unknown } | null
    if (nav) {
      current = nav.menu
      assertSerializable(nav.params, "Menu params")
      view.menu = current.name
      view.params = clone(nav.params)
      view.key = current.runtime.key(nav.params)
      view.state = { ...current.runtime.initialState(nav.params), ...(nav.state as object) }
      loaded = null
    } else {
      assertSerializable(state, "Menu state")
      view.state = state
    }

    if (!view.messageId && interaction.message) view.messageId = interaction.message.id
    view.updatedAt = now
    const ttl = this.ttlFor(current, view.ephemeral)
    view.expiresAt = ttl === null ? null : now + ttl

    // Mark other views dirty *before* rendering this one, so the push skips this view.
    const inv = invalidated as { force: boolean } | null
    const pushes: Promise<void>[] = []
    if (inv) {
      pushes.push(this.markDirty(originalMenu, originalKey, inv))
      loaded = null
    }

    const mode = closeMode as CloseMode | null
    if (mode) {
      await this.closeFromInteraction(current, view, mode, responder)
    } else {
      const reuse = loaded as LoadedData | null
      const stamp = reuse ? reuse.stamp : ++this.clock
      const rendered = await this.renderView(current, view, reuse?.data)
      await responder.update(interactionPayload(rendered))
      if (responder.updated) {
        this.renderedAt.set(view.id, stamp)
        // Each click hands us a fresh 15-minute token whose original response is this message.
        view.token = interaction.token
        view.tokenTarget = "@original"
        view.tokenExpiresAt = interaction.createdTimestamp + TOKEN_LIFETIME
        view.applicationId = interaction.applicationId
      }
      await this.storage.save(view)
      if (!responder.updated && !responder.modalShown) {
        // The action answered the interaction itself (e.g. interaction.reply), so edit the message
        // through the normal push path instead.
        pushes.push(this.markDirty(current, view.key, { force: true, immediate: true }))
      }
    }

    for (const followUp of followUps) await responder.followUp(followUp)
    void Promise.all(pushes)
    if (!opens.length) return undefined
    return async () => {
      for (const open of opens) {
        await this.reply(interaction as RepliableInteraction, open.menu, open.params, {
          ...open.options,
          ownerId: open.options?.ownerId ?? interaction.user.id
        })
      }
    }
  }

  private async closeFromInteraction(
    menu: AnyMenu,
    view: ViewRecord,
    mode: CloseMode,
    responder: Responder
  ): Promise<void> {
    if (mode === "delete") {
      await responder.deleteMessage()
    } else if (mode === "disable") {
      const rendered = await this.renderView(menu, view)
      await responder.update({
        ...interactionPayload(rendered),
        components: disableComponents(rendered.components)
      })
    } else {
      await responder.acknowledge()
    }
    await this.storage.delete(view.id)
    this.renderedAt.delete(view.id)
  }

  private async respondExpired(interaction: MenuInteraction, responder: Responder): Promise<void> {
    const components = interaction.message?.components.map(c => c.toJSON())
    if (components?.length && responder.canUpdate) {
      await responder.update({ components: disableComponents(components as any[]) })
    }
    if (this.options.messages.expired) {
      await responder.notify(this.options.messages.expired)
    } else {
      await responder.acknowledge()
    }
  }

  private async checkAccess(
    menu: AnyMenu,
    view: ViewRecord,
    interaction: MenuInteraction
  ): Promise<boolean | string> {
    const rule = menu.runtime.access
    if (rule === "anyone") return true
    if (rule === "owner") return view.ownerId === null || view.ownerId === interaction.user.id
    const result = await rule({
      user: interaction.user,
      view: viewInfo(view),
      params: clone(view.params),
      state: clone(view.state),
      interaction
    })
    return result === true ? true : result === false ? false : result
  }

  // ---------------------------------------------------------------- rendering

  private createView(
    menu: AnyMenu,
    params: unknown,
    init: {
      ephemeral: boolean
      ownerId: string | null
      guildId: string | null
      channelId: string | null
      applicationId: string | null
      state?: Record<string, unknown>
    }
  ): ViewRecord {
    assertSerializable(params, "Menu params")
    const state = { ...menu.runtime.initialState(params), ...init.state }
    assertSerializable(state, "Menu state")
    const now = Date.now()
    const ttl = this.ttlFor(menu, init.ephemeral)
    return {
      id: randomId(),
      menu: menu.name,
      key: menu.runtime.key(params),
      params: clone(params) ?? null,
      state,
      ephemeral: init.ephemeral,
      ownerId: init.ownerId,
      guildId: init.guildId,
      channelId: init.channelId,
      messageId: null,
      applicationId: init.applicationId,
      token: null,
      tokenTarget: null,
      tokenExpiresAt: null,
      createdAt: now,
      updatedAt: now,
      expiresAt: ttl === null ? null : now + ttl
    }
  }

  private ttlFor(menu: AnyMenu, ephemeral: boolean): number | null {
    const own = ephemeral ? menu.runtime.ttl.ephemeral : menu.runtime.ttl.public
    if (own !== undefined) return own
    return ephemeral ? this.options.ttl.ephemeral : this.options.ttl.public
  }

  private async renderView(
    menu: AnyMenu,
    view: ViewRecord,
    data?: Promise<unknown>
  ): Promise<RenderedMenu> {
    const client = this.requireClient()
    const ctx: RenderContext<any, any, any> = {
      params: clone(view.params),
      state: clone(view.state),
      data: await (data ?? menu.runtime.load(view.params, { client })),
      view: viewInfo(view),
      client,
      id: (action, arg) => this.customId(menu, view, action, arg)
    }
    const rendered = normalizeOutput(await menu.runtime.render(ctx))
    if (!rendered.components.length) {
      throw new Error(`Menu "${menu.name}" rendered no components`)
    }
    validateCustomIds(menu.name, rendered.components)
    return rendered
  }

  private customId(menu: AnyMenu, view: ViewRecord, action: string, arg?: string | number): string {
    if (!menu.runtime.actions.has(action)) {
      const known = [...menu.runtime.actions.keys()].filter(
        a => !a.startsWith(BUILTIN_ACTION_PREFIX)
      )
      throw new Error(
        `Menu "${menu.name}" has no action "${action}". Known actions: ${known.join(", ") || "(none)"}`
      )
    }
    return encodeCustomId(this.options.prefix, view.id, action, arg)
  }

  // ---------------------------------------------------------------- utils

  private async withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>(resolve => {
      release = resolve
    })
    const tail = previous.then(() => current)
    this.locks.set(id, tail)
    await previous
    try {
      return await fn()
    } finally {
      release()
      if (this.locks.get(id) === tail) this.locks.delete(id)
    }
  }

  requireClient(): Client {
    if (!this.client) {
      throw new Error(
        "The menu plugin isn't active yet. Add menu() to the plugins in commandkit.config.ts."
      )
    }
    return this.client
  }

  private requireTransport(): MenuTransport {
    this.requireClient()
    return this.transport!
  }
}

/**
 * Wraps one interaction and keeps track of how it has been answered, so the engine can always pick a
 * valid response (update vs. editReply vs. followUp) and auto-defer slow actions.
 */
class Responder {
  updated = false
  modalShown = false
  readonly canUpdate: boolean
  private queue: Promise<unknown> = Promise.resolve()
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly interaction: MenuInteraction,
    deferAfter: number
  ) {
    this.canUpdate =
      interaction.isMessageComponent() ||
      (interaction.isModalSubmit() && interaction.isFromMessage())
    if (deferAfter > 0) {
      this.timer = setTimeout(() => void this.autoDefer(), deferAfter)
    }
  }

  private get acknowledged() {
    return this.interaction.deferred || this.interaction.replied || this.modalShown
  }

  private run<T>(op: () => Promise<T>): Promise<T> {
    const next = this.queue.then(op, op)
    this.queue = next.catch(() => {})
    return next
  }

  private autoDefer() {
    return this.run(async () => {
      if (this.acknowledged) return
      if (this.canUpdate) {
        await (this.interaction as MessageComponentInteraction).deferUpdate()
      } else {
        await this.interaction.deferReply({ flags: MessageFlags.Ephemeral })
      }
    }).catch(error => log.warn(`Could not auto-defer menu interaction: ${stack(error)}`))
  }

  showModal(modal: unknown): Promise<void> {
    return this.run(async () => {
      if (this.acknowledged) {
        throw new Error(
          "ctx.showModal() must be called before the interaction is answered (and within ~2s)."
        )
      }
      if (!("showModal" in this.interaction)) {
        throw new Error("A modal can't be shown in response to a modal submit.")
      }
      this.clearTimer()
      await (this.interaction as MessageComponentInteraction).showModal(modal as any)
      this.modalShown = true
    })
  }

  update(payload: Record<string, any>): Promise<void> {
    return this.run(async () => {
      this.clearTimer()
      if (this.modalShown || this.interaction.replied) return
      if (!this.canUpdate) {
        // modal submitted from a slash command: nothing to update, just close the "thinking" state
        if (!this.interaction.deferred) {
          await this.interaction.deferReply({ flags: MessageFlags.Ephemeral })
        }
        await this.interaction.deleteReply().catch(() => {})
        return
      }
      const component = this.interaction as MessageComponentInteraction
      if (component.deferred && component.ephemeral !== null) {
        // The action called deferReply(), so editReply would edit its "thinking" message rather
        // than the menu. Leave `updated` false and let the engine push the edit instead.
        return
      }
      if (component.deferred) {
        await component.editReply(payload)
      } else {
        await component.update(payload)
      }
      this.updated = true
    })
  }

  acknowledge(): Promise<void> {
    return this.run(async () => {
      this.clearTimer()
      if (this.acknowledged) return
      if (this.canUpdate) await (this.interaction as MessageComponentInteraction).deferUpdate()
      else await this.interaction.deferReply({ flags: MessageFlags.Ephemeral })
    })
  }

  deleteMessage(): Promise<void> {
    return this.run(async () => {
      this.clearTimer()
      const component = this.interaction as MessageComponentInteraction
      if (!this.acknowledged) await component.deferUpdate()
      await component.deleteReply().catch(() => component.message?.delete().catch(() => {}))
    })
  }

  followUp(payload: InteractionReplyOptions): Promise<void> {
    return this.run(async () => {
      this.clearTimer()
      if (this.interaction.deferred || this.interaction.replied) {
        await this.interaction.followUp(payload)
      } else {
        await this.interaction.reply(payload)
      }
    })
  }

  /** Short ephemeral notice; replies if possible, otherwise follows up. */
  notify(content: string): Promise<void> {
    return this.followUp({
      content,
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] }
    })
  }

  private clearTimer() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  dispose() {
    this.clearTimer()
  }
}

function interactionPayload(rendered: RenderedMenu) {
  return {
    components: rendered.components as any[],
    files: rendered.files.length ? (rendered.files as any[]) : undefined,
    allowedMentions: rendered.allowedMentions
  }
}

/**
 * How to edit a view's message. A live interaction token works everywhere (including channels the
 * bot can't read, like user-app or DM replies), so it is preferred; public messages fall back to the
 * channel endpoint once the token expires. Ephemeral messages can only be edited with a token.
 */
function targetFor(view: ViewRecord, now: number): MessageTarget | null {
  if (
    view.token &&
    view.applicationId &&
    view.tokenExpiresAt !== null &&
    view.tokenExpiresAt > now
  ) {
    return {
      kind: "webhook",
      applicationId: view.applicationId,
      token: view.token,
      messageId: view.tokenTarget ?? "@original"
    }
  }
  if (!view.ephemeral && view.channelId && view.messageId) {
    return { kind: "channel", channelId: view.channelId, messageId: view.messageId }
  }
  return null
}

function viewInfo(view: ViewRecord): ViewInfo {
  return {
    id: view.id,
    menu: view.menu,
    key: view.key,
    ephemeral: view.ephemeral,
    ownerId: view.ownerId,
    guildId: view.guildId,
    channelId: view.channelId,
    messageId: view.messageId
  }
}

function toRef(view: ViewRecord): ViewRef {
  return {
    id: view.id,
    menu: view.menu,
    key: view.key,
    messageId: view.messageId,
    channelId: view.channelId,
    ephemeral: view.ephemeral
  }
}

function stack(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error)
}

/** The shared engine for this process. */
export function getMenuEngine(): MenuEngine {
  return globalSingleton("engine", () => new MenuEngine())
}
