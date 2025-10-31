import type { MenuData, MenuDefinition } from "./menu"

/**
 * Menu registry interface
 * Simple storage for menu definitions
 */
export interface IMenuRegistry {
  /**
   * Register a menu definition
   */
  register<Data extends MenuData>(definition: MenuDefinition<Data>): void

  /**
   * Get a menu by name
   */
  get(name: string): MenuDefinition<any>

  /**
   * Check if a menu exists
   */
  has(name: string): boolean

  /**
   * Get all registered definitions
   */
  getAll(): Map<string, MenuDefinition<any>>

  /**
   * Get all registered menu names
   */
  getAllNames(): string[]

  /**
   * Clear all definitions (useful for testing)
   */
  clear(): void
}
