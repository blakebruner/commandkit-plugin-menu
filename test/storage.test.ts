import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import Redis from "ioredis"
import { afterAll, beforeEach, describe, expect, it } from "vitest"
import { MemoryMenuStorage } from "../src/storage/memory"
import { RedisMenuStorage } from "../src/storage/redis"
import { SqliteMenuStorage } from "../src/storage/sqlite"
import type { MenuStorage } from "../src/storage/types"
import type { ViewRecord } from "../src/types"

const tmp = mkdtempSync(path.join(tmpdir(), "menu-storage-"))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

let counter = 0
function view(overrides: Partial<ViewRecord> = {}): ViewRecord {
  counter++
  return {
    id: `v${counter}`,
    menu: "queue",
    key: "guild-1",
    params: { guildId: "guild-1" },
    state: { page: 0 },
    ephemeral: false,
    ownerId: "u1",
    guildId: "guild-1",
    channelId: "c1",
    messageId: `m${counter}`,
    applicationId: "app",
    token: null,
    tokenTarget: null,
    tokenExpiresAt: null,
    createdAt: 1,
    updatedAt: 1,
    expiresAt: null,
    ...overrides
  }
}

// Redis tests run against a real server when REDIS_URL is set (e.g. redis://127.0.0.1:6390).
const redisUrl = process.env.REDIS_URL
const redisClients: Redis[] = []
afterAll(async () => {
  await Promise.all(redisClients.map(client => client.quit()))
})

const drivers: Array<[string, () => MenuStorage]> = [
  ["memory", () => new MemoryMenuStorage()],
  ["sqlite (node:sqlite)", () => new SqliteMenuStorage(new DatabaseSync(":memory:"))]
]
if (redisUrl) {
  drivers.push([
    "redis",
    () => {
      const client = new Redis(redisUrl)
      redisClients.push(client)
      // a fresh prefix per test keeps runs independent without flushing the database
      return new RedisMenuStorage(client, { prefix: `menu-test:${Date.now()}:${counter}:` })
    }
  ])
} else {
  it.skip("redis storage (set REDIS_URL to run)", () => {})
}

describe.each(drivers)("%s storage", (_name, create) => {
  let storage: MenuStorage
  beforeEach(() => {
    storage = create()
  })

  it("saves, reads and deletes views", async () => {
    const v = view()
    await storage.save(v)
    expect(await storage.get(v.id)).toEqual(v)
    await storage.delete(v.id)
    expect(await storage.get(v.id)).toBeNull()
    await storage.delete("missing") // no-op
  })

  it("finds views by key, menu, channel and message", async () => {
    const a = view({ key: "g1" })
    const b = view({ key: "g1", channelId: "c2" })
    const c = view({ key: "g2", menu: "other" })
    for (const v of [a, b, c]) await storage.save(v)

    expect((await storage.findByKey("queue", "g1")).map(v => v.id).sort()).toEqual(
      [a.id, b.id].sort()
    )
    expect((await storage.findByMenu("queue")).length).toBe(2)
    expect((await storage.findByMenu("other")).map(v => v.id)).toEqual([c.id])
    expect((await storage.findByChannel("c2")).map(v => v.id)).toEqual([b.id])
    expect((await storage.findByMessage(a.messageId!))?.id).toBe(a.id)
    expect(await storage.findByMessage("nope")).toBeNull()
  })

  it("keeps indexes in sync when a view changes key, channel or message", async () => {
    const v = view({ key: "old", channelId: "c-old", messageId: "m-old" })
    await storage.save(v)
    await storage.save({
      ...v,
      key: "new",
      channelId: "c-new",
      messageId: "m-new",
      state: { page: 3 }
    })

    expect(await storage.findByKey("queue", "old")).toEqual([])
    expect((await storage.findByKey("queue", "new"))[0]?.state).toEqual({ page: 3 })
    expect(await storage.findByChannel("c-old")).toEqual([])
    expect(await storage.findByMessage("m-old")).toBeNull()
    expect((await storage.findByMessage("m-new"))?.id).toBe(v.id)
  })

  it("removes a deleted view from every index", async () => {
    const v = view()
    await storage.save(v)
    await storage.delete(v.id)
    expect(await storage.findByKey(v.menu, v.key)).toEqual([])
    expect(await storage.findByMenu(v.menu)).toEqual([])
    expect(await storage.findByChannel(v.channelId!)).toEqual([])
    expect(await storage.findByMessage(v.messageId!)).toBeNull()
  })

  it("lists expired views oldest first, respecting the limit", async () => {
    await storage.save(view({ id: "late", expiresAt: 300 }))
    await storage.save(view({ id: "early", expiresAt: 100 }))
    await storage.save(view({ id: "future", expiresAt: 10_000 }))
    await storage.save(view({ id: "forever", expiresAt: null }))
    expect((await storage.findExpired(500, 10)).map(v => v.id)).toEqual(["early", "late"])
    expect((await storage.findExpired(500, 1)).map(v => v.id)).toEqual(["early"])
    // clearing an expiry removes it from the expiry index
    await storage.save(view({ id: "early", expiresAt: null }))
    expect((await storage.findExpired(500, 10)).map(v => v.id)).toEqual(["late"])
  })
})

describe("sqlite persistence", () => {
  it("keeps views across reopening the database file", async () => {
    const file = path.join(tmp, "menus.db")
    const first = await SqliteMenuStorage.open(file)
    const v = view()
    await first.save(v)
    await first.close()

    const second = await SqliteMenuStorage.open(file)
    expect(await second.get(v.id)).toEqual(v)
    await second.close()
  })

  it("creates missing folders for a new database file", async () => {
    const file = path.join(tmp, "nested", "dir", "menus.db")
    const storage = await SqliteMenuStorage.open(file)
    await storage.save(view())
    await storage.close()
  })

  it("rejects unsafe table names", () => {
    expect(
      () => new SqliteMenuStorage(new DatabaseSync(":memory:"), { table: "x; drop" })
    ).toThrow()
  })
})
