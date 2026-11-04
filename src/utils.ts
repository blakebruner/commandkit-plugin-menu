import { randomBytes } from "node:crypto"

const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

/** Short url-safe random id (base62). 10 chars is ~59 bits, plenty for live views. */
export function randomId(length = 10): string {
  const bytes = randomBytes(length)
  let out = ""
  for (let i = 0; i < length; i++) {
    out += ALPHABET[bytes[i]! % ALPHABET.length]
  }
  return out
}

/** JSON.stringify with sorted object keys, so equal params always produce the same key. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value)) ?? "null"
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys)
  }
  if (value && typeof value === "object" && !(value instanceof Date)) {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as object).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key])
    }
    return out
  }
  return value
}

/** Throw a helpful error when params or state can't round-trip through JSON storage. */
export function assertSerializable(value: unknown, what: string): void {
  const seen = new Set<unknown>()
  const walk = (v: unknown, path: string): void => {
    if (v === null || v === undefined) return
    const type = typeof v
    if (type === "string" || type === "number" || type === "boolean") return
    if (type === "bigint") {
      throw new TypeError(`${what} must be JSON-serializable: ${path} is a bigint (use a string)`)
    }
    if (type === "function" || type === "symbol") {
      throw new TypeError(`${what} must be JSON-serializable: ${path} is a ${type}`)
    }
    if (seen.has(v)) {
      throw new TypeError(`${what} must be JSON-serializable: ${path} is a circular reference`)
    }
    seen.add(v)
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) walk(v[i], `${path}[${i}]`)
    } else if (!(v instanceof Date)) {
      const proto = Object.getPrototypeOf(v)
      if (proto !== Object.prototype && proto !== null) {
        throw new TypeError(
          `${what} must be plain JSON data: ${path} is a ${proto?.constructor?.name ?? "class instance"}. ` +
            "Store ids instead of discord.js objects."
        )
      }
      for (const [key, item] of Object.entries(v as object)) walk(item, `${path}.${key}`)
    }
    seen.delete(v)
  }
  walk(value, what)
}

export function clone<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T)
}

/** Run async tasks with at most `limit` in flight. */
export async function mapLimit<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>
): Promise<void> {
  let index = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const item = items[index++]!
      await fn(item)
    }
  })
  await Promise.all(workers)
}

/** Read a Discord API error code from a discord.js DiscordAPIError (or anything shaped like one). */
export function discordErrorCode(error: unknown): number | null {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code: unknown }).code
    return typeof code === "number" ? code : null
  }
  return null
}

/** Store a singleton on globalThis, so duplicate copies of this package share one instance. */
export function globalSingleton<T>(name: string, create: () => T): T {
  const key = Symbol.for(`commandkit-plugin-menu.${name}`)
  const store = globalThis as unknown as Record<symbol, T | undefined>
  let value = store[key]
  if (value === undefined) {
    value = create()
    store[key] = value
  }
  return value
}
