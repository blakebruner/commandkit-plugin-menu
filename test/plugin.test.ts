import { EventEmitter } from "node:events"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

const appRoot = mkdtempSync(path.join(tmpdir(), "menu-plugin-"))
const menusDir = path.join(appRoot, "app", "menus")

vi.mock("commandkit", async importOriginal => {
  const actual = await importOriginal<typeof import("commandkit")>()
  return { ...actual, getCurrentDirectory: () => appRoot }
})

const { getMenuEngine } = await import("../src/engine")
const { MenuPlugin, menu } = await import("../src/plugin")
const { MemoryMenuStorage } = await import("../src/storage/memory")
const { fakeInteraction } = await import("./helpers")

const indexUrl = pathToFileURL(path.resolve("src/index.ts")).href

function writeMenu(file: string, body: string) {
  const full = path.join(menusDir, file)
  mkdirSync(path.dirname(full), { recursive: true })
  writeFileSync(full, `import { defineMenu } from ${JSON.stringify(indexUrl)}\n${body}\n`)
}

const text = (label: string) =>
  `[{ type: 10, content: ${JSON.stringify(label)} }, { type: 1, components: [{ type: 2, style: 1, label: "x", custom_id: ctx.id("ping") }] }]`

class FakeClient extends EventEmitter {
  application = { id: "app-1" }
  rest = {}
}

let plugin: InstanceType<typeof MenuPlugin>
let client: FakeClient

beforeAll(async () => {
  writeMenu(
    "ticket.ts",
    `export default defineMenu({ name: "ticket", render: ctx => ${text("v1")}, actions: { ping() {} } })`
  )
  writeMenu(
    "nested/music.ts",
    `export const queue = defineMenu({ name: "queue", render: ctx => ${text("q")}, actions: { ping() {} } })
     export const player = defineMenu({ name: "player", render: ctx => ${text("p")}, actions: { ping() {} } })`
  )
  writeMenu("_draft.ts", `export default defineMenu({ name: "draft", render: () => [] })`)
  writeMenu("helpers.ts", `export const notAMenu = 1`)

  client = new FakeClient()
  plugin = menu({ storage: new MemoryMenuStorage(), debounce: 1, sweepInterval: 0 })
  await plugin.activate({ commandkit: { client } } as any)
})

afterAll(async () => {
  await plugin.deactivate()
  rmSync(appRoot, { recursive: true, force: true })
})

describe("MenuPlugin", () => {
  it("loads default and named menu exports from app/menus, recursively, skipping _files", () => {
    expect([...getMenuEngine().menus.keys()].sort()).toEqual(["player", "queue", "ticket"])
  })

  it("applies plugin options to the engine", () => {
    expect(getMenuEngine().options.debounce).toBe(1)
    expect(getMenuEngine().storage).toBeInstanceOf(MemoryMenuStorage)
  })

  it("routes menu interactions through onBeforeInteraction", async () => {
    const opener = fakeInteraction()
    const ref = await getMenuEngine().reply(opener, "ticket")
    const click = fakeInteraction({ kind: "button", customId: `menu:${ref.id}:ping` })
    await plugin.onBeforeInteraction({} as any, click)
    expect(click.calls[0].method).toBe("update")
  })

  it("forgets views when Discord reports their message or channel deleted", async () => {
    const engine = getMenuEngine()
    const sent: string[] = []
    engine.transport = {
      send: async () => {
        sent.push("m")
        return { id: `msg-${sent.length}` }
      },
      edit: async () => {},
      delete: async () => {}
    }
    const a = await engine.send("chan-a", "queue")
    const b = await engine.send("chan-b", "queue")
    client.emit("messageDelete", { id: a.messageId })
    client.emit("channelDelete", { id: "chan-b" })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(await engine.storage.get(a.id)).toBeNull()
    expect(await engine.storage.get(b.id)).toBeNull()
  })

  it("hot reloads a changed menu file and pushes the new render to open views", async () => {
    const engine = getMenuEngine()
    const edits: unknown[] = []
    engine.transport = {
      send: async () => ({ id: "panel-msg" }),
      edit: async (_target, rendered) => {
        edits.push(rendered.components)
      },
      delete: async () => {}
    }
    await engine.send("chan-hmr", "ticket")

    writeMenu(
      "ticket.ts",
      `export default defineMenu({ name: "ticket", render: ctx => ${text("v2")}, actions: { ping() {} } })`
    )
    const event = {
      event: "unknown",
      path: path.join(process.cwd(), "src", "app", "menus", "ticket.ts"),
      accept: vi.fn(),
      preventDefault: vi.fn()
    }
    await plugin.performHMR({} as any, event as any)

    expect(event.accept).toHaveBeenCalled()
    expect(JSON.stringify(edits)).toContain("v2")
  })

  it("ignores HMR events for other folders", async () => {
    const event = {
      event: "unknown",
      path: path.join(process.cwd(), "src", "app", "tasks", "x.ts"),
      accept: vi.fn(),
      preventDefault: vi.fn()
    }
    await plugin.performHMR({} as any, event as any)
    expect(event.accept).not.toHaveBeenCalled()
  })

  it("removes its client listeners on deactivate", async () => {
    const before = client.listenerCount("messageDelete")
    const other = new MenuPlugin({})
    const otherClient = new FakeClient()
    await other.activate({ commandkit: { client: otherClient } } as any)
    expect(otherClient.listenerCount("messageDelete")).toBe(1)
    await other.deactivate()
    expect(otherClient.listenerCount("messageDelete")).toBe(0)
    expect(client.listenerCount("messageDelete")).toBe(before)
  })
})
