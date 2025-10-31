import { Logger } from "commandkit"
import type { IMenuRegistry, MenuData, MenuDefinition } from "./types"

/**
 * Menu registry implementation
 * Stores and manages menu definitions
 */
export class MenuRegistry implements IMenuRegistry {
  /** Registered menu definitions */
  private menus = new Map<string, MenuDefinition<any>>()

  public register<Data extends MenuData>(menu: MenuDefinition<Data>): void {
    if (this.menus.has(menu.name)) {
      Logger.warn(`Duplicate menu: ${menu.name}`)
      return
    }

    this.menus.set(menu.name, menu)
    Logger.info(`Registered menu: ${menu.name}`)
  }

  public get(name: string): MenuDefinition<any> {
    const menu = this.menus.get(name)
    if (!menu) {
      throw new Error(`Menu "${name}" not found. Did you register it?`)
    }

    return menu
  }

  public has(name: string): boolean {
    return this.menus.has(name)
  }

  public getAll(): Map<string, MenuDefinition<any>> {
    return new Map(this.menus)
  }

  public getAllNames(): string[] {
    return Array.from(this.menus.keys())
  }

  public clear(): void {
    this.menus.clear()
    Logger.debug("Cleared all menu definitions")
  }
}

export const menuRegistry = new MenuRegistry()
