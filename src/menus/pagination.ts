import { Logger } from "commandkit"
import {
  ActionRowBuilder,
  type APIComponentInContainer,
  ButtonBuilder,
  type ButtonInteraction,
  type Client,
  ContainerBuilder,
  StringSelectMenuBuilder,
  type StringSelectMenuInteraction,
  StringSelectMenuOptionBuilder
} from "discord.js"
import { INTERNAL_ACTION_PREFIX, MAX_SELECT_OPTIONS } from "../constants"
import { getPluginConfig } from "../plugin"
import type {
  MenuData,
  MenuItem,
  MenuParams,
  MenuPluginOptions,
  PageNavigationType,
  PaginationMenuDefinition
} from "../types"
import { transformComponentCustomId } from "../utils"
import { BaseMenu } from "./base"

export interface PaginationRenderOptions {
  /**
   * Whether to preload all pages on first render
   * @default false (lazy load)
   */
  preloadAll?: boolean
}

export class PaginationMenu<Data extends MenuData> extends BaseMenu<Data> {
  protected override definition: PaginationMenuDefinition<Data>

  private items: MenuItem<Data>[] = []

  private pageCount = 0

  // Cache of fully-built pages (ContainerBuilders)
  private pageCache = new Map<number, ContainerBuilder>()

  // Render options
  private renderOptions: PaginationRenderOptions

  constructor(
    definition: PaginationMenuDefinition<Data>,
    sessionId: string,
    params: MenuParams<Data>,
    creatorId: string,
    options?: PaginationRenderOptions
  ) {
    super(definition, sessionId, params, creatorId)
    this.definition = definition
    this.renderOptions = options ?? {}
  }

  /**
   * Get a page for a specific user
   */
  private async getPageForUser(userId: string): Promise<ContainerBuilder> {
    const pageNumber = this.getUserPage(userId)
    return this.getPage(pageNumber)
  }

  /**
   * Render for a specific user (uses their page position)
   */
  async renderForUser(userId: string): Promise<ContainerBuilder> {
    return this.getPageForUser(userId)
  }

  private createNavigationActionId(action: string): string {
    const config = getPluginConfig()
    return `${config.actionPrefix}:${this.sessionId}:${INTERNAL_ACTION_PREFIX}${action}`
  }

  /**
   * Clear the page cache
   */
  private clearPageCache(): void {
    this.pageCache.clear()
  }

  /**
   * Calculate page count based on items
   */
  private calculatePageCount(): void {
    this.pageCount = Math.max(
      1,
      Math.ceil(this.items.length / Math.max(1, this.definition.perPage))
    )
  }

  /**
   * Build a specific page without caching
   */
  private async buildPage(pageNumber: number): Promise<ContainerBuilder> {
    const comps: APIComponentInContainer[] = []

    // Add title if defined
    const title = await this.renderTitle()
    if (title) {
      comps.push(...title)
    }

    // Render page items
    const startIdx = pageNumber * this.definition.perPage
    const endIdx = Math.min(
      startIdx + this.definition.perPage,
      this.items.length
    )
    const pageItems = this.items.slice(startIdx, endIdx)

    const ctx = this.createSessionContext()

    for (let i = 0; i < pageItems.length; i++) {
      const item = pageItems[i]
      const globalIndex = startIdx + i
      const itemComponent = await this.definition.renderItem(
        item,
        globalIndex,
        pageNumber,
        ctx
      )
      const itemComponentHandled = this.handleComponentOrFragment(itemComponent)

      const transformedComponents = itemComponentHandled.map(comp => {
        // Transform with the item's global index
        const config = getPluginConfig()
        return transformComponentCustomId(
          comp,
          config.actionPrefix,
          this.sessionId,
          new Set(this.actions.keys()),
          globalIndex
        )
      })
      comps.push(...transformedComponents)
    }

    // Add navigation controls
    const navigation = this.renderNavigationControls(pageNumber)
    if (navigation) {
      comps.push(...navigation)
    }

    const builder = new ContainerBuilder({
      components: comps
    })

    if (this.colorResolved) {
      builder.setAccentColor(this.colorResolved)
    }

    return builder
  }

