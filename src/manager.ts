import { Logger } from "commandkit"
import type { BaseMenu } from "./menus/base"
import { PaginationMenu } from "./menus/pagination"
import { getPluginConfig } from "./plugin"
import type {
  MenuData,
  MenuParams,
  PaginationMenuDefinition,
  SinglePageMenuDefinition
} from "./types"

export interface CreateSessionOptions<Data extends MenuData> {
  /** Menu name to create session for */
  menu: string

  /** Parameters to pass to the menu's fetch function */
  params: MenuParams<Data>

  /** User ID creating this session */
  userId: string

  /** Custom session ID (generated if not provided) */
  sessionId?: string

  /** Items per page (pagination menus only) */
  itemsPerPage?: number

  /** Preload all pages on render (pagination menus only) */
  preloadAll?: boolean
}

export interface SessionKey {
  menuName: string
  contextKey: string // Serialized params for matching
}

export class MenuManager {
  private menus = new Map<string, any>()
  private sessions = new Map<string, BaseMenu<any>>()
  private sessionTimers = new Map<string, NodeJS.Timeout>()

  // Map context keys to session IDs for reuse
  private contextToSession = new Map<string, string>()

  /**
   * Register a menu definition
   */
  public register<Data extends MenuData>(
    menu: SinglePageMenuDefinition<Data> | PaginationMenuDefinition<Data>
  ): void {
    if (this.menus.has(menu.name)) {
      Logger.error(`Duplicate menu: ${menu.name}`)
      return
    }

    this.menus.set(menu.name, menu)
    Logger.info(`Loaded menu: ${menu.name}`)
  }

  /**
   * Generate a context key from menu name and params
   */
  private generateContextKey(menuName: string, params: any): string {
    return `${menuName}:${JSON.stringify(params)}`
  }

  /**
   * Create a new menu session
   */
  public async createSession<Data extends MenuData>(
    options: CreateSessionOptions<Data>
  ): Promise<{ sessionId: string; menu: BaseMenu<Data> }> {
    const {
      menu: menuName,
      params,
      userId,
      sessionId,
      preloadAll,
      itemsPerPage
    } = options

    const definition = this.menus.get(menuName)

    if (!definition) {
      throw new Error(`Menu "${menuName}" not found. Did you register it?`)
    }

    const mode = definition.sessionOptions?.mode ?? "shared"

    // Check if we should reuse an existing session
    if (mode === "shared") {
      const contextKey = this.generateContextKey(menuName, params)
      const existingSessionId = this.contextToSession.get(contextKey)

      if (existingSessionId && this.sessions.has(existingSessionId)) {
        const existingMenu = this.sessions.get(existingSessionId)!

        // Add user as viewer
        existingMenu.addViewer(userId)

        return {
          sessionId: existingSessionId,
          menu: existingMenu as BaseMenu<Data>
        }
      }
    }

    const config = getPluginConfig()

    const id = sessionId ?? this.generateSessionId()

    let menu: BaseMenu<Data>

    if ("renderItem" in definition) {
      menu = new PaginationMenu<Data>(
        definition as PaginationMenuDefinition<Data>,
        id,
        params,
        userId,
        {
          preloadAll: preloadAll ?? config.preloadAll
        }
      )

      // Set items per page if provided
      if (itemsPerPage && "definition" in menu) {
        (menu as any).definition.perPage = itemsPerPage
      }
    } else {
      // menu = new SinglePageMenu(definition, sessionId, params)
      menu = new PaginationMenu(definition, id, params, userId)
    }

    this.sessions.set(id, menu)

    // Store context mapping for shared sessions
    if (mode === "shared") {
      const contextKey = this.generateContextKey(menuName, params)
      this.contextToSession.set(contextKey, id)
    }

    const ttl = definition.sessionOptions?.ttl
    if (ttl) {
      this.setupTTL(id, ttl)
    }

    return { sessionId: id, menu }
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

    // Remove context mapping
    for (const [contextKey, sid] of this.contextToSession.entries()) {
      if (sid === sessionId) {
        this.contextToSession.delete(contextKey)
      }
    }

    // Clear TTL timer if exists
    const timer = this.sessionTimers.get(sessionId)
    if (timer) {
      clearTimeout(timer)
      this.sessionTimers.delete(sessionId)
    }

    // Call destroy hook
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

  private generateSessionId(): string {
    return `menu_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
  }
}

export const menuManager = new MenuManager()
