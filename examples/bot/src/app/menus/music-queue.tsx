import { Button, Section, Separator, TextDisplay } from "commandkit"
import { definePaginatedMenu } from "commandkit-plugin-menu"
import { ButtonStyle } from "discord.js"
import { getQueue } from "../../lib/store"

/**
 * A paginated music queue. Each viewer pages independently, and anything that changes the queue
 * calls `musicQueue.invalidate({ guildId })` so every open queue re-renders.
 *
 * With lavalink-client you'd call that from the player events, for example:
 *   manager.on("trackStart", player => musicQueue.invalidate({ guildId: player.guildId }))
 *   manager.on("queueEnd",   player => musicQueue.invalidate({ guildId: player.guildId }))
 */
const musicQueue = definePaginatedMenu({
  name: "music-queue",
  key: (params: { guildId: string }) => params.guildId,
  load: params => getQueue(params.guildId),
  items: queue => queue.upcoming,
  perPage: 5,
  color: "#5865F2",
  ephemeral: true,
  // Catch queue changes that happened while the bot was restarting.
  resyncOnStart: true,

  renderHeader: ({ data, total }) => (
    <>
      <TextDisplay content="## 🎵 Queue" />
      <TextDisplay
        content={
          data.current
            ? `Now playing: **${data.current.title}** (requested by <@${data.current.requestedBy}>)`
            : "Nothing is playing."
        }
      />
      <TextDisplay content={`-# ${total} track(s) up next`} />
      <Separator />
    </>
  ),

  renderItem: (track, index, { id }) => (
    <Section>
      <TextDisplay
        content={`**${index + 1}.** ${track.title}\n-# requested by <@${track.requestedBy}>`}
      />
      <Button customId={id("remove", track.id)} style={ButtonStyle.Secondary} emoji="🗑️">
        Remove
      </Button>
    </Section>
  ),

  renderEmpty: () => <TextDisplay content="The queue is empty. Add songs with `/play`." />,

  actions: {
    remove: ctx => {
      const queue = getQueue(ctx.params.guildId)
      queue.upcoming = queue.upcoming.filter(track => track.id !== ctx.arg)
      ctx.invalidate()
    }
  }
})

export default musicQueue