  private renderNavigationControls(pageNumber: number) {
    if (this.pageCount <= 1) {
      return null
    }

    const canPrev = pageNumber > 0
    const canNext = pageNumber < this.pageCount - 1

    const config = getPluginConfig()

    const buttonNavigation = new ActionRowBuilder()
      .addComponents(
        this.buildNavigationButton(config, "first", !canPrev),
        this.buildNavigationButton(config, "previous", !canPrev),
        this.buildNavigationButton(config, "next", !canNext),
        this.buildNavigationButton(config, "last", !canNext)
      )
      .toJSON()

    const selectMenuNavigation = new ActionRowBuilder()
      .addComponents(this.buildNavigationSelectMenu(pageNumber))
      .toJSON()

    return [buttonNavigation, selectMenuNavigation] as APIComponentInContainer[]
  }

  private buildNavigationButton(
    config: MenuPluginOptions,
    action: PageNavigationType,
    disabled: boolean
  ): ButtonBuilder {
    const buttonOptions = config.navigation[action]
    const buttonId = this.createNavigationActionId(action)
    const button = new ButtonBuilder()
      .setCustomId(buttonId)
      .setStyle(buttonOptions.style)
      .setDisabled(disabled)

    if (buttonOptions.emoji) {
      button.setEmoji(buttonOptions.emoji)
    }
    if (buttonOptions.label) {
      button.setLabel(buttonOptions.label)
    }

    return button
  }

  // select options (window around current page)
  private buildNavigationSelectMenu(
    pageNumber: number
  ): StringSelectMenuBuilder {
    let start = Math.max(0, pageNumber - Math.floor(MAX_SELECT_OPTIONS / 2))
    const end = Math.min(this.pageCount, start + MAX_SELECT_OPTIONS)
    if (end - start < MAX_SELECT_OPTIONS) {
      start = Math.max(0, end - MAX_SELECT_OPTIONS)
    }

    // TODO: make this configurable?
    const selectId = this.createNavigationActionId("goto")
    const select = new StringSelectMenuBuilder()
      .setCustomId(selectId)
      .setPlaceholder(`🔄 Jump to page (${pageNumber + 1} / ${this.pageCount})`)

    for (let i = start; i < end; i++) {
      const selectOption = new StringSelectMenuOptionBuilder()
        .setLabel(`Page ${i + 1}`)
        .setValue(`${i}`)

      select.addOptions(selectOption)
    }

    return select
  }

  /**
   * Get a page, using cache if available, otherwise build it
   */
  private async getPage(pageNumber: number): Promise<ContainerBuilder> {
    if (this.pageCache.has(pageNumber)) {
      return this.pageCache.get(pageNumber)!
    }

    const page = await this.buildPage(pageNumber)

    this.pageCache.set(pageNumber, page)

    return page
  }

  /**
   * Preload all pages into cache
   */
  private async preloadAllPages(): Promise<void> {
    const promises: Promise<void>[] = []

    for (let i = 0; i < this.pageCount; i++) {
      promises.push(
        this.buildPage(i).then(page => {
          this.pageCache.set(i, page)
        })
      )
    }

    await Promise.all(promises)
  }

  /**
   * Initial render - fetches data and renders first page
   */
  async render(): Promise<ContainerBuilder> {
    await this.initialize()

    this.items = await this.definition.fetch(this.params)
    this.calculatePageCount()
    this.clearPageCache()

    if (this.renderOptions.preloadAll) {
      await this.preloadAllPages()
    }

    // Return page 0 for initial render
    return this.getPage(0)
  }

  /**
   * Navigate to a specific page for a user
   */
  async goToPage(
    userId: string,
    pageNumber: number
  ): Promise<ContainerBuilder> {
    if (pageNumber < 0 || pageNumber >= this.pageCount) {
      throw new Error(`Invalid page number: ${pageNumber}`)
    }

    this.setUserPage(userId, pageNumber)
    return this.getPage(pageNumber)
  }

  /**
   * Navigate to next page for a user
   */
  async nextPage(userId: string): Promise<ContainerBuilder | null> {
    const currentPage = this.getUserPage(userId)

    if (currentPage >= this.pageCount - 1) {
      return null
    }

    this.setUserPage(userId, currentPage + 1)
    return this.getPage(currentPage + 1)
  }

