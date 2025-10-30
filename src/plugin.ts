import { existsSync } from "node:fs"
import { readdir } from "node:fs/promises"
import path from "node:path"
import {
  type CommandKitEventDispatch,
  type CommandKitPluginRuntime,
  getCurrentDirectory,
  Logger,
  RuntimePlugin,
  toFileURL
} from "commandkit"
import { Events, type Interaction } from "discord.js"
import { PLUGIN_DEFAULTS } from "./constants"
import { menuManager } from "./manager"
import type { MenuPluginOptions } from "./types"

let pluginConfig: MenuPluginOptions = PLUGIN_DEFAULTS

export function getPluginConfig(): MenuPluginOptions {
  return pluginConfig
}

export class MenuPlugin extends RuntimePlugin<MenuPluginOptions> {
  public readonly name = "MenuPlugin"

  public constructor(options: MenuPluginOptions) {
    super(options)
    pluginConfig = options
  }

  public async activate(): Promise<void> {
    const pageDirectory = this.getPageDirectory()
    if (!existsSync(pageDirectory)) {
      return
    }

    const files = await readdir(pageDirectory, { withFileTypes: true })
    for (const f of files) {
      if (
        f.isDirectory() ||
        f.name.startsWith("_") ||
        !/\.(c|m)?(j|t)sx?$/.test(f.name)
      ) {
        continue
      }

      const pagePath = path.join(f.parentPath, f.name)
      const page = await import(toFileURL(pagePath, true))
        .then(m => m.default || m.page)
        .catch(e => {
          Logger.error(`Error loading menu file: ${e?.stack ?? e}`)
          return null
        })

      if (!page || !page.name) {
        Logger.error(`Invalid menu definition in file: ${f.name}`)
        continue
      }

      menuManager.register(page)
    }

    Logger.info(`${this.name} activated`)
  }

  public async willEmitEvent(
    ctx: CommandKitPluginRuntime,
    event: CommandKitEventDispatch
  ): Promise<void> {
    if (event.name !== Events.InteractionCreate) {
      return
    }

    // TODO: how to guard this better? another plugin can push args
    const interaction = event.args[0] as Interaction | undefined
    if (!interaction || !interaction.isMessageComponent()) {
      return
    }

    if (!interaction.isButton() && !interaction.isAnySelectMenu()) {
      return
    }

    const [prefix, sessionKey, action] = interaction.customId.split(":")
    if (prefix !== this.options.actionPrefix) {
      return
    }

    const session = menuManager.getSession<any>(sessionKey)
    if (!session) {
      Logger.warn(`Session not found: ${sessionKey}`)
      return
    }

    const menu = await session.handleInteraction(interaction, action)
    if (menu) {
      await interaction.update({
        components: [menu]
      })
    }

    event.accept()
  }

  private getPageDirectory(): string {
    return path.join(getCurrentDirectory(), "app", "menus")
  }
}
