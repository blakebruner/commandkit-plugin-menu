import { merge } from "lodash"
import { PLUGIN_DEFAULTS } from "./constants"
import { MenuPlugin } from "./plugin"
import type { MenuPluginUserOptions } from "./types"

export * from "./manager"
export * from "./menus/pagination"
export * from "./plugin"
export * from "./types"

export function menu(options?: MenuPluginUserOptions) {
  const mergedOptions = merge({}, PLUGIN_DEFAULTS, options)
  return new MenuPlugin(mergedOptions)
}
