import type { ViewRecord } from "../types"
import type { MenuStorage } from "./types"

/** The ioredis pipeline methods this driver uses. */
export interface RedisMultiLike {
  set(key: string, value: string): unknown
  del(...keys: string[]): unknown
  sadd(key: string, ...members: string[]): unknown
  srem(key: string, ...members: string[]): unknown
  zadd(key: string, score: number, member: string): unknown
  zrem(key: string, ...members: string[]): unknown
  exec(): Promise<unknown>
}

/** The subset of an ioredis client this driver needs. Any ioredis `Redis` or `Cluster` fits. */
export interface RedisLike {
  get(key: string): Promise<string | null>
  mget(...keys: string[]): Promise<(string | null)[]>
  smembers(key: string): Promise<string[]>
  srem(key: string, ...members: string[]): Promise<number>
  zrangebyscore(
    key: string,
    min: number | string,
    max: number | string,
    limit: "LIMIT",
    offset: number,
    count: number
  ): Promise<string[]>
  multi(): RedisMultiLike
}

export interface RedisMenuStorageOptions {
  /** Prefix for every key this driver writes. Default `"menu:"`. */
  prefix?: string
}

/**
 * Redis storage, using an ioredis client you create.
 *
 * ```ts
 * import Redis from "ioredis"
 * menu({ storage: () => new RedisMenuStorage(new Redis(process.env.REDIS_URL!)) })
 * ```
 *
 * Layout: one JSON string per view, plus sets indexing views by menu+key, menu and channel, a
 * message-id lookup and a sorted set of expiry times. Index entries pointing at missing views are
 * cleaned up as they are found.
 */
export class RedisMenuStorage implements MenuStorage {
  private readonly prefix: string

  constructor(
    private readonly redis: RedisLike,
    options: RedisMenuStorageOptions = {}
  ) {
    this.prefix = options.prefix ?? "menu:"
  }

  private viewKey(id: string) {
    return `${this.prefix}view:${id}`
  }
  private keyIndex(menu: string, key: string) {
    return `${this.prefix}key:${menu}:${key}`
  }
  private menuIndex(menu: string) {
    return `${this.prefix}menu:${menu}`
  }
  private channelIndex(channelId: string) {
    return `${this.prefix}channel:${channelId}`
  }
  private messageKey(messageId: string) {
    return `${this.prefix}message:${messageId}`
  }
  private get expiryIndex() {
    return `${this.prefix}expiry`
  }

  async get(id: string): Promise<ViewRecord | null> {
    return parse(await this.redis.get(this.viewKey(id)))
  }

  async save(view: ViewRecord): Promise<void> {
    const old = await this.get(view.id)
    const multi = this.redis.multi()
    if (old) this.removeIndexes(multi, old, view)
    multi.set(this.viewKey(view.id), JSON.stringify(view))
    multi.sadd(this.keyIndex(view.menu, view.key), view.id)
    multi.sadd(this.menuIndex(view.menu), view.id)
    if (view.channelId) multi.sadd(this.channelIndex(view.channelId), view.id)
    if (view.messageId) multi.set(this.messageKey(view.messageId), view.id)
    if (view.expiresAt !== null) {
      multi.zadd(this.expiryIndex, view.expiresAt, view.id)
    } else {
      multi.zrem(this.expiryIndex, view.id)
    }
    await multi.exec()
  }

  async delete(id: string): Promise<void> {
    const old = await this.get(id)
    const multi = this.redis.multi()
    multi.del(this.viewKey(id))
    multi.zrem(this.expiryIndex, id)
    if (old) this.removeIndexes(multi, old, null)
    await multi.exec()
  }

  /** Remove index entries of `old` that `next` no longer matches (all of them when `next` is null). */
  private removeIndexes(multi: RedisMultiLike, old: ViewRecord, next: ViewRecord | null) {
    if (!next || next.menu !== old.menu || next.key !== old.key) {
      multi.srem(this.keyIndex(old.menu, old.key), old.id)
    }
    if (!next || next.menu !== old.menu) {
      multi.srem(this.menuIndex(old.menu), old.id)
    }
    if (old.channelId && (!next || next.channelId !== old.channelId)) {
      multi.srem(this.channelIndex(old.channelId), old.id)
    }
    if (old.messageId && (!next || next.messageId !== old.messageId)) {
      multi.del(this.messageKey(old.messageId))
    }
  }

  async findByKey(menu: string, key: string): Promise<ViewRecord[]> {
    return this.fromSet(this.keyIndex(menu, key))
  }

  async findByMenu(menu: string): Promise<ViewRecord[]> {
    return this.fromSet(this.menuIndex(menu))
  }

  async findByChannel(channelId: string): Promise<ViewRecord[]> {
    return this.fromSet(this.channelIndex(channelId))
  }

  async findByMessage(messageId: string): Promise<ViewRecord | null> {
    const id = await this.redis.get(this.messageKey(messageId))
    return id ? this.get(id) : null
  }

  async findExpired(now: number, limit: number): Promise<ViewRecord[]> {
    const ids = await this.redis.zrangebyscore(this.expiryIndex, "-inf", now, "LIMIT", 0, limit)
    const views = await this.load(ids)
    return views.filter((v): v is ViewRecord => v !== null)
  }

  private async fromSet(setKey: string): Promise<ViewRecord[]> {
    const ids = await this.redis.smembers(setKey)
    const views = await this.load(ids)
    const stale = ids.filter((_, i) => views[i] === null)
    if (stale.length) await this.redis.srem(setKey, ...stale)
    return views.filter((v): v is ViewRecord => v !== null)
  }

  private async load(ids: string[]): Promise<(ViewRecord | null)[]> {
    if (!ids.length) return []
    const raw = await this.redis.mget(...ids.map(id => this.viewKey(id)))
    return raw.map(parse)
  }
}

function parse(raw: string | null | undefined): ViewRecord | null {
  if (!raw) return null
  try {
    return JSON.parse(raw) as ViewRecord
  } catch {
    return null
  }
}
