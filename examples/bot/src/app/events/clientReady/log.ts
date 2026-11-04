import type { Client } from "discord.js"

export default function onReady(client: Client<true>) {
  console.log(`Logged in as ${client.user.tag}`)
}
