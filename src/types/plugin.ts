import type { ButtonStyle } from "discord.js"
import type { PartialDeep } from "./utils"

export type ButtonWithCustomId =
  | ButtonStyle.Danger
  | ButtonStyle.Primary
  | ButtonStyle.Secondary
  | ButtonStyle.Success

export interface PageNavigationButtonOptions {
  label?: string
  style: ButtonWithCustomId
  emoji?: string
}

export interface PageNavigation {
  first: PageNavigationButtonOptions
  previous: PageNavigationButtonOptions
  next: PageNavigationButtonOptions
  last: PageNavigationButtonOptions
}

export type PageNavigationType = keyof PageNavigation

export interface MenuPluginOptions {
  actionPrefix: string
  preloadAll: boolean
  navigation: PageNavigation
}

/** What callers can pass: everything optional, deep */
export type MenuPluginUserOptions = PartialDeep<MenuPluginOptions>
