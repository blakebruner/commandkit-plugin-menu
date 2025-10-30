import type {
  ButtonInteraction,
  ContainerBuilder,
  StringSelectMenuInteraction
} from "discord.js"
import type { MenuData, SinglePageMenuDefinition } from "../types"
import { BaseMenu } from "./base"

export class SinglePageMenu<Data extends MenuData> extends BaseMenu<Data> {
  public render(): Promise<ContainerBuilder> {
    throw new Error("Method not implemented.")
  }

  renderForUser(userId: string): Promise<ContainerBuilder> {
    throw new Error("Method not implemented.")
  }

  public handleInteraction(
    interaction: ButtonInteraction | StringSelectMenuInteraction,
    action: string
  ): Promise<ContainerBuilder | null> {
    throw new Error("Method not implemented.")
  }
  // ... implementation
}

/**
 * Helper to create a single page menu definition
 * Automatically sets type to "single"
 */
export function singlePageMenu<Data extends MenuData>(
  definition: Omit<SinglePageMenuDefinition<Data>, "type">
): SinglePageMenuDefinition<Data> {
  return {
    ...definition,
    type: "single"
  }
}
