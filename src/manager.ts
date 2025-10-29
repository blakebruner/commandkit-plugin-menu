import { Logger } from "commandkit"
import type { RepliableInteraction } from "discord.js"
import type { BaseMenu } from "./menus/base"
import { PaginationMenu } from "./menus/pagination"
import { getPluginConfig } from "./plugin"
import type {
  MenuData,
  MenuDefinition,
  MenuParams,
  PaginationMenuDefinition
} from "./types"

export interface CreateSessionOptions<Data extends MenuData> {
  /** Menu name to create session for */
  menu: string

  /** The interaction that triggered this menu */
  interaction: RepliableInteraction

  /** Parameters to pass to the menu's fetch function */
  params: MenuParams<Data>

  /** Preload all pages on render (pagination menus only) */
  preloadAll?: boolean
}

export class MenuManager {
  /** Registered menu definitions */
  private menus = new Map<string, MenuDefinition<any>>()

  /** Active menu sessions */
  private sessions = new Map<string, BaseMenu<any>>()

  /** Session auto-destroy timers */
  private sessionTimers = new Map<string, NodeJS.Timeout>()

  /**
   * Register a menu definition
   */
  public register<Data extends MenuData>(menu: MenuDefinition<Data>): void {
    if (this.menus.has(menu.name)) {
      Logger.error(`Duplicate menu: ${menu.name}`)
      return
    }

    this.menus.set(menu.name, menu)
    Logger.info(`Loaded menu: ${menu.name}`)
  }

  /**
   * Create a new menu session
   */
  public async createSession<Data extends MenuData>(
    options: CreateSessionOptions<Data>
  ): Promise<BaseMenu<Data>> {
    const { menu: menuName, params, interaction, preloadAll } = options
    const userId = interaction.user.id

    const definition = this.menus.get(menuName)

    if (!definition) {
      throw new Error(`Menu "${menuName}" not found. Did you register it?`)
    }

    const mode = definition.sessionOptions?.mode ?? "shared"
    const ephemeral = definition.sessionOptions?.ephemeral ?? false

    const contextKey = await definition.createKey(params)

    const existingMenu = this.sessions.get(contextKey)

    if (existingMenu) {
      if (mode === "shared") {
        // Check if user already has this menu open
        if (existingMenu.hasUserSession(userId)) {
          return existingMenu
        }

        // Add this user to the shared session
        await existingMenu.addUserSession({
          userId,
          messageId: "",
          channelId: interaction.channelId!,
          currentPage: 0,
          ephemeral,
          createdAt: Date.now()
        })

        return existingMenu
      } else if (mode === "private") {
        if (existingMenu.getCreatorId() !== userId) {
          throw new Error("This menu is currently in use by another user")
        }

        return existingMenu
      }
    }

    // Create new session
    const config = getPluginConfig()

    let menu: BaseMenu<Data>

    if ("renderItem" in definition) {
      menu = new PaginationMenu<Data>(
        definition as PaginationMenuDefinition<Data>,
        contextKey,
        params,
        userId,
        {
          preloadAll: preloadAll ?? config.preloadAll
        }
      )
    } else {
      menu = new PaginationMenu(definition as any, contextKey, params, userId)
    }

    await (menu as any).initialize()

    await menu.addUserSession({
      userId,
      messageId: "",
      channelId: interaction.channelId!,
      currentPage: 0,
      ephemeral,
      createdAt: Date.now()
    })

    this.sessions.set(contextKey, menu)

    const ttl = definition.sessionOptions?.ttl
    if (ttl) {
      this.setupTTL(contextKey, ttl)
    }

    return menu
  }

  /**
   * Get an existing session
   */
  public getSession<Data extends MenuData>(
    sessionId: string
  ): BaseMenu<Data> | undefined {
    return this.sessions.get(sessionId)
  }

  /**
   * Check if a session exists
   */
  public hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId)
  }

  /**
   * End a session
   */
  public async endSession(sessionId: string): Promise<void> {
    const menu = this.sessions.get(sessionId)

    if (!menu) {
      Logger.warn(`Session not found: ${sessionId}`)
      return
    }

    const timer = this.sessionTimers.get(sessionId)
    if (timer) {
      clearTimeout(timer)
      this.sessionTimers.delete(sessionId)
    }

    await menu.destroy()
    this.sessions.delete(sessionId)
  }

  /**
   * Get all active session IDs
   */
  public getAllSessions(): string[] {
    return Array.from(this.sessions.keys())
  }

  /**
   * Get sessions count
   */
  public getSessionCount(): number {
    return this.sessions.size
  }

  /**
   * Check if a menu is registered
   */
  public hasMenu(menuName: string): boolean {
    return this.menus.has(menuName)
  }

  public getMenu<Data extends MenuData>(
    menuName: string
  ): MenuDefinition<Data> | undefined {
    return this.menus.get(menuName)
  }

  /**
   * Get all registered menu names
   */
  public getAllMenuNames(): string[] {
    return Array.from(this.menus.keys())
  }

  private setupTTL(sessionId: string, ttl: number): void {
    const timer = setTimeout(() => this.endSession(sessionId), ttl)
    this.sessionTimers.set(sessionId, timer)
  }

  public generateSessionId(): string {
    return `menu_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
  }
}

export const menuManager = new MenuManager()
