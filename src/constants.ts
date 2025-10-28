import { ButtonStyle } from "discord.js"
import type { PaginationPluginOptions } from "./types"

export const MAX_SELECT_OPTIONS = 25

export const PLUGIN_DEFAULTS: PaginationPluginOptions = {
  actionPrefix: "page",
  preloadAll: false,
  navigation: {
    first: {
      emoji: "⏪",
      style: ButtonStyle.Primary,
    },
    previous: {
      emoji: "◀️",
      style: ButtonStyle.Primary,
    },
    next: {
      emoji: "▶️",
      style: ButtonStyle.Primary,
    },
    last: {
      emoji: "⏩",
      style: ButtonStyle.Primary,
    },
  },
} as const
