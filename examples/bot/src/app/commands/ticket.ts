import type { ChatInputCommand, CommandData } from "commandkit"
import { ChannelType, MessageFlags } from "discord.js"
import { tickets } from "../../lib/store"
import ticketPanel from "../menus/ticket-panel"

export const command: CommandData = {
  name: "ticket",
  description: "Open a support ticket in a new channel"
}

let ticketNumber = 0

export const chatInput: ChatInputCommand = async ({ interaction }) => {
  if (!interaction.inCachedGuild()) return
  await interaction.deferReply({ flags: MessageFlags.Ephemeral })

  const id = String(++ticketNumber)
  const channel = await interaction.guild.channels.create({
    name: `ticket-${id}`,
    type: ChannelType.GuildText
  })
  tickets.set(id, {
    id,
    channelId: channel.id,
    openedBy: interaction.user.id,
    status: "open",
    claimedBy: null,
    notes: []
  })

  // Post the live panel into the ticket channel.
  await ticketPanel.send(channel, { ticketId: id })
  await interaction.editReply(`Your ticket is open in ${channel}.`)
}
