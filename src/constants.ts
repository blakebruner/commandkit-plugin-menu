import { ButtonStyle } from "discord.js"
import type { MenuPluginOptions } from "./types"

// Maximum options allowed in a select menu
export const MAX_SELECT_OPTIONS = 25

// Reserved action names that users cannot override
export const RESERVED_ACTIONS = new Set([
  "first",
  "previous",
  "next",
  "last",
  "goto",
  "indicator"
])

// Internal prefix for built-in navigation actions
export const INTERNAL_ACTION_PREFIX = "__nav__"

export const PLUGIN_DEFAULTS: MenuPluginOptions = {
  actionPrefix: "page",
  preloadAll: false,
  navigation: {
    first: {
      emoji: "⏪",
      style: ButtonStyle.Primary
    },
    previous: {
      emoji: "◀️",
      style: ButtonStyle.Primary
    },
    next: {
      emoji: "▶️",
      style: ButtonStyle.Primary
    },
    last: {
      emoji: "⏩",
      style: ButtonStyle.Primary
    }
  }
} as const
