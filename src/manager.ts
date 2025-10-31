import { Logger } from "commandkit"
import type { RepliableInteraction } from "discord.js"
import type { BaseMenu } from "./menus/base"
import { PaginationMenu } from "./menus/pagination"
import { SinglePageMenu } from "./menus/single"
import type {
  MenuData,
  MenuParams,
  PaginationMenuDefinition,
  SinglePageMenuDefinition
} from "./types"
import { menuRegistry } from "./registry"

export interface CreateSessionOptions<Data extends MenuData> {
  /** Menu name to create session for */
  menu: string

  /** The interaction that triggered this menu */
  interaction: RepliableInteraction

  /** Parameters to pass to the menu's fetch function */
  params: MenuParams<Data>

}

export class MenuManager {

  /** Active menu sessions */
  private sessions = new Map<string, BaseMenu<any>>()

  /** Session auto-destroy timers */
  private sessionTimers = new Map<string, NodeJS.Timeout>()

  /**
   * Create a new menu session
   */
  public async createSession<Data extends MenuData>(
    options: CreateSessionOptions<Data>
  ): Promise<BaseMenu<Data>> {
    const { menu: menuName, params, interaction } = options
    const userId = interaction.user.id

    const definition = menuRegistry.get(menuName)

    if (!definition) {
      throw new Error(`Menu "${menuName}" not found. Did you register it?`)
    }

    const mode = definition.sessionOptions?.mode ?? "shared"
    const ephemeral = definition.sessionOptions?.ephemeral ?? false

    const contextKey = await definition.createKey(params)
    const existingMenu = this.sessions.get(contextKey)

    // Check if we should reuse an existing session
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

    // Create new menu based on type
    let menu: BaseMenu<Data>

    switch (definition.type) {
      case "pagination":
        menu = new PaginationMenu<Data>(
          definition as PaginationMenuDefinition<Data>,
          contextKey,
          params,
          userId,
        )
        break

      case "single":
        menu = new SinglePageMenu<Data>(
          definition as SinglePageMenuDefinition<Data>,
          contextKey,
          params,
          userId
        )
        break

      default:
        throw new Error(`Unknown menu: ${definition}`)
    }

    await menu.initialize()

    // Add initial user session
    await menu.addUserSession({
      userId,
      messageId: "",
      channelId: interaction.channelId!,
      currentPage: 0,
      ephemeral,
      createdAt: Date.now()
    })

    // Store the session
    this.sessions.set(contextKey, menu)

    // Set up TTL if defined
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

  private setupTTL(sessionId: string, ttl: number): void {
    const timer = setTimeout(() => this.endSession(sessionId), ttl)
    this.sessionTimers.set(sessionId, timer)
  }
}

export const menuManager = new MenuManager()
