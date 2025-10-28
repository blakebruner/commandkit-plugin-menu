import { Logger } from "commandkit"
import {
  ActionRowBuilder,
  type APIComponentInContainer,
  ButtonBuilder,
  type ButtonInteraction,
  ContainerBuilder,
  type ContainerComponentBuilder,
  StringSelectMenuBuilder,
  type StringSelectMenuInteraction,
  StringSelectMenuOptionBuilder
} from "discord.js"
import { MAX_SELECT_OPTIONS } from "../constants"
import { getPluginConfig } from "../plugin"
import type {
  MenuData,
  MenuItem,
  MenuParams,
  PageNavigationType,
  PaginationMenuDefinition,
  PaginationPluginOptions
} from "../types"
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

  private currentPage = 0

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
    const comps: ContainerComponentBuilder[] = []

    // Add title if defined
    const title = await this.renderTitle()
    if (title) {
      comps.push(title)
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
      comps.push(itemComponent)
    }

    // Add navigation controls
    const navigation = this.renderNavigationControls(pageNumber)
    if (navigation) {
      comps.push(...navigation)
    }

    // @ts-expect-error APIComponentInContainer
    const components: APIComponentInContainer[] = comps.map(c => c.toJSON())

    const builder = new ContainerBuilder({
      components
    })

    if (this.colorResolved) {
      builder.setAccentColor(this.colorResolved)
    }

    return builder
  }

  private renderNavigationControls(
    pageNumber: number
  ): ContainerComponentBuilder[] | null {
    if (this.pageCount <= 1) {
      return null
    }

    const canPrev = pageNumber > 0
    const canNext = pageNumber < this.pageCount - 1

    const config = getPluginConfig()

    const row1 = new ActionRowBuilder().addComponents(
      this.buildNavigationButton(config, "first", !canPrev),
      this.buildNavigationButton(config, "previous", !canPrev),
      this.buildNavigationButton(config, "next", !canNext),
      this.buildNavigationButton(config, "last", !canNext)
    )

    const row2 = new ActionRowBuilder().addComponents(
      this.buildNavigationSelectMenu(pageNumber)
    )

    return [row1, row2]
  }

  private buildNavigationButton(
    config: PaginationPluginOptions,
    action: PageNavigationType,
    disabled: boolean
  ): ButtonBuilder {
    const buttonOptions = config.navigation[action]
    const buttonId = this.createActionId(action)
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
    const selectId = this.createActionId("goto")
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

    // Fetch all items
    this.items = await this.definition.fetch(this.params)

    // Calculate page count
    this.calculatePageCount()

    // Clear old cache
    this.clearPageCache()

    // Preload all pages if requested
    if (this.renderOptions.preloadAll) {
      await this.preloadAllPages()
    }

    // Return the current page
    return this.getPage(this.currentPage)
  }

  /**
   * Navigate to a specific page
   */
  async goToPage(pageNumber: number): Promise<ContainerBuilder> {
    if (pageNumber < 0 || pageNumber >= this.pageCount) {
      throw new Error(`Invalid page number: ${pageNumber}`)
    }

    this.currentPage = pageNumber
    return this.getPage(this.currentPage)
  }

  /**
   * Navigate to next page
   */
  async nextPage(): Promise<ContainerBuilder | null> {
    if (!this.hasNextPage()) {
      return null
    }

    this.currentPage++
    return this.getPage(this.currentPage)
  }

  /**
   * Navigate to previous page
   */
  async previousPage(): Promise<ContainerBuilder | null> {
    if (!this.hasPreviousPage()) {
      return null
    }

    this.currentPage--
    return this.getPage(this.currentPage)
  }

  /**
   * Navigate to first page
   */
  async firstPage(): Promise<ContainerBuilder> {
    this.currentPage = 0
    return this.getPage(this.currentPage)
  }

  /**
   * Navigate to last page
   */
  async lastPage(): Promise<ContainerBuilder> {
    this.currentPage = this.pageCount - 1
    return this.getPage(this.currentPage)
  }

  /**
   * Refetch data and rebuild pages
   */
  async refetch(): Promise<ContainerBuilder> {
    // Fetch fresh data
    this.items = await this.definition.fetch(this.params)

    // Recalculate page count
    this.calculatePageCount()

    // Clear cache to force rebuild
    this.clearPageCache()

    // Ensure current page is valid
    if (this.currentPage >= this.pageCount) {
      this.currentPage = Math.max(0, this.pageCount - 1)
    }

    // Preload all pages if requested
    if (this.renderOptions.preloadAll) {
      await this.preloadAllPages()
    }

    // Return current page
    return this.getPage(this.currentPage)
  }

  /**
   * Handle button interactions
   */
  async handleInteraction(
    interaction: ButtonInteraction | StringSelectMenuInteraction,
    data?: any
  ): Promise<ContainerBuilder | null> {
    if (!this.canInteract(interaction.user.id)) {
      Logger.warn(
        `User ${interaction.user.id} attempted to interact with session ${this.sessionId} without permission.`
      )
      return null // User cannot interact with this session
    }

    const config = getPluginConfig()

    // Parse interaction ID
    const parts = interaction.customId.split(":")
    if (parts[0] !== config.actionPrefix) {
      return null
    }

    const action = parts[1]

    switch (action) {
      case "first":
        return this.firstPage()

      case "previous":
        return this.previousPage()

      case "next":
        return this.nextPage()

      case "last":
        return this.lastPage()

      case "indicator":
        // Page indicator is disabled, no action
        return null

      case "goto":
        if (data && typeof data === "string") {
          const pageIndex = parseInt(data)
          if (!isNaN(pageIndex)) {
            return this.goToPage(pageIndex)
          }
        }
        return null

      default:
        return null
    }
  }

  /**
   * Get current page number (0-indexed)
   */
  getCurrentPage(): number {
    return this.currentPage
  }

  /**
   * Get total number of pages
   */
  getPageCount(): number {
    return this.pageCount
  }

  /**
   * Check if there's a next page
   */
  hasNextPage(): boolean {
    return this.currentPage < this.pageCount - 1
  }

  /**
   * Check if there's a previous page
   */
  hasPreviousPage(): boolean {
    return this.currentPage > 0
  }

  /**
   * Get all items
   */
  getItems(): MenuItem<Data>[] {
    return this.items
  }

  /**
   * Get items for current page
   */
  getCurrentPageItems(): MenuItem<Data>[] {
    const startIdx = this.currentPage * this.definition.perPage
    const endIdx = Math.min(
      startIdx + this.definition.perPage,
      this.items.length
    )
    return this.items.slice(startIdx, endIdx)
  }
}

export function paginationMenu<Data extends MenuData>(
  definition: PaginationMenuDefinition<Data>
): PaginationMenuDefinition<Data> {
  return definition
}
