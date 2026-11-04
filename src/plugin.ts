import { existsSync } from "node:fs"
import { readdir } from "node:fs/promises"
import path from "node:path"
import {
  type CommandKitHMREvent,
  type CommandKitPluginRuntime,
  getCurrentDirectory,
  RuntimePlugin,
  toFileURL
} from "commandkit"
import { type Awaitable, type Client, Events, type Interaction } from "discord.js"
import { isMenuDefinition, type MenuDefinitionBase } from "./definition"
import { getMenuEngine, type MenuEngineOptions } from "./engine"
import { log } from "./logger"
import type { MenuStorage } from "./storage/types"
import { globalSingleton } from "./utils"

export interface MenuPluginOptions
  extends Partial<Omit<MenuEngineOptions, "ttl" | "messages" | "navigation">> {
  /**
   * Where views are stored. Use `RedisMenuStorage` or `SqliteMenuStorage` so menus survive restarts.
   * A function is called once when the plugin activates (so the config file can stay side-effect free).
   * You can also call `setMenuStorage()` from your app instead.
   */
  storage?: MenuStorage | (() => Awaitable<MenuStorage>)
  /** Folder (inside `src/app`) to load menus from. Default `"menus"`. */
  directory?: string
  /** Re-render every live view of every menu when the bot starts. Default `false`. */
  resyncOnStart?: boolean
  ttl?: Partial<MenuEngineOptions["ttl"]>
  messages?: Partial<MenuEngineOptions["messages"]>
  navigation?: Partial<MenuEngineOptions["navigation"]>
}

const storageState = globalSingleton("storage-state", () => ({ configured: false }))

/** Use a storage driver from your own code (e.g. `src/app.ts`), sharing your existing connection. */
export function setMenuStorage(storage: MenuStorage): void {
  storageState.configured = true
  getMenuEngine().setStorage(storage)
}

/** Register a menu that doesn't live in `src/app/menus`. Do this at startup so old buttons work. */
export function registerMenu(menu: MenuDefinitionBase): void {
  getMenuEngine().register(menu)
}

export class MenuPlugin extends RuntimePlugin<MenuPluginOptions> {
  public readonly name = "MenuPlugin"

  /** Menu names loaded from each file, so HMR can drop menus whose file changed or was deleted. */
  private fileMenus = new Map<string, string[]>()
  private client: Client | null = null
  private listeners: Array<[string, (...args: any[]) => void]> = []

  public override async activate(ctx: CommandKitPluginRuntime): Promise<void> {
    const engine = getMenuEngine()
    const { storage, directory: _directory, resyncOnStart: _resync, ...options } = this.options
    engine.configure(options as Partial<MenuEngineOptions>)

    if (storage) {
      setMenuStorage(typeof storage === "function" ? await storage() : storage)
    } else if (!storageState.configured && process.env.NODE_ENV === "production") {
      log.warn(
        "No storage configured, so menus are kept in memory and stop working after a restart. " +
          "Pass `storage` to menu() (RedisMenuStorage or SqliteMenuStorage)."
      )
    }

    this.client = ctx.commandkit.client
    engine.attachClient(this.client)
    this.attachListeners(this.client)
    await this.loadMenus()
    engine.startSweeper()
    log.info(`Menu plugin active with ${engine.menus.size} menu(s)`)
  }

  public override async deactivate(): Promise<void> {
    for (const [event, listener] of this.listeners) this.client?.off(event, listener)
    this.listeners = []
    await getMenuEngine().shutdown()
  }

  public override async onBeforeInteraction(
    _ctx: CommandKitPluginRuntime,
    interaction: Interaction
  ): Promise<void> {
    await getMenuEngine().handleInteraction(interaction)
  }

  public override async onAfterClientLogin(): Promise<void> {
    const engine = getMenuEngine()
    const names = this.options.resyncOnStart ? [...engine.menus.keys()] : undefined
    void engine.resync(names)
  }

  public override async performHMR(
    _ctx: CommandKitPluginRuntime,
    event: CommandKitHMREvent
  ): Promise<void> {
    if (event.event !== "unknown") return
    const sourceDir = path.join(process.cwd(), "src", "app", this.directory)
    if (!path.resolve(event.path).startsWith(sourceDir + path.sep)) return
    event.preventDefault()
    event.accept()
    const changed = await this.loadMenus()
    // Push the new render to open messages so edits show up immediately while developing.
    await getMenuEngine().resync(changed)
  }

  private get directory(): string {
    return this.options.directory ?? "menus"
  }

  /** (Re)load every menu file. Returns the names of the menus that were loaded. */
  private async loadMenus(): Promise<string[]> {
    const engine = getMenuEngine()
    const root = path.join(getCurrentDirectory(), "app", this.directory)
    for (const names of this.fileMenus.values()) for (const name of names) engine.unregister(name)
    this.fileMenus.clear()
    if (!existsSync(root)) return []

    const loaded: string[] = []
    for (const file of await listModules(root)) {
      const mod = await import(toFileURL(file, true)).catch(error => {
        log.error(`Could not load menu file ${file}: ${error?.stack ?? error}`)
        return null
      })
      if (!mod) continue
      const menus = Object.values(mod as Record<string, unknown>).filter(isMenuDefinition)
      const names: string[] = []
      for (const menu of new Set(menus)) {
        if (loaded.includes(menu.name)) {
          log.error(`Duplicate menu name "${menu.name}" in ${file}; keeping the first one`)
          continue
        }
        engine.register(menu)
        names.push(menu.name)
        loaded.push(menu.name)
      }
      if (!names.length)
        log.warn(`${file} doesn't export a menu (prefix helper files with "_" to skip them)`)
      this.fileMenus.set(file, names)
    }
    return loaded
  }

  private attachListeners(client: Client) {
    const engine = getMenuEngine()
    const on = (event: string, listener: (...args: any[]) => void) => {
      client.on(event, listener)
      this.listeners.push([event, listener])
    }
    const safe = (fn: () => Promise<void>) => {
      fn().catch(error => log.warn(`Menu cleanup failed: ${error?.stack ?? error}`))
    }
    on(Events.MessageDelete, message => safe(() => engine.handleMessageDelete(message.id)))
    on(Events.MessageBulkDelete, messages =>
      safe(async () => {
        for (const id of messages.keys()) await engine.handleMessageDelete(id)
      })
    )
    on(Events.ChannelDelete, channel => safe(() => engine.handleChannelDelete(channel.id)))
    on(Events.ThreadDelete, thread => safe(() => engine.handleChannelDelete(thread.id)))
  }
}

async function listModules(dir: string): Promise<string[]> {
  const out: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith("_") || entry.name.startsWith(".")) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...(await listModules(full)))
    } else if (/\.(c|m)?(j|t)sx?$/.test(entry.name) && !/\.d\.(c|m)?ts$/.test(entry.name)) {
      out.push(full)
    }
  }
  return out.sort()
}

/** Create the menu plugin for `commandkit.config.ts`. */
export function menu(options: MenuPluginOptions = {}): MenuPlugin {
  return new MenuPlugin(options)
}
