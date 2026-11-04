import { Client, GatewayIntentBits } from "discord.js"

const client = new Client({
  // GuildMessages lets the plugin forget panels whose message gets deleted.
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages]
})

export default client
