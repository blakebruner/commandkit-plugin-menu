import { DatabaseSync } from "node:sqlite"
import { ButtonStyle, ComponentType, MessageFlags } from "discord.js"
import { afterEach, describe, expect, it, vi } from "vitest"
import { defineMenu } from "../src/define"
import { getMenuEngine } from "../src/engine"
import { definePaginatedMenu } from "../src/pagination"
import { MemoryMenuStorage } from "../src/storage/memory"
import { SqliteMenuStorage } from "../src/storage/sqlite"
import type { MenuStorage } from "../src/storage/types"
import { createEngine, customIds, fakeInteraction, findCustomId, sleep, texts } from "./helpers"

const text = (content: string) => ({ type: ComponentType.TextDisplay, content })
const button = (customId: string, label = "x") => ({
  type: ComponentType.ActionRow,
  components: [
    { type: ComponentType.Button, style: ButtonStyle.Primary, custom_id: customId, label }
  ]
})

/** A tiny "database" the menus read from, so tests can change data and watch messages update. */
function createTicketDb() {
  const tickets = new Map<string, { status: string; claimedBy: string | null }>()
  tickets.set("t1", { status: "open", claimedBy: null })
  tickets.set("t2", { status: "open", claimedBy: null })
  return tickets
}

function ticketPanel(db: ReturnType<typeof createTicketDb>, extra: Record<string, unknown> = {}) {
  return defineMenu({
    name: `ticket-panel-${Math.random().toString(36).slice(2, 8)}`,
    key: (p: { ticketId: string }) => p.ticketId,
    load: p => db.get(p.ticketId)!,
    render: ({ data, id }) => [
      text(`status: ${data.status}`),
      text(`claimed: ${data.claimedBy ?? "nobody"}`),
      button(id("claim")),
      button(id("close"))
    ],
    actions: {
      claim: ctx => {
        db.get(ctx.params.ticketId)!.claimedBy = ctx.user.id
        ctx.invalidate()
      },
      close: ctx => {
        db.get(ctx.params.ticketId)!.status = "closed"
        ctx.close("disable")
      }
    },
    ...extra
  })
}

afterEach(() => {
  vi.useRealTimers()
})

describe("opening menus", () => {
  it("replies to a command as a Components V2 message and stores the view", async () => {
    const { engine } = createEngine()
    const db = createTicketDb()
    const panel = ticketPanel(db)
    const interaction = fakeInteraction()

    const ref = await engine.reply(interaction, panel, { ticketId: "t1" }, { ephemeral: true })

    const reply = interaction.calls[0]
    expect(reply.method).toBe("reply")
    expect(reply.payload.flags & MessageFlags.IsComponentsV2).toBeTruthy()
    expect(reply.payload.flags & MessageFlags.Ephemeral).toBeTruthy()
    expect(texts(reply.payload.components)).toEqual(["status: open", "claimed: nobody"])
    expect(customIds(reply.payload.components)).toEqual([
      `menu:${ref.id}:claim`,
      `menu:${ref.id}:close`
    ])

    const stored = (await engine.storage.get(ref.id))!
    expect(stored).toMatchObject({
      menu: panel.name,
      key: "t1",
      ephemeral: true,
      ownerId: "user-1",
      token: interaction.token,
      tokenTarget: "@original"
    })
    expect(stored.expiresAt).toBeGreaterThan(Date.now())
  })

  it("edits a deferred reply and follows up on an already answered interaction", async () => {
    const { engine } = createEngine()
    const panel = ticketPanel(createTicketDb())

    const deferred = fakeInteraction()
    await deferred.deferReply({ flags: MessageFlags.Ephemeral })
    const a = await engine.reply(deferred, panel, { ticketId: "t1" })
    expect(deferred.calls.at(-1).method).toBe("editReply")
    expect(a.ephemeral).toBe(true) // follows the defer, not the menu default

    const answered = fakeInteraction()
    await answered.reply({ content: "hi" })
    const b = await engine.reply(answered, panel, { ticketId: "t1" })
    expect(answered.calls.at(-1).method).toBe("followUp")
    expect((await engine.storage.get(b.id))!.tokenTarget).not.toBe("@original")
  })

  it("sends public panels to a channel through the transport", async () => {
    const { engine, transport } = createEngine()
    const panel = ticketPanel(createTicketDb())
    const ref = await engine.send({ id: "ticket-channel", guildId: "g" }, panel, { ticketId: "t1" })
    expect(transport.sent).toHaveLength(1)
    expect(transport.sent[0]!.channelId).toBe("ticket-channel")
    expect(ref.messageId).toBe(transport.sent[0]!.id)
    expect((await engine.storage.get(ref.id))!.ephemeral).toBe(false)
  })

  it("rejects params that can't be stored", async () => {
    const { engine } = createEngine()
    const panel = ticketPanel(createTicketDb())
    await expect(
      engine.reply(fakeInteraction(), panel, { ticketId: "t1", channel: new Map() } as any)
    ).rejects.toThrow(/JSON/)
  })

  it("explains a typo in an action name at render time", async () => {
    const { engine } = createEngine()
    const menu = defineMenu({
      name: "typo-menu",
      render: ({ id }) => button(id("clse")),
      actions: { close: () => {} }
    })
    await expect(engine.reply(fakeInteraction(), menu)).rejects.toThrow(/no action "clse".*close/)
  })
})

