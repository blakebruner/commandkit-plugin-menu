import { ActionRow, Button, Container, Separator, TextDisplay } from "commandkit"
import { defineMenu } from "commandkit-plugin-menu"
import { ButtonStyle } from "discord.js"
import { tickets } from "../../lib/store"
import ticketManage from "./ticket-manage"

/**
 * A public panel posted in every ticket channel. Everyone in the channel sees the same message, so
 * a change (claim, close, a note added from the private view) is pushed to it right away.
 */
export default defineMenu({
  name: "ticket-panel",
  key: (params: { ticketId: string }) => params.ticketId,
  load: params => tickets.get(params.ticketId) ?? null,
  // One panel per ticket channel: sending a new one deletes the old message.
  replace: "channel",
  updates: "live",

  render: ({ data: ticket, id }) => {
    if (!ticket) return <TextDisplay content="This ticket no longer exists." />

    const status = {
      open: "🟢 Open, waiting for staff",
      claimed: `🟡 Claimed by <@${ticket.claimedBy}>`,
      closed: "🔴 Closed"
    }[ticket.status]

    return (
      <Container accentColor={ticket.status === "closed" ? "Red" : "Blurple"}>
        <TextDisplay content={`## Ticket #${ticket.id}`} />
        <TextDisplay content={`Opened by <@${ticket.openedBy}>\n${status}`} />
        {ticket.notes.length > 0 && (
          <TextDisplay content={`**Notes**\n${ticket.notes.map(n => `• ${n}`).join("\n")}`} />
        )}
        <Separator />
        <ActionRow>
          <Button
            customId={id("claim")}
            style={ButtonStyle.Success}
            disabled={ticket.status !== "open"}
          >
            Claim
          </Button>
          <Button customId={id("manage")} style={ButtonStyle.Secondary}>
            Manage
          </Button>
          <Button
            customId={id("close")}
            style={ButtonStyle.Danger}
            disabled={ticket.status === "closed"}
          >
            Close
          </Button>
        </ActionRow>
      </Container>
    )
  },

  actions: {
    claim: ctx => {
      const ticket = tickets.get(ctx.params.ticketId)
      if (!ticket || ticket.status !== "open") return
      ticket.status = "claimed"
      ticket.claimedBy = ctx.user.id
      // Refresh every other view of this ticket (e.g. someone's open "Manage" view).
      ctx.invalidate()
    },

    manage: ctx => {
      // Opens a private, per-user view as an ephemeral follow-up.
      ctx.open(ticketManage, { ticketId: ctx.params.ticketId }, { ephemeral: true })
    },

    close: ctx => {
      const ticket = tickets.get(ctx.params.ticketId)
      if (!ticket) return
      ticket.status = "closed"
      ctx.invalidate()
      ctx.reply("Ticket closed.")
    }
  }
})
