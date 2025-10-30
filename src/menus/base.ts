import CommandKit, { Logger } from "commandkit"
import {
  type APIComponentInContainer,
  type ButtonInteraction,
  type Client,
  type ContainerBuilder,
  type Interaction,
  type InteractionResponse,
  type RGBTuple,
  resolveColor,
  type StringSelectMenuInteraction,
  type TextChannel,
  WebhookClient,
  AnySelectMenuInteraction
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
  protected sessionData: MenuSession<Data> = {}
  protected isInitialized = false
  protected colorResolved?: RGBTuple | number

  protected creatorId: string // User who created the session

  // User session tracking (userId -> session info)
  protected userSessions = new Map<string, UserSession>()

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
   * Get menu params
   */
  public getParams(): MenuParams<Data> {
    return this.params
  }

  /**
   * Set session data
   */
  public setSessionData(sessionData: MenuSession<Data>): void {
    this.sessionData = sessionData
  }

  /**
   * Get session data
   */
  public getSessionData(): MenuSession<Data> {
    return this.sessionData
  }

  /**
   * Add a user session
   */
  public async addUserSession(userSession: UserSession): Promise<void> {
    this.userSessions.set(userSession.userId, userSession)
  }

  /**
   * Remove a user session
   */
  public removeUserSession(userId: string): void {
    this.userSessions.delete(userId)
  }

  /**
   * Check if a user has a session
   */
  public hasUserSession(userId: string): boolean {
    return this.userSessions.has(userId)
  }

  /**
   * Get a user's session
   */
  public getUserSession(userId: string): UserSession | undefined {
    return this.userSessions.get(userId)
  }

  /**
   * Get all user sessions
   */
  public getAllUserSessions(): UserSession[] {
    return Array.from(this.userSessions.values())
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
   * Broadcast update to all users with this menu open
   */
  public async broadcastUpdate(): Promise<void> {
    const client = CommandKit.instance?.client
    if (!client) {
      Logger.error("Cannot broadcast update: CommandKit client not available")
      return
    }

    const updatePromises: Promise<void>[] = []

    for (const userSession of this.userSessions.values()) {
      updatePromises.push(this.updateUserMessage(client, userSession.userId))
    }

    await Promise.all(updatePromises)
  }

  /**
   * Update message context after interaction reply
   * Handles both ephemeral and non-ephemeral messages
   */
  public async updateMessageContext(
    userId: string,
    response: InteractionResponse,
    interaction: Interaction
  ) {
    const session = this.userSessions.get(userId)
    if (!session) {
      return
    }

    try {
      if (session.ephemeral) {
        session.messageId = "@original"
        session.channelId = interaction.channelId!

        // Store interaction token and ID for editing later
        session.interactionToken = interaction.token
        session.interactionId = interaction.id

        // Interaction tokens expire after 15 minutes
        session.tokenExpiresAt = Date.now() + 15 * 60 * 1000

        Logger.debug(`Updated ephemeral message context for user ${userId}`)
      } else {
        // For non-ephemeral messages, fetch to get the message ID
        const message = await response.fetch()
        session.messageId = message.id
        session.channelId = message.channelId

        Logger.debug(
          `Updated message context for user ${userId}: ${message.id}`
        )
      }
    } catch (error) {
      Logger.error(
        `Failed to update message context for user ${userId}: ${error}`
      )
    }
  }

  /**
   * Update a specific user's message
   * Handles both ephemeral and non-ephemeral messages
   */
  public async updateUserMessage(
    client: Client,
    userId: string
  ): Promise<void> {
    const userSession = this.userSessions.get(userId)

    if (!userSession || !userSession.messageId) {
      Logger.debug(`No message to update for user ${userId}`)
      return
    }

    try {
      // Render the page for this specific user
      const page = await this.renderForUser(userId)

      const updatePayload = {
        components: [page]
      }

      if (userSession.ephemeral) {
        await this.updateEphemeralMessage(
          client,
          userId,
          userSession,
          updatePayload
        )
      } else {
        await this.updateNonEphemeralMessage(
          client,
          userId,
          userSession,
          updatePayload
        )
      }
    } catch (error) {
      Logger.error(`Failed to update message for user ${userId}: ${error}`)
    }
  }

  /**
   * Update an ephemeral message via webhook
   */
  private async updateEphemeralMessage(
    client: Client,
    userId: string,
    userSession: UserSession,
    payload: any
  ): Promise<void> {
    // Validate token exists
    if (!userSession.interactionToken || !userSession.tokenExpiresAt) {
      Logger.warn(
        `No interaction token for ephemeral message (user: ${userId})`
      )
      return
    }

    // Check token expiry
    if (Date.now() > userSession.tokenExpiresAt) {
      Logger.warn(`Interaction token expired for user ${userId}`)
      this.userSessions.delete(userId)
      return
    }

    try {
      const webhook = new WebhookClient({
        id: client.user!.id,
        token: userSession.interactionToken
      })

      await webhook.editMessage(userSession.messageId, payload)
      Logger.debug(`Updated ephemeral message for user ${userId}`)
    } catch (error) {
      // Handle webhook-specific errors
      if (error instanceof Error) {
        if (
          error.message.includes("Unknown Webhook") ||
          error.message.includes("Invalid Webhook Token") ||
          error.message.includes("Unknown Message")
        ) {
          Logger.warn(
            `Ephemeral message no longer accessible for user ${userId}: ${error}`
          )
          this.userSessions.delete(userId)
        } else {
          // Re-throw other errors
          throw error
        }
      }
    }
  }

  /**
   * Update a non-ephemeral message via channel
   */
  private async updateNonEphemeralMessage(
    client: Client,
    userId: string,
    userSession: UserSession,
    payload: any
  ): Promise<void> {
    const channel = await client.channels.fetch(userSession.channelId)

    if (!channel?.isTextBased()) {
      Logger.warn(`Channel ${userSession.channelId} is not text-based`)
      return
    }

    try {
      const message = await (channel as TextChannel).messages.fetch(
        userSession.messageId
      )
      await message.edit(payload)
      Logger.debug(`Updated non-ephemeral message for user ${userId}`)
    } catch (error) {
      if (error instanceof Error && error.message.includes("Unknown Message")) {
        Logger.warn(
          `Message ${userSession.messageId} no longer exists for user ${userId}`
        )
        this.userSessions.delete(userId)
      } else {
        // Re-throw other errors
        throw error
      }
    }
  }

  public async initialize(): Promise<void> {
    if (this.isInitialized) {
      return
    }

    // Initialize session data
    if (this.definition.onSessionStart) {
      const sessionData = await this.definition.onSessionStart(this.params)
      this.setSessionData(sessionData)
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

  protected async renderFooter(): Promise<APIComponentInContainer[] | null> {
    if (this.definition.renderFooter) {
      const ctx = this.createSessionContext()
      const title = await this.definition.renderFooter(ctx)

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

    // It's a user action, check for an item index (we always append to last part)
    if (action.includes("|")) {
      const [actionName, ...rest] = action.split("|")
      const itemIndex = parseInt(rest[rest.length - 1], 10)

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

  public async destroy(): Promise<void> {
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
  public abstract renderForUser(userId: string): Promise<ContainerBuilder>
  public abstract handleInteraction(
    interaction: ButtonInteraction | AnySelectMenuInteraction,
    action: string
  ): Promise<ContainerBuilder | null>
}