describe("clicks", () => {
  it("runs the action, re-renders and updates the clicked message", async () => {
    const { engine } = createEngine()
    const db = createTicketDb()
    const panel = ticketPanel(db)
    const opener = fakeInteraction()
    const ref = await engine.reply(opener, panel, { ticketId: "t1" })

    const click = fakeInteraction({
      kind: "button",
      userId: "staff-1",
      customId: findCustomId(opener.calls[0].payload.components, "claim"),
      messageId: ref.messageId!
    })
    expect(await engine.handleInteraction(click)).toBe(true)

    expect(click.calls.map((c: any) => c.method)).toEqual(["update"])
    expect(texts(click.calls[0].payload.components)).toContain("claimed: staff-1")
    // A render without files must clear the previous render's files.
    expect(click.calls[0].payload.attachments).toEqual([])
  })

  it("ignores interactions that aren't menu buttons", async () => {
    const { engine } = createEngine()
    expect(
      await engine.handleInteraction(fakeInteraction({ kind: "button", customId: "other:1" }))
    ).toBe(false)
    expect(await engine.handleInteraction(fakeInteraction())).toBe(false)
  })

  it("keeps per-view state and passes args and select values to actions", async () => {
    const { engine } = createEngine()
    const seen: unknown[] = []
    const menu = defineMenu({
      name: "tabs",
      initialState: () => ({ tab: "home" }),
      render: ({ state, id }) => [
        text(`tab: ${state.tab}`),
        button(id("open", "settings")),
        {
          type: ComponentType.ActionRow,
          components: [
            {
              type: ComponentType.StringSelect,
              custom_id: id("pick"),
              options: [{ label: "a", value: "a" }]
            }
          ]
        }
      ],
      actions: {
        open: ctx => ctx.setState({ tab: ctx.arg! }),
        pick: ctx => {
          seen.push(ctx.values)
        }
      }
    })
    const opener = fakeInteraction()
    await engine.reply(opener, menu)
    const components = opener.calls[0].payload.components

    const click = fakeInteraction({ kind: "button", customId: findCustomId(components, "open") })
    await engine.handleInteraction(click)
    expect(texts(click.calls[0].payload.components)).toEqual(["tab: settings"])

    const select = fakeInteraction({
      kind: "select",
      customId: findCustomId(components, "pick"),
      values: ["a"]
    })
    await engine.handleInteraction(select)
    expect(seen).toEqual([["a"]])
    // state survived the second click
    expect(texts(select.calls[0].payload.components)).toEqual(["tab: settings"])
  })

  it("serializes concurrent clicks on one view so state changes aren't lost", async () => {
    const { engine } = createEngine()
    const menu = defineMenu({
      name: "counter",
      initialState: () => ({ count: 0 }),
      render: ({ state, id }) => [text(`count: ${state.count}`), button(id("inc"))],
      actions: {
        inc: async ctx => {
          const count = ctx.state.count
          await sleep(5)
          ctx.setState({ count: count + 1 })
        }
      }
    })
    const opener = fakeInteraction()
    const ref = await engine.reply(opener, menu)
    const customId = findCustomId(opener.calls[0].payload.components, "inc")
    await Promise.all(
      Array.from({ length: 5 }, () =>
        engine.handleInteraction(fakeInteraction({ kind: "button", customId }))
      )
    )
    expect((await engine.storage.get(ref.id))!.state).toEqual({ count: 5 })
  })

  it("closes a view from an action by disabling its components", async () => {
    const { engine } = createEngine()
    const db = createTicketDb()
    const panel = ticketPanel(db)
    const ref = await engine.send("c", panel, { ticketId: "t1" })
    const { transport } = { transport: (engine as any).transport }

    const click = fakeInteraction({
      kind: "button",
      customId: findCustomId(transport.sent[0].menu.components, "close")
    })
    await engine.handleInteraction(click)

    const update = click.calls[0]
    expect(update.method).toBe("update")
    expect(texts(update.payload.components)).toContain("status: closed")
    expect(JSON.stringify(update.payload.components)).toContain('"disabled":true')
    expect(await engine.storage.get(ref.id)).toBeNull()
  })

  it("answers clicks on views that no longer exist with a notice and disables the old buttons", async () => {
    const { engine } = createEngine()
    const click = fakeInteraction({
      kind: "button",
      customId: "menu:gone123:claim",
      messageComponents: [button("menu:gone123:claim")]
    })
    await engine.handleInteraction(click)
    expect(click.calls[0].method).toBe("update")
    expect(click.calls[0].payload.components[0].components[0].disabled).toBe(true)
    expect(click.calls[1].method).toBe("followUp")
    expect(click.calls[1].payload.content).toMatch(/expired/)
  })

  it("enforces owner-only access", async () => {
    const { engine } = createEngine()
    const panel = ticketPanel(createTicketDb(), { access: "owner" })
    const opener = fakeInteraction({ userId: "owner" })
    await engine.reply(opener, panel, { ticketId: "t1" })
    const customId = findCustomId(opener.calls[0].payload.components, "claim")

    const stranger = fakeInteraction({ kind: "button", userId: "someone-else", customId })
    await engine.handleInteraction(stranger)
    expect(stranger.calls).toHaveLength(1)
    expect(stranger.calls[0].method).toBe("reply")
    expect(stranger.calls[0].payload.content).toMatch(/can't use/)
    expect(stranger.calls[0].payload.flags & MessageFlags.Ephemeral).toBeTruthy()
  })

  it("replies with an error and logs when an action throws", async () => {
    const { engine } = createEngine()
    const menu = defineMenu({
      name: "broken",
      render: ({ id }) => button(id("boom")),
      actions: {
        boom: () => {
          throw new Error("kaboom")
        }
      }
    })
    const opener = fakeInteraction()
    await engine.reply(opener, menu)
    const click = fakeInteraction({
      kind: "button",
      customId: findCustomId(opener.calls[0].payload.components, "boom")
    })
    await engine.handleInteraction(click)
    expect(click.calls[0].method).toBe("reply")
    expect(click.calls[0].payload.content).toMatch(/went wrong/)
  })

  it("auto-defers slow actions and then edits the message", async () => {
    const { engine } = createEngine()
    engine.configure({ debounce: 5, deferAfter: 10, sweepInterval: 0 })
    const menu = defineMenu({
      name: "slow",
      initialState: () => ({ done: false }),
      render: ({ state, id }) => [text(state.done ? "done" : "working"), button(id("go"))],
      actions: {
        go: async ctx => {
          await sleep(40)
          ctx.setState({ done: true })
        }
      }
    })
    const opener = fakeInteraction()
    await engine.reply(opener, menu)
    const click = fakeInteraction({
      kind: "button",
      customId: findCustomId(opener.calls[0].payload.components, "go")
    })
    await engine.handleInteraction(click)
    expect(click.calls.map((c: any) => c.method)).toEqual(["deferUpdate", "editReply"])
    expect(texts(click.calls[1].payload.components)).toEqual(["done"])
  })

  it("shows modals and routes the submit back to the same view", async () => {
    const { engine } = createEngine()
    const menu = defineMenu({
      name: "rename",
      initialState: () => ({ name: "old" }),
      render: ({ state, id }) => [text(`name: ${state.name}`), button(id("edit"))],
      actions: {
        edit: async ctx => {
          await ctx.showModal({ custom_id: ctx.id("save"), title: "Rename", components: [] })
        },
        save: ctx => ctx.setState({ name: ctx.fields!.getTextInputValue("name") })
      }
    })
    const opener = fakeInteraction()
    await engine.reply(opener, menu)
    const click = fakeInteraction({
      kind: "button",
      customId: findCustomId(opener.calls[0].payload.components, "edit")
    })
    await engine.handleInteraction(click)
    expect(click.calls.map((c: any) => c.method)).toEqual(["showModal"])

    const submit = fakeInteraction({
      kind: "modal",
      customId: click.calls[0].payload.custom_id,
      fields: { name: "new" }
    })
    await engine.handleInteraction(submit)
    expect(submit.calls[0].method).toBe("update")
    expect(texts(submit.calls[0].payload.components)).toEqual(["name: new"])
  })

  it("sends follow-ups and opens another menu after updating", async () => {
    const { engine } = createEngine()
    const manage = defineMenu({
      name: "manage",
      key: (p: { ticketId: string }) => p.ticketId,
      render: ({ params }) => text(`managing ${params.ticketId}`)
    })
    const panel = defineMenu({
      name: "panel-with-manage",
      key: (p: { ticketId: string }) => p.ticketId,
      render: ({ id }) => button(id("manage")),
      actions: {
        manage: ctx => {
          ctx.reply("Opening the manager…")
          ctx.open(manage, { ticketId: ctx.params.ticketId }, { ephemeral: true })
        }
      }
    })
    const ref = await engine.send("c", panel, { ticketId: "t9" })
    const click = fakeInteraction({
      kind: "button",
      customId: `menu:${ref.id}:manage`
    })
    await engine.handleInteraction(click)
    expect(click.calls.map((c: any) => c.method)).toEqual(["update", "followUp", "followUp"])
    expect(texts(click.calls[2].payload.components)).toEqual(["managing t9"])
    expect(click.calls[2].payload.flags & MessageFlags.Ephemeral).toBeTruthy()
    expect(await engine.views(manage)).toHaveLength(1)
  })

  it("navigates in place to another menu", async () => {
    const { engine } = createEngine()
    const settings = defineMenu({
      name: "settings",
      render: ({ id }) => [text("settings"), button(id("back"))],
      actions: { back: ctx => ctx.navigate("home") }
    })
    const home = defineMenu({
      name: "home",
      render: ({ id }) => [text("home"), button(id("go"))],
      actions: { go: ctx => ctx.navigate(settings) }
    })
    engine.register(settings)
    const opener = fakeInteraction()
    const ref = await engine.reply(opener, home)
    const go = fakeInteraction({ kind: "button", customId: `menu:${ref.id}:go` })
    await engine.handleInteraction(go)
    expect(texts(go.calls[0].payload.components)).toEqual(["settings"])
    expect((await engine.storage.get(ref.id))!.menu).toBe("settings")

    const back = fakeInteraction({ kind: "button", customId: `menu:${ref.id}:back` })
    await engine.handleInteraction(back)
    expect(texts(back.calls[0].payload.components)).toEqual(["home"])
  })
})

describe("pushing updates", () => {
  async function openPanels(engine: ReturnType<typeof createEngine>["engine"], panel: any) {
    const a = await engine.send("c1", panel, { ticketId: "t1" })
    const b = await engine.send("c2", panel, { ticketId: "t1" })
    const other = await engine.send("c3", panel, { ticketId: "t2" })
    const hidden = fakeInteraction({ userId: "u2" })
    const ephemeral = await engine.reply(hidden, panel, { ticketId: "t1" }, { ephemeral: true })
    return { a, b, other, ephemeral, hidden }
  }

  it("re-renders every live view with the same key, once, after a burst of invalidations", async () => {
    const { engine, transport } = createEngine()
    const db = createTicketDb()
    const panel = ticketPanel(db)
    const views = await openPanels(engine, panel)
    let loads = 0
    const originalLoad = panel.runtime.load
    panel.runtime.load = (params, ctx) => {
      loads++
      return originalLoad(params, ctx)
    }

    db.get("t1")!.status = "pending"
    await Promise.all(
      Array.from({ length: 10 }, () => engine.invalidate(panel, { ticketId: "t1" }))
    )

    const targets = transport.edits.map(e =>
      e.target.kind === "channel" ? e.target.channelId : `webhook:${e.target.token}`
    )
    expect(targets.sort()).toEqual(["c1", "c2", `webhook:${views.hidden.token}`].sort())
    expect(transport.edits.every(e => texts(e.menu.components)[0] === "status: pending")).toBe(true)
    expect(loads).toBe(1) // one load shared by the three views
  })

  it("invalidating without params refreshes every view of the menu", async () => {
    const { engine, transport } = createEngine()
    const panel = ticketPanel(createTicketDb())
    await openPanels(engine, panel)
    await engine.invalidate(panel)
    expect(transport.edits).toHaveLength(4)
  })

  it("skips lazy views unless forced", async () => {
    const { engine, transport } = createEngine()
    const panel = ticketPanel(createTicketDb(), { updates: { public: "live", ephemeral: "lazy" } })
    await openPanels(engine, panel)

    await engine.invalidate(panel, { ticketId: "t1" })
    expect(transport.edits.map(e => e.target.kind)).toEqual(["channel", "channel"])

    transport.edits = []
    await engine.invalidate(panel, { ticketId: "t1" }, { force: true })
    expect(transport.edits.map(e => e.target.kind).sort()).toEqual([
      "channel",
      "channel",
      "webhook"
    ])
  })

  it("lazy views still show fresh data when clicked", async () => {
    const { engine, transport } = createEngine()
    const db = createTicketDb()
    const panel = ticketPanel(db, { updates: "lazy" })
    const ref = await engine.send("c1", panel, { ticketId: "t1" })
    db.get("t1")!.status = "escalated"
    await engine.invalidate(panel, { ticketId: "t1" })
    expect(transport.edits).toHaveLength(0)

    const click = fakeInteraction({ kind: "button", customId: `menu:${ref.id}:claim` })
    await engine.handleInteraction(click)
    expect(texts(click.calls[0].payload.components)[0]).toBe("status: escalated")
  })

  it("doesn't push to ephemeral views whose token expired", async () => {
    const { engine, transport } = createEngine()
    const panel = ticketPanel(createTicketDb())
    const hidden = fakeInteraction()
    hidden.createdTimestamp = Date.now() - 20 * 60 * 1000 // 20 minutes ago
    await engine.reply(hidden, panel, { ticketId: "t1" }, { ephemeral: true })
    await engine.invalidate(panel, { ticketId: "t1" })
    expect(transport.edits).toHaveLength(0)
  })

  it("an action's invalidate() updates the other views but not the clicked one twice", async () => {
    const { engine, transport } = createEngine()
    const panel = ticketPanel(createTicketDb())
    const views = await openPanels(engine, panel)
    const click = fakeInteraction({
      kind: "button",
      userId: "staff",
      customId: `menu:${views.a.id}:claim`
    })
    await engine.handleInteraction(click)
    await sleep(30)

    expect(texts(click.calls[0].payload.components)).toContain("claimed: staff")
    const pushedTo = transport.edits.map(e =>
      e.target.kind === "channel" ? e.target.channelId : "webhook"
    )
    expect(pushedTo.sort()).toEqual(["c2", "webhook"])
    expect(transport.edits.every(e => texts(e.menu.components).includes("claimed: staff"))).toBe(
      true
    )
  })

  it("refreshes an ephemeral view's token on each click so pushes keep working", async () => {
    const { engine, transport } = createEngine()
    const panel = ticketPanel(createTicketDb())
    const hidden = fakeInteraction()
    hidden.createdTimestamp = Date.now() - 20 * 60 * 1000
    const ref = await engine.reply(hidden, panel, { ticketId: "t1" }, { ephemeral: true })

    const click = fakeInteraction({ kind: "button", customId: `menu:${ref.id}:claim` })
    await engine.handleInteraction(click)
    await sleep(20)
    transport.edits = []

    await engine.invalidate(panel, { ticketId: "t1" })
    expect(transport.edits).toHaveLength(1)
    expect(transport.edits[0]!.target).toMatchObject({
      kind: "webhook",
      token: click.token,
      messageId: "@original"
    })
  })

  it("drops views whose message was deleted and forgets dead tokens", async () => {
    const { engine, transport } = createEngine()
    const panel = ticketPanel(createTicketDb())
    const ref = await engine.send("c1", panel, { ticketId: "t1" })
    transport.failNext = { code: 10008 }
    await engine.invalidate(panel, { ticketId: "t1" })
    expect(await engine.storage.get(ref.id)).toBeNull()

    const hidden = fakeInteraction()
    const eph = await engine.reply(hidden, panel, { ticketId: "t2" }, { ephemeral: true })
    transport.failNext = { code: 50027 }
    await engine.invalidate(panel, { ticketId: "t2" })
    const stored = (await engine.storage.get(eph.id))!
    expect(stored.token).toBeNull() // kept for lazy clicks, but no longer pushed to
  })

  it("resyncs menus marked resyncOnStart", async () => {
    const { engine, transport } = createEngine()
    const live = ticketPanel(createTicketDb(), { resyncOnStart: true })
    const quiet = ticketPanel(createTicketDb())
    await engine.send("c1", live, { ticketId: "t1" })
    await engine.send("c2", quiet, { ticketId: "t1" })
    await engine.resync()
    expect(transport.edits.map(e => (e.target as any).channelId)).toEqual(["c1"])
  })
})

describe("replacing, closing and expiry", () => {
  it("replaces a user's older ephemeral view of the same key", async () => {
    const { engine, transport } = createEngine()
    const panel = ticketPanel(createTicketDb())
    const first = await engine.reply(
      fakeInteraction(),
      panel,
      { ticketId: "t1" },
      { ephemeral: true }
    )
    const second = await engine.reply(
      fakeInteraction(),
      panel,
      { ticketId: "t1" },
      { ephemeral: true }
    )
    expect(await engine.storage.get(first.id)).toBeNull()
    expect(await engine.storage.get(second.id)).not.toBeNull()
    expect(transport.deletes).toHaveLength(1)
  })

  it("replace: channel keeps one panel per channel", async () => {
    const { engine, transport } = createEngine()
    const panel = ticketPanel(createTicketDb(), { replace: "channel" })
    const first = await engine.send("ticket-1", panel, { ticketId: "t1" })
    await engine.send("ticket-1", panel, { ticketId: "t1" })
    expect(await engine.storage.get(first.id)).toBeNull()
    expect(transport.deletes[0]).toMatchObject({
      channelId: "ticket-1",
      messageId: first.messageId
    })
  })

  it("closes all views for some params", async () => {
    const { engine, transport } = createEngine()
    const panel = ticketPanel(createTicketDb())
    await engine.send("c1", panel, { ticketId: "t1" })
    await engine.send("c2", panel, { ticketId: "t1" })
    await engine.send("c3", panel, { ticketId: "t2" })
    expect(await engine.close(panel, { ticketId: "t1" }, "delete")).toBe(2)
    expect(transport.deletes).toHaveLength(2)
    expect(await engine.views(panel)).toHaveLength(1)
  })

  it("sweeps expired views and disables their buttons", async () => {
    const { engine, transport } = createEngine()
    const panel = ticketPanel(createTicketDb(), { ttl: 1000 })
    const ref = await engine.send("c1", panel, { ticketId: "t1" })
    expect(await engine.sweep(Date.now())).toBe(0)
    expect(await engine.sweep(Date.now() + 2000)).toBe(1)
    expect(await engine.storage.get(ref.id)).toBeNull()
    expect(JSON.stringify(transport.edits[0]!.menu.components)).toContain('"disabled":true')
  })

  it("clicks extend a view's lifetime", async () => {
    const { engine } = createEngine()
    const panel = ticketPanel(createTicketDb(), { ttl: 60_000 })
    const ref = await engine.send("c1", panel, { ticketId: "t1" })
    const before = (await engine.storage.get(ref.id))!.expiresAt!
    await sleep(5)
    await engine.handleInteraction(
      fakeInteraction({ kind: "button", customId: `menu:${ref.id}:claim` })
    )
    expect((await engine.storage.get(ref.id))!.expiresAt!).toBeGreaterThan(before)
  })

  it("forgets views when their message or channel is deleted", async () => {
    const { engine } = createEngine()
    const panel = ticketPanel(createTicketDb())
    const a = await engine.send("c1", panel, { ticketId: "t1" })
    const b = await engine.send("c2", panel, { ticketId: "t1" })
    await engine.handleMessageDelete(a.messageId!)
    await engine.handleChannelDelete("c2")
    expect(await engine.storage.get(a.id)).toBeNull()
    expect(await engine.storage.get(b.id)).toBeNull()
  })
})

describe("restarts", () => {
  async function restartScenario(makeStorage: () => MenuStorage) {
    const db = createTicketDb()
    const storage = makeStorage()

    // process 1 opens the menu
    const first = createEngine(storage)
    const panel = ticketPanel(db)
    const ref = await first.engine.send("c1", panel, { ticketId: "t1" })
    const customId = findCustomId(first.transport.sent[0]!.menu.components, "claim")
    await first.engine.shutdown()

    // process 2 starts fresh: new engine, menu re-registered from its file, same storage
    const second = createEngine(storage)
    second.engine.register(panel)
    const click = fakeInteraction({ kind: "button", userId: "after-restart", customId })
    await second.engine.handleInteraction(click)
    return { click, ref, second }
  }

  it("old buttons keep working after a restart with persistent storage", async () => {
    const { click } = await restartScenario(
      () => new SqliteMenuStorage(new DatabaseSync(":memory:"))
    )
    expect(click.calls[0].method).toBe("update")
    expect(texts(click.calls[0].payload.components)).toContain("claimed: after-restart")
  })

  it("and pushes still reach messages opened before the restart", async () => {
    const { ref, second, click } = await restartScenario(
      () => new SqliteMenuStorage(new DatabaseSync(":memory:"))
    )
    const panel = second.engine.menus.get(ref.menu)!
    await second.engine.invalidate(panel, { ticketId: "t1" }, { force: true })
    // the post-restart click renewed the token, so the push goes through it
    expect(second.transport.edits.map(e => e.target)).toEqual([
      { kind: "webhook", applicationId: "app-1", token: click.token, messageId: "@original" }
    ])

    // once that token expires, public messages fall back to the channel endpoint
    const stored = (await second.engine.storage.get(ref.id))!
    await second.engine.storage.save({ ...stored, tokenExpiresAt: Date.now() - 1 })
    second.transport.edits = []
    await second.engine.invalidate(panel, { ticketId: "t1" }, { force: true })
    expect(second.transport.edits[0]!.target).toEqual({
      kind: "channel",
      channelId: "c1",
      messageId: ref.messageId
    })
  })

  it("with memory storage the old buttons answer as expired instead of failing", async () => {
    const panel = ticketPanel(createTicketDb())
    const before = createEngine(new MemoryMenuStorage())
    await before.engine.send("c1", panel, { ticketId: "t1" })
    const customId = findCustomId(before.transport.sent[0]!.menu.components, "claim")

    const after = createEngine(new MemoryMenuStorage()) // memory is empty after a restart
    after.engine.register(panel)
    const click = fakeInteraction({
      kind: "button",
      customId,
      messageComponents: [button(customId)]
    })
    await after.engine.handleInteraction(click)
    expect(click.calls.map((c: any) => c.method)).toEqual(["update", "followUp"])
    expect(click.calls[1].payload.content).toMatch(/expired/)
  })
})

describe("typed helpers on definitions", () => {
  it("use the shared engine", async () => {
    const engine = getMenuEngine()
    const transport = { sent: [] as any[], edits: [] as any[] }
    engine.attachClient({ application: { id: "app" } } as any, {
      send: async (channelId, menu) => {
        transport.sent.push({ channelId, menu })
        return { id: "m1" }
      },
      edit: async (target, menu) => {
        transport.edits.push({ target, menu })
      },
      delete: async () => {}
    })
    const counter = { value: 1 }
    const menu = defineMenu({
      name: "shared-counter",
      load: () => counter.value,
      render: ({ data }) => text(`value ${data}`)
    })
    await menu.send("c1")
    counter.value = 2
    await menu.invalidate()
    expect(texts(transport.edits[0].menu.components)).toEqual(["value 2"])
    expect(await menu.views()).toHaveLength(1)
    await engine.shutdown()
  })
})

describe("pagination", () => {
  const tracks = Array.from({ length: 12 }, (_, i) => ({ id: `t${i + 1}`, title: `Song ${i + 1}` }))

  function queueMenu(source: { list: typeof tracks }) {
    return definePaginatedMenu({
      name: `queue-${Math.random().toString(36).slice(2, 8)}`,
      key: (p: { guildId: string }) => p.guildId,
      load: () => ({ playing: "Intro", upcoming: source.list }),
      items: data => data.upcoming,
      perPage: 5,
      color: "Purple",
      renderHeader: ({ data }) => text(`Now playing: ${data.playing}`),
      renderItem: (track, index, { id }) => [
        text(`${index + 1}. ${track.title}`),
        button(id("remove", track.id))
      ],
      renderEmpty: () => text("Queue is empty"),
      actions: {
        remove: ctx => {
          source.list = source.list.filter(t => t.id !== ctx.arg)
          ctx.invalidate()
        }
      }
    })
  }

  it("renders a page inside a container with navigation", async () => {
    const { engine } = createEngine()
    const menu = queueMenu({ list: tracks })
    const opener = fakeInteraction()
    await engine.reply(opener, menu, { guildId: "g" })
    const [container] = opener.calls[0].payload.components
    expect(container.type).toBe(ComponentType.Container)
    expect(container.accent_color).toBeTypeOf("number")
    expect(texts(container)).toEqual([
      "Now playing: Intro",
      "1. Song 1",
      "2. Song 2",
      "3. Song 3",
      "4. Song 4",
      "5. Song 5",
      "-# Page 1 of 3"
    ])
    const ids = customIds(container)
    expect(ids.filter(id => id.includes(":$"))).toHaveLength(4) // first/prev/next/last, no jump at 3 pages
  })

  it("moves between pages per view and clamps at the ends", async () => {
    const { engine } = createEngine()
    const menu = queueMenu({ list: tracks })
    const opener = fakeInteraction()
    const ref = await engine.reply(opener, menu, { guildId: "g" })
    const click = async (action: string, values?: string[]) => {
      const i = fakeInteraction({
        kind: values ? "select" : "button",
        customId: `menu:${ref.id}:${action}`,
        values
      })
      await engine.handleInteraction(i)
      return texts(i.calls[0].payload.components)
    }
    expect((await click("$next")).at(-1)).toBe("-# Page 2 of 3")
    expect((await click("$last")).at(-1)).toBe("-# Page 3 of 3")
    expect((await click("$next")).at(-1)).toBe("-# Page 3 of 3")
    expect((await click("$first")).at(-1)).toBe("-# Page 1 of 3")
    expect((await click("$prev")).at(-1)).toBe("-# Page 1 of 3")
  })

  it("shows a jump select when there are many pages", async () => {
    const { engine } = createEngine()
    const many = Array.from({ length: 40 }, (_, i) => ({ id: `t${i}`, title: `S${i}` }))
    const menu = queueMenu({ list: many })
    const opener = fakeInteraction()
    const ref = await engine.reply(opener, menu, { guildId: "g" })
    expect(customIds(opener.calls[0].payload.components)).toContain(`menu:${ref.id}:$jump`)
    const jump = fakeInteraction({
      kind: "select",
      customId: `menu:${ref.id}:$jump`,
      values: ["6"]
    })
    await engine.handleInteraction(jump)
    expect(texts(jump.calls[0].payload.components).at(-1)).toBe("-# Page 7 of 8")
  })

  it("item actions get the item id, and pages clamp when the list shrinks", async () => {
    const { engine } = createEngine()
    const source = { list: tracks.slice(0, 6) }
    const menu = queueMenu(source)
    const opener = fakeInteraction()
    const ref = await engine.reply(opener, menu, { guildId: "g" })
    const next = fakeInteraction({ kind: "button", customId: `menu:${ref.id}:$next` })
    await engine.handleInteraction(next)
    expect(texts(next.calls[0].payload.components)).toContain("6. Song 6")

    const remove = fakeInteraction({ kind: "button", customId: `menu:${ref.id}:remove:t6` })
    await engine.handleInteraction(remove)
    const after = texts(remove.calls[0].payload.components)
    expect(after).toContain("5. Song 5") // back on page 1, which is now the only page
    expect(after.some(t => t.startsWith("-# Page"))).toBe(false)
  })

  it("renders the empty state", async () => {
    const { engine } = createEngine()
    const opener = fakeInteraction()
    await engine.reply(opener, queueMenu({ list: [] }), { guildId: "g" })
    expect(texts(opener.calls[0].payload.components)).toEqual([
      "Now playing: Intro",
      "Queue is empty"
    ])
  })
})

describe("regressions", () => {
  const bumpRow = (id: string) => button(id)

  it("an action that reopens its own menu and key doesn't deadlock", async () => {
    const { engine } = createEngine()
    const panel = defineMenu({
      name: "repost-panel",
      key: (p: { t: string }) => p.t,
      replace: "channel",
      render: ({ id }) => bumpRow(id("repost")),
      actions: { repost: ctx => ctx.open("repost-panel", ctx.params, { ephemeral: false }) }
    })
    const opener = fakeInteraction()
    const first = await engine.reply(opener, panel, { t: "1" })
    const click = fakeInteraction({ kind: "button", customId: `menu:${first.id}:repost` })
    const result = await Promise.race([
      engine.handleInteraction(click).then(() => "done"),
      sleep(1000).then(() => "hung")
    ])
    expect(result).toBe("done")
    const views = await engine.views(panel)
    expect(views).toHaveLength(1) // the old one was replaced by the reposted one
    expect(views[0]!.id).not.toBe(first.id)
  })

  it("a render of data loaded before an invalidate isn't treated as fresh", async () => {
    const { engine, transport } = createEngine()
    engine.options.concurrency = 1
    let value = "v1"
    const menu = defineMenu({
      name: "stale-check",
      key: () => "k",
      load: async () => value,
      render: ({ data }) => text(data)
    })
    await engine.send("c1", menu)
    await engine.send("c2", menu)
    const edit = transport.edit.bind(transport)
    transport.edit = async (target, rendered) => {
      await sleep(60)
      return edit(target, rendered)
    }
    value = "v2"
    const first = engine.invalidate(menu, undefined, { immediate: true })
    await sleep(20) // v2 loaded and cached, first edit in flight
    value = "v3"
    await Promise.all([first, engine.invalidate(menu)])
    const last = new Map<string, string>()
    for (const e of transport.edits)
      last.set((e.target as any).channelId, texts(e.menu.components)[0]!)
    expect(Object.fromEntries(last)).toEqual({ c1: "v3", c2: "v3" })
  })

  it("keeps views whose menu is temporarily not registered", async () => {
    const { engine } = createEngine()
    const panel = ticketPanel(createTicketDb())
    const ref = await engine.send("c1", panel, { ticketId: "t1" })
    engine.unregister(panel.name)
    const click = fakeInteraction({ kind: "button", customId: `menu:${ref.id}:claim` })
    await engine.handleInteraction(click)
    expect(click.calls[0].payload.content).toMatch(/went wrong/)
    expect(await engine.storage.get(ref.id)).not.toBeNull()

    engine.register(panel) // e.g. the file was fixed and hot-reloaded
    const retry = fakeInteraction({ kind: "button", customId: `menu:${ref.id}:claim` })
    await engine.handleInteraction(retry)
    expect(retry.calls[0].method).toBe("update")
  })

  it("steady invalidations still push every debounce interval", async () => {
    const { engine, transport } = createEngine()
    engine.options.debounce = 30
    let n = 0
    const menu = defineMenu({
      name: "ticker",
      load: () => n,
      render: ({ data }) => text(`n=${data}`)
    })
    await engine.send("c1", menu)
    for (let i = 0; i < 12; i++) {
      n++
      void engine.invalidate(menu)
      await sleep(10)
    }
    expect(transport.edits.length).toBeGreaterThanOrEqual(2)
    await engine.invalidate(menu)
    expect(texts(transport.edits.at(-1)!.menu.components)).toEqual(["n=12"])
  })

  it("an action that calls deferReply itself gets its menu updated through a push", async () => {
    const { engine, transport } = createEngine()
    const db = createTicketDb()
    const panel = defineMenu({
      name: "defers-itself",
      key: (p: { ticketId: string }) => p.ticketId,
      load: p => db.get(p.ticketId)!,
      render: ({ data, id }) => [text(`status: ${data.status}`), button(id("work"))],
      actions: {
        work: async ctx => {
          await ctx.interaction.deferReply({ flags: MessageFlags.Ephemeral })
          db.get(ctx.params.ticketId)!.status = "worked"
        }
      }
    })
    const ref = await engine.send("c1", panel, { ticketId: "t1" })
    const click = fakeInteraction({ kind: "button", customId: `menu:${ref.id}:work` })
    await engine.handleInteraction(click)
    await sleep(30)
    expect(click.calls.map((c: any) => c.method)).toEqual(["deferReply"]) // no editReply of the "thinking" message
    expect(texts(transport.edits.at(-1)!.menu.components)[0]).toBe("status: worked")
  })

  it("an empty paginated menu with no sections still renders something", async () => {
    const { engine } = createEngine()
    const menu = definePaginatedMenu({
      name: "bare-list",
      load: () => [] as string[],
      renderItem: item => text(item)
    })
    const opener = fakeInteraction()
    await engine.reply(opener, menu)
    expect(texts(opener.calls[0].payload.components)).toEqual(["Nothing to show."])
  })

  it("the sweeper leaves a view alone if a click extended it meanwhile", async () => {
    const { engine } = createEngine()
    const panel = ticketPanel(createTicketDb(), { ttl: 60_000 })
    const ref = await engine.send("c1", panel, { ticketId: "t1" })
    const stored = (await engine.storage.get(ref.id))!
    const sweepTime = stored.expiresAt! + 1
    // a click extends the view past the sweep time before the sweeper gets to it
    await engine.storage.save({ ...stored, expiresAt: sweepTime + 60_000 })
    await engine.closeView(ref.id, "disable", sweepTime)
    expect(await engine.storage.get(ref.id)).not.toBeNull()
  })

  it("doesn't drop interaction-opened views when their channel can't be reached", async () => {
    const { engine, transport } = createEngine()
    const panel = ticketPanel(createTicketDb())
    const ref = await engine.reply(fakeInteraction(), panel, { ticketId: "t1" })
    const stored = (await engine.storage.get(ref.id))!
    await engine.storage.save({ ...stored, tokenExpiresAt: Date.now() - 1 })
    transport.failNext = { code: 10003 }
    await engine.invalidate(panel, { ticketId: "t1" })
    expect(await engine.storage.get(ref.id)).not.toBeNull()
  })
  it("an action can await invalidate() for its own menu without hanging", async () => {
    const { engine, transport } = createEngine()
    const db = createTicketDb()
    const panel = defineMenu({
      name: "await-invalidate",
      key: (p: { ticketId: string }) => p.ticketId,
      load: p => db.get(p.ticketId)!,
      render: ({ data, id }) => [
        text(`claimed: ${data.claimedBy ?? "nobody"}`),
        button(id("claim"))
      ],
      actions: {
        claim: async ctx => {
          db.get(ctx.params.ticketId)!.claimedBy = ctx.user.id
          await engine.invalidate(panel, ctx.params)
        }
      }
    })
    const clicked = await engine.reply(fakeInteraction(), panel, { ticketId: "t1" })
    await engine.send("c2", panel, { ticketId: "t1" })
    const click = fakeInteraction({
      kind: "button",
      userId: "staff",
      customId: `menu:${clicked.id}:claim`
    })
    const result = await Promise.race([
      engine.handleInteraction(click).then(() => "done"),
      sleep(1000).then(() => "hung")
    ])
    expect(result).toBe("done")
    expect(texts(click.calls[0].payload.components)).toContain("claimed: staff")
    await sleep(30)
    // the other view got the push; the clicked one was already fresh from the click
    expect(transport.edits).toHaveLength(1)
    expect(texts(transport.edits[0]!.menu.components)).toContain("claimed: staff")

    // and the clicked view still takes clicks afterwards
    const again = fakeInteraction({ kind: "button", customId: `menu:${clicked.id}:claim` })
    const second = await Promise.race([
      engine.handleInteraction(again).then(() => "done"),
      sleep(1000).then(() => "hung")
    ])
    expect(second).toBe("done")
  })

  it("an action can await close() for its own menu; the view closes after the click", async () => {
    const { engine } = createEngine()
    const panel = defineMenu({
      name: "await-close",
      key: (p: { t: string }) => p.t,
      render: ({ id }) => button(id("done")),
      actions: { done: async ctx => void (await engine.close(panel, ctx.params)) }
    })
    const ref = await engine.reply(fakeInteraction(), panel, { t: "1" })
    const click = fakeInteraction({ kind: "button", customId: `menu:${ref.id}:done` })
    const result = await Promise.race([
      engine.handleInteraction(click).then(() => "done"),
      sleep(1000).then(() => "hung")
    ])
    expect(result).toBe("done")
    await sleep(30)
    expect(await engine.views(panel)).toHaveLength(0)
  })
})
