import type { ChatInputCommand, CommandData } from "commandkit"
import { ApplicationCommandOptionType, MessageFlags } from "discord.js"
import { getQueue, nextTrackId } from "../../lib/store"
import musicQueue from "../menus/music-queue"

export const command: CommandData = {
  name: "play",
  description: "Add a (pretend) song to the queue",
  options: [
    {
      name: "song",
      description: "Song title",
      type: ApplicationCommandOptionType.String,
      required: true
    }
  ]
}

export const chatInput: ChatInputCommand = async ({ interaction }) => {
  if (!interaction.guildId) return
  const queue = getQueue(interaction.guildId)
  const track = {
    id: nextTrackId(),
    title: interaction.options.getString("song", true),
    requestedBy: interaction.user.id
  }
  if (queue.current) queue.upcoming.push(track)
  else queue.current = track

  // Every open /queue view in this server updates.
  void musicQueue.invalidate({ guildId: interaction.guildId })
  await interaction.reply({ content: `Queued **${track.title}**`, flags: MessageFlags.Ephemeral })
}
