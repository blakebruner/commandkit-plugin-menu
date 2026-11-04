import { ActionRow, Button, Container, Label, Modal, ShortInput, TextDisplay } from "commandkit"
import { defineMenu } from "commandkit-plugin-menu"
import { ButtonStyle } from "discord.js"
import { tickets } from "../../lib/store"

/**
 * A private (ephemeral) management view, opened from the public panel's "Manage" button.
 *
 * Nobody can know whether an ephemeral message is still open on someone's screen, so this menu is
 * `lazy`: changes aren't pushed to it, but every click re-renders it with fresh data.
 */
export default defineMenu({
  name: "ticket-manage",
  key: (params: { ticketId: string }) => params.ticketId,
  load: params => tickets.get(params.ticketId) ?? null,
  updates: "lazy",
  ephemeral: true,

  render: ({ data: ticket, id }) =>
    ticket ? (
      <Container>
        <TextDisplay content={`### Managing ticket #${ticket.id}`} />
        <TextDisplay content={`${ticket.notes.length} note(s) · status: ${ticket.status}`} />
        <ActionRow>
          <Button customId={id("addNote")} style={ButtonStyle.Primary}>
            Add note
          </Button>
          <Button customId={id("refresh")} style={ButtonStyle.Secondary}>
            Refresh
          </Button>
        </ActionRow>
      </Container>
    ) : (
      <TextDisplay content="This ticket no longer exists." />
    ),

  actions: {
    addNote: async ctx => {
      await ctx.showModal(
        <Modal customId={ctx.id("saveNote")} title="Add a note">
          <Label label="Note">
            <ShortInput customId="note" required maxLength={200} />
          </Label>
        </Modal>
      )
    },

    saveNote: ctx => {
      const note = ctx.fields?.getTextInputValue("note")
      const ticket = tickets.get(ctx.params.ticketId)
      if (!note || !ticket) return
      ticket.notes.push(note)
      // The public panel is "live", so it updates for everyone in the channel.
      ctx.invalidate()
    },

    // Clicking any button already re-renders with fresh data; this one exists just for that.
    refresh: () => {}
  }
})
