import { merge } from "lodash"
import { PLUGIN_DEFAULTS } from "./constants"
import { PaginationPlugin } from "./plugin"
import type { PaginationPluginUserOptions } from "./types"

export * from "./manager"
export * from "./menus/pagination"
export * from "./plugin"
export * from "./types"

export function pagination(options?: PaginationPluginUserOptions) {
  const mergedOptions = merge({}, PLUGIN_DEFAULTS, options)
  return new PaginationPlugin(mergedOptions)
}

