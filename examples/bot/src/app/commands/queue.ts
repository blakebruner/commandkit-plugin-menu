import type { ChatInputCommand, CommandData } from "commandkit"
import musicQueue from "../menus/music-queue"

export const command: CommandData = {
  name: "queue",
  description: "Show the music queue"
}

export const chatInput: ChatInputCommand = async ({ interaction }) => {
  if (!interaction.guildId) return
  // Ephemeral (the menu's default). Opening it again replaces your previous one.
  await musicQueue.reply(interaction, { guildId: interaction.guildId })
}
