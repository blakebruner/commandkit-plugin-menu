import { Logger } from "commandkit"
import {
  type APIComponentInContainer,
  type ButtonInteraction,
  type Client,
  type ContainerBuilder,
  type RGBTuple,
  resolveColor,
  type StringSelectMenuInteraction,
  type TextChannel
} from "discord.js"
import { INTERNAL_ACTION_PREFIX, RESERVED_ACTIONS } from "../constants"
import { getPluginConfig } from "../plugin"
import type {
  ActionHandler,
  BaseMenuDefinition,
  ContainerComponentOrFragment,
  MenuData,
  MenuParams,
  MenuSession,
  SessionContext,
  UserSession
} from "../types"

export abstract class BaseMenu<Data extends MenuData> {
  protected definition: BaseMenuDefinition<Data>
  protected sessionId: string
  protected params: MenuParams<Data>
  protected sessionData!: MenuSession<Data>
  protected isInitialized = false
  protected colorResolved?: RGBTuple | number

  protected creatorId: string // User who created the session

  // User session tracking
  protected userSessions = new Map<string, UserSession>() // userId -> session info

  // Action registry
  protected actions = new Map<string, ActionHandler<Data>>()

  constructor(
    definition: BaseMenuDefinition<Data>,
    sessionId: string,
    params: MenuParams<Data>,
    creatorId: string
  ) {
    this.definition = definition
    this.sessionId = sessionId
    this.params = params
    this.creatorId = creatorId

    if (definition.actions) {
      // Register actions from definition
      for (const [actionName, handler] of Object.entries(definition.actions)) {
        this.registerAction(actionName, handler)
      }
    }
  }

  /**
   * Get creator ID
   */
  public getCreatorId(): string {
    return this.creatorId
  }

  /**
   * Add a user session
   */
  async addUserSession(userSession: UserSession): Promise<void> {
    this.userSessions.set(userSession.userId, userSession)
  }

  /**
   * Remove a user session
   */
  removeUserSession(userId: string): void {
    this.userSessions.delete(userId)
  }

  /**
   * Check if a user has a session
   */
  hasUserSession(userId: string): boolean {
    return this.userSessions.has(userId)
  }

  /**
   * Get a user's session
   */
  getUserSession(userId: string): UserSession | undefined {
    return this.userSessions.get(userId)
  }

  /**
   * Get all user sessions
   */
  getAllUserSessions(): UserSession[] {
    return Array.from(this.userSessions.values())
  }

  /**
   * Update a user's message ID after sending
   */
  updateUserMessageId(userId: string, messageId: string): void {
    const session = this.userSessions.get(userId)
    if (session) {
      session.messageId = messageId
    }
  }

  /**
   * Check if a user can interact with this session
   */
  public canInteract(userId: string): boolean {
    const mode = this.definition.sessionOptions?.mode ?? "shared"

    switch (mode) {
      case "shared":
        // Anyone who is a viewer can interact
        return this.hasUserSession(userId)

      case "private":
        // Only creator can interact
        return userId === this.creatorId

      default:
        return false
    }
  }

  /**
   * Get session mode
   */
  public getMode(): "shared" | "private" | "locked" {
    return this.definition.sessionOptions?.mode ?? "shared"
  }

  /**
   * Get user's current page
   */
  getUserPage(userId: string): number {
    const session = this.userSessions.get(userId)
    return session?.currentPage ?? 0
  }

  /**
   * Set user's current page
   */
  setUserPage(userId: string, page: number): void {
    const session = this.userSessions.get(userId)
    if (session) {
      session.currentPage = page
    }
  }

  /**
   * Broadcast update to all users with this menu open
   */
  async broadcastUpdate(client: Client): Promise<void> {
    const updatePromises: Promise<void>[] = []

    for (const userSession of this.userSessions.values()) {
      updatePromises.push(this.updateUserMessage(client, userSession.userId))
    }

    await Promise.all(updatePromises)
  }

  /**
   * Update a specific user's message
   */
  async updateUserMessage(client: Client, userId: string): Promise<void> {
    const userSession = this.userSessions.get(userId)

    if (!userSession || !userSession.messageId) {
      return
    }

    try {
      const channel = (await client.channels.fetch(
        userSession.channelId
      )) as TextChannel
      if (!channel?.isTextBased()) {
        return
      }

      const message = await channel.messages.fetch(userSession.messageId)

      // Render the page for this specific user
      const page = await this.renderForUser(userId)

      await message.edit({
        components: [page]
      })
    } catch (error) {
      Logger.error(`Failed to update message for user ${userId}: ${error}`)
    }
  }

