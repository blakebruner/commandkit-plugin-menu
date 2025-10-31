import { Logger } from "commandkit"
import { menuManager } from "./manager"
import type {
  MenuCloseMessage,
  MenuData,
  MenuUpdateMessage,
  QueueDriver,
  QueueUpdateOptions
} from "./types"

export class MenuQueue {
  public queue: QueueDriver | null = null

  public setDriver(driver: QueueDriver): void {
    this.queue = driver
    this.setupReceivers()
  }

  private setupReceivers(): void {
    if (!this.queue) {
      throw new Error("Queue driver not set")
    }

    this.queue.subscribe<MenuUpdateMessage>("menu:update", async message => {
      await this.handleMenuUpdate(message)
    })

    this.queue.subscribe<MenuCloseMessage>("menu:close", async message => {
      await this.handleClose(message)
    })
  }

  /**
   * Handle menu update message with granular control
   */
  private async handleMenuUpdate(message: MenuUpdateMessage): Promise<void> {
    try {
      const { menuName, contextKey, refresh, updateSessionData } = message

      // Get menu definition
      const definition = menuManager.getMenu(menuName)

      // Get or restore session
      const menu = menuManager.getSession(contextKey)

      if (!menu) {
        Logger.warn(`Menu session not found: ${contextKey}`)
        return
      }

      // Update session data
      if (updateSessionData !== undefined) {
        const currentSessionData = menu.getSessionData()

        if (typeof updateSessionData === "function") {
          const newSessionData = await updateSessionData(currentSessionData)
          menu.setSessionData(newSessionData)
        } else {
          menu.setSessionData({
            ...currentSessionData,
            ...updateSessionData
          })
        }
      }

      if (refresh?.sessionData && definition.onSessionStart) {
        const params = menu.getParams()
        const newSessionData = await definition.onSessionStart(params)
        menu.setSessionData(newSessionData)
      }

      // Refetch items if requested
      if (refresh?.items !== false) {
        await (menu as any).refetch()
      }

      // refetch calls broadcastUpdate internally
      // await menu.broadcastUpdate()

    } catch (error) {
      Logger.error(`Error handling menu update: ${error}`)
    }
  }

  private async handleClose(message: MenuCloseMessage): Promise<void> {
    try {
      await menuManager.endSession(message.contextKey)
    } catch (error) {
      Logger.error(`Error handling menu close: ${error}`)
    }
  }

  /**
   * Queue a menu update with fine-grained control
   */
  public async sendUpdate<Data extends MenuData>(
    options: QueueUpdateOptions<Data>
  ): Promise<void> {
    if (!this.queue) {
      throw new Error("Queue driver not initialized")
    }

    const { menu: menuName, params, refresh, updateSessionData } = options

    // Get menu definition
    const definition = menuManager.getMenu(menuName)

    // Generate context key from params
    const contextKey = await definition.createKey(params)

    // Publish update message
    await this.queue.publish<MenuUpdateMessage>("menu:update", {
      menuName,
      contextKey,
      refresh: {
        items: refresh?.items ?? true, // Default: refetch items
        sessionData: refresh?.sessionData ?? false // Default: don't refetch session data
      },
      updateSessionData,
      timestamp: Date.now()
    })
  }
}

export const menuQueue = new MenuQueue()

export function setQueueDriver(driver: QueueDriver): void {
  menuQueue.setDriver(driver)
}
