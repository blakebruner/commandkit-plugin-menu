import {
  type APIComponentInContainer,
  type ButtonInteraction,
  type ContainerBuilder,
  type ContainerComponentBuilder,
  type RGBTuple,
  resolveColor,
  type StringSelectMenuInteraction
} from "discord.js"
import { getPluginConfig } from "../plugin"
import type {
  ActionHandler,
  BaseMenuDefinition,
  ContainerComponentOrFragment,
  MenuData,
  MenuParams,
  MenuSession,
  SessionContext
} from "../types"

export abstract class BaseMenu<Data extends MenuData> {
  protected definition: BaseMenuDefinition<Data>
  protected sessionId: string
  protected params: MenuParams<Data>
  protected sessionData!: MenuSession<Data>
  protected isInitialized = false
  protected colorResolved?: RGBTuple | number

  // Viewer tracking
  protected viewers = new Set<string>() // User IDs who can view/interact
  protected creatorId: string // User who created the session

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
    this.viewers.add(creatorId)

    if (definition.actions) {
      // Register actions from definition
      for (const [actionName, handler] of Object.entries(definition.actions)) {
        this.actions.set(actionName, handler)
      }
    }
  }

  /**
   * Add a viewer to this session
   */
  public addViewer(userId: string): void {
    this.viewers.add(userId)
  }

  /**
   * Remove a viewer from this session
   */
  public removeViewer(userId: string): void {
    // Don't remove creator
    if (userId !== this.creatorId) {
      this.viewers.delete(userId)
    }
  }

  /**
   * Check if a user is a viewer
   */
  public isViewer(userId: string): boolean {
    return this.viewers.has(userId)
  }

  /**
   * Check if a user can interact with this session
   */
  public canInteract(userId: string): boolean {
    const mode = this.definition.sessionOptions?.mode ?? "shared"

    switch (mode) {
      case "shared":
        // Anyone who is a viewer can interact
        return this.isViewer(userId)

      case "private":
        // Only creator can interact
        return userId === this.creatorId

      case "locked":
        // Only creator can interact, but others can view
        return userId === this.creatorId

      default:
        return false
    }
  }

  /**
   * Get all viewer IDs
   */
  public getViewers(): string[] {
    return Array.from(this.viewers)
  }

  /**
   * Get viewer count
   */
  public getViewerCount(): number {
    return this.viewers.size
  }

  /**
   * Get creator ID
   */
  public getCreatorId(): string {
    return this.creatorId
  }

  /**
   * Get session mode
   */
  public getMode(): "shared" | "private" | "locked" {
    return this.definition.sessionOptions?.mode ?? "shared"
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

  protected createActionId(action: string): string {
    const pluginConfig = getPluginConfig()
    return `${pluginConfig.actionPrefix}:${action}:${this.sessionId}`
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
  public abstract handleInteraction(
    interaction: ButtonInteraction | StringSelectMenuInteraction,
    data: any
  ): Promise<ContainerBuilder | null>
}