  protected async initialize(): Promise<void> {
    if (this.isInitialized) {
      return
    }

    // Initialize session data
    if (this.definition.onSessionStart) {
      this.sessionData = await this.definition.onSessionStart(this.params)
    } else {
      this.sessionData = {}
    }

    if (this.definition.color) {
      this.colorResolved = resolveColor(this.definition.color)
    }

    this.isInitialized = true
  }

  protected createSessionContext(): SessionContext<Data> {
    return {
      params: this.params,
      sessionId: this.sessionId,
      sessionData: this.sessionData
    }
  }

  protected async renderTitle(): Promise<APIComponentInContainer[] | null> {
    if (this.definition.renderTitle) {
      const ctx = this.createSessionContext()
      const title = await this.definition.renderTitle(ctx)

      return this.handleComponentOrFragment(title)
    }
    return null
  }

  protected handleComponentOrFragment(
    component: ContainerComponentOrFragment
  ): APIComponentInContainer[] {
    if (Array.isArray(component)) {
      return component.flat().map(c => c.toJSON()) as APIComponentInContainer[]
    } else {
      return [component.toJSON()] as APIComponentInContainer[]
    }
  }

  /**
   * Register a user action (validates against reserved names)
   */
  protected registerAction(
    actionName: string,
    handler: ActionHandler<Data>
  ): void {
    if (RESERVED_ACTIONS.has(actionName)) {
      throw new Error(
        `Cannot register action "${actionName}": this name is reserved for navigation. ` +
          `Reserved names: ${Array.from(RESERVED_ACTIONS).join(", ")}`
      )
    }

    if (this.actions.has(actionName)) {
      throw new Error(`Action "${actionName}" is already registered.`)
    }

    this.actions.set(actionName, handler)
  }

  protected createActionId(action: string): string {
    if (RESERVED_ACTIONS.has(action)) {
      throw new Error(`Action "${action}" is reserved for internal navigation`)
    }

    const pluginConfig = getPluginConfig()
    return `${pluginConfig.actionPrefix}:${this.sessionId}:${action}`
  }

  /**
   * Parse a custom ID and determine if it's a navigation or user action
   */
  protected parseActionId(action: string): {
    type: "navigation" | "user"
    action: string
    itemIndex?: number
  } | null {
    // Check if it's a navigation action
    if (action.startsWith(INTERNAL_ACTION_PREFIX)) {
      const actionName = action.slice(INTERNAL_ACTION_PREFIX.length)
      return {
        type: "navigation",
        action: actionName
      }
    }

    // It's a user action - check for item index
    if (action.includes("|")) {
      const [actionName, indexStr] = action.split("|")
      const itemIndex = parseInt(indexStr, 10)

      if (isNaN(itemIndex)) {
        return null
      }

      return {
        type: "user",
        action: actionName,
        itemIndex
      }
    }

    return {
      type: "user",
      action: action
    }
  }

  /**
   * Hijack a component's custom ID to add session info
   */
  protected hijackComponentId(component: any, actionName: string): any {
    const customId = this.createActionId(actionName)

    if ("setCustomId" in component) {
      return component.setCustomId(customId)
    }

    return component
  }

  // Session management
  protected shouldAutoDelete(): boolean {
    return this.definition.sessionOptions?.deleteOnEnd ?? false
  }

  protected shouldUpdateOnEnd(): boolean {
    return this.definition.sessionOptions?.updateOnEnd ?? false
  }

  protected getEndRenderMode(): "replace" | "merge" | "append" {
    return this.definition.sessionOptions?.endRenderMode ?? "replace"
  }

  protected isSharedSession(): boolean {
    return this.definition.sessionOptions?.mode === "shared"
  }

  protected getTTL(): number | undefined {
    return this.definition.sessionOptions?.ttl
  }

  async destroy(): Promise<void> {
    if (this.definition.onSessionEnd) {
      await this.definition.onSessionEnd({
        params: this.params,
        sessionId: this.sessionId,
        sessionData: this.sessionData
      })
    }
  }

  // Abstract methods
  public abstract render(): Promise<ContainerBuilder>
  abstract renderForUser(userId: string): Promise<ContainerBuilder>
  public abstract handleInteraction(
    interaction: ButtonInteraction | StringSelectMenuInteraction,
    action: string
  ): Promise<ContainerBuilder | null>
}