  /**
   * Navigate to previous page for a user
   */
  async previousPage(userId: string): Promise<ContainerBuilder | null> {
    const currentPage = this.getUserPage(userId)

    if (currentPage <= 0) {
      return null
    }

    this.setUserPage(userId, currentPage - 1)
    return this.getPage(currentPage - 1)
  }

  /**
   * Navigate to first page for a user
   */
  async firstPage(userId: string): Promise<ContainerBuilder> {
    this.setUserPage(userId, 0)
    return this.getPage(0)
  }

  /**
   * Navigate to last page for a user
   */
  async lastPage(userId: string): Promise<ContainerBuilder> {
    const lastPage = this.pageCount - 1
    this.setUserPage(userId, lastPage)
    return this.getPage(lastPage)
  }

  /**
   * Refetch data and update all users
   */
  async refetch(items?: boolean): Promise<void> {
    // Refetch items if requested
    if (items) {
      this.items = await this.definition.fetch(this.params)
      this.calculatePageCount()
      this.clearPageCache()
    }

    // Ensure all users' pages are valid
    for (const userSession of this.getAllUserSessions()) {
      if (userSession.currentPage >= this.pageCount) {
        this.setUserPage(userSession.userId, Math.max(0, this.pageCount - 1))
      }
    }

    if (this.renderOptions.preloadAll) {
      await this.preloadAllPages()
    }

    // Broadcast update to all users if client is provided
    await this.broadcastUpdate()
  }

  /**
   * Handle button interactions
   */
  async handleInteraction(
    interaction: ButtonInteraction | StringSelectMenuInteraction,
    actionRaw: string
  ): Promise<ContainerBuilder | null> {
    const userId = interaction.user.id

    if (!this.canInteract(userId)) {
      Logger.warn(
        `User ${userId} attempted to interact with session ${this.sessionId} without permission.`
      )
      return null // User cannot interact with this session
    }

    const parsed = this.parseActionId(actionRaw)
    if (!parsed) {
      Logger.warn(`Failed to parse action ID: ${actionRaw}`)
      return null
    }

    if (parsed.type === "navigation") {
      switch (parsed.action) {
        case "first":
          return this.firstPage(userId)

        case "previous":
          return this.previousPage(userId)

        case "next":
          return this.nextPage(userId)

        case "last":
          return this.lastPage(userId)

        case "goto":
          // Get page from select menu value
          if (interaction.isStringSelectMenu()) {
            const pageIndex = parseInt(interaction.values[0], 10)
            if (!isNaN(pageIndex)) {
              return this.goToPage(userId, pageIndex)
            }
          }
          return null

        case "indicator":
          // Page indicator is disabled, no action
          return null

        default:
          Logger.warn(`Unknown navigation action: ${parsed.action}`)
          return null
      }
    }

    // User-defined action
    const actionHandler = this.actions.get(parsed.action)
    if (!actionHandler) {
      Logger.warn(
        `Unknown action: ${parsed.action} for ${this.definition.name}`
      )
      return null
    }

    if (parsed.itemIndex === undefined) {
      Logger.warn(`No item index provided for action: ${parsed.action}`)
      return null
    }

    await actionHandler({
      interaction,
      params: this.params,
      sessionData: this.sessionData,
      sessionId: this.sessionId,
      item: this.items[parsed.itemIndex],
      userId: interaction.user.id
    })

    return this.getPageForUser(userId)
  }

  /**
   * Get items for a specific user's current page
   */
  getCurrentPageItemsForUser(userId: string): MenuItem<Data>[] {
    const currentPage = this.getUserPage(userId)
    const startIdx = currentPage * this.definition.perPage
    const endIdx = Math.min(
      startIdx + this.definition.perPage,
      this.items.length
    )
    return this.items.slice(startIdx, endIdx)
  }

  /**
   * Get total number of pages
   */
  getPageCount(): number {
    return this.pageCount
  }
}

/**
 * Helper to create a pagination menu definition
 * Automatically sets type to 'pagination'
 */
export function paginationMenu<Data extends MenuData>(
  definition: Omit<PaginationMenuDefinition<Data>, "type">
): PaginationMenuDefinition<Data> {
  return {
    ...definition,
    type: "pagination"
  }
}
