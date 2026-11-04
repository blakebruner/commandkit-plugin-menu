import { mkdirSync } from "node:fs"
import { dirname, resolve } from "node:path"
import type { ViewRecord } from "../types"
import type { MenuStorage } from "./types"

/** A prepared statement from bun:sqlite, node:sqlite or better-sqlite3. */
export interface SqliteStatementLike {
  run(...params: any[]): unknown
  get(...params: any[]): unknown
  all(...params: any[]): unknown[]
}

/** A database handle from bun:sqlite (`Database`), node:sqlite (`DatabaseSync`) or better-sqlite3. */
export interface SqliteDatabaseLike {
  prepare(sql: string): SqliteStatementLike
  exec(sql: string): unknown
  close?(): unknown
}

export interface SqliteMenuStorageOptions {
  /** Table name. Default `"menu_views"`. */
  table?: string
}

interface Row {
  data: string
}

/**
 * SQLite storage. Pass any synchronous SQLite handle, or let `SqliteMenuStorage.open(path)` pick the
 * built-in one for your runtime (`bun:sqlite` on Bun, `node:sqlite` on Node 22.5+).
 *
 * ```ts
 * menu({ storage: () => SqliteMenuStorage.open("./menus.db") })
 * ```
 */
export class SqliteMenuStorage implements MenuStorage {
  private readonly table: string
  private readonly stmts: Record<
    "get" | "upsert" | "delete" | "byKey" | "byMenu" | "byChannel" | "byMessage" | "expired",
    SqliteStatementLike
  >

  constructor(
    private readonly db: SqliteDatabaseLike,
    options: SqliteMenuStorageOptions = {}
  ) {
    this.table = options.table ?? "menu_views"
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(this.table)) {
      throw new Error(`Invalid SQLite table name: ${this.table}`)
    }
    const t = this.table
    db.exec(`
      CREATE TABLE IF NOT EXISTS ${t} (
        id TEXT PRIMARY KEY,
        menu TEXT NOT NULL,
        key TEXT NOT NULL,
        channel_id TEXT,
        message_id TEXT,
        expires_at INTEGER,
        data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS ${t}_menu_key ON ${t} (menu, key);
      CREATE INDEX IF NOT EXISTS ${t}_channel ON ${t} (channel_id);
      CREATE INDEX IF NOT EXISTS ${t}_message ON ${t} (message_id);
      CREATE INDEX IF NOT EXISTS ${t}_expires ON ${t} (expires_at);
    `)
    this.stmts = {
      get: db.prepare(`SELECT data FROM ${t} WHERE id = ?`),
      upsert: db.prepare(
        `INSERT INTO ${t} (id, menu, key, channel_id, message_id, expires_at, data)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET menu = excluded.menu, key = excluded.key,
           channel_id = excluded.channel_id, message_id = excluded.message_id,
           expires_at = excluded.expires_at, data = excluded.data`
      ),
      delete: db.prepare(`DELETE FROM ${t} WHERE id = ?`),
      byKey: db.prepare(`SELECT data FROM ${t} WHERE menu = ? AND key = ?`),
      byMenu: db.prepare(`SELECT data FROM ${t} WHERE menu = ?`),
      byChannel: db.prepare(`SELECT data FROM ${t} WHERE channel_id = ?`),
      byMessage: db.prepare(`SELECT data FROM ${t} WHERE message_id = ? LIMIT 1`),
      expired: db.prepare(
        `SELECT data FROM ${t} WHERE expires_at IS NOT NULL AND expires_at <= ? ORDER BY expires_at LIMIT ?`
      )
    }
  }

  /**
   * Open (or create) a database file with the runtime's built-in SQLite. On other runtimes, install
   * better-sqlite3 and pass `new SqliteMenuStorage(new Database(path))` instead.
   */
  static async open(path: string, options?: SqliteMenuStorageOptions): Promise<SqliteMenuStorage> {
    const db = await openBuiltinSqlite(path)
    try {
      db.exec("PRAGMA journal_mode = WAL")
    } catch {
      // in-memory databases and some builds don't support WAL; the default journal is fine
    }
    return new SqliteMenuStorage(db, options)
  }

  async get(id: string): Promise<ViewRecord | null> {
    return parse(this.stmts.get.get(id) as Row | undefined)
  }

  async save(view: ViewRecord): Promise<void> {
    this.stmts.upsert.run(
      view.id,
      view.menu,
      view.key,
      view.channelId ?? null,
      view.messageId ?? null,
      view.expiresAt ?? null,
      JSON.stringify(view)
    )
  }

  async delete(id: string): Promise<void> {
    this.stmts.delete.run(id)
  }

  async findByKey(menu: string, key: string): Promise<ViewRecord[]> {
    return parseAll(this.stmts.byKey.all(menu, key))
  }

  async findByMenu(menu: string): Promise<ViewRecord[]> {
    return parseAll(this.stmts.byMenu.all(menu))
  }

  async findByChannel(channelId: string): Promise<ViewRecord[]> {
    return parseAll(this.stmts.byChannel.all(channelId))
  }

  async findByMessage(messageId: string): Promise<ViewRecord | null> {
    return parse(this.stmts.byMessage.get(messageId) as Row | undefined)
  }

  async findExpired(now: number, limit: number): Promise<ViewRecord[]> {
    return parseAll(this.stmts.expired.all(now, limit))
  }

  async close(): Promise<void> {
    this.db.close?.()
  }
}

async function openBuiltinSqlite(path: string): Promise<SqliteDatabaseLike> {
  if (path !== ":memory:" && !path.startsWith("file:")) {
    // like most SQLite tools, create the folder for a new database file
    mkdirSync(dirname(resolve(path)), { recursive: true })
  }
  if (typeof process !== "undefined" && process.versions?.bun) {
    const mod: any = await import("bun:sqlite" as string)
    return new mod.Database(path, { create: true }) as SqliteDatabaseLike
  }
  let mod: any
  try {
    mod = await import("node:sqlite" as string)
  } catch (error) {
    throw new Error(
      "No built-in SQLite found (needs Bun or Node 22.5+). Install better-sqlite3 and pass " +
        "`new SqliteMenuStorage(new Database(path))` instead.",
      { cause: error }
    )
  }
  return new mod.DatabaseSync(path) as SqliteDatabaseLike
}

function parse(row: Row | null | undefined): ViewRecord | null {
  if (!row) return null
  try {
    return JSON.parse(row.data) as ViewRecord
  } catch {
    return null
  }
}

function parseAll(rows: unknown[]): ViewRecord[] {
  return rows.map(row => parse(row as Row)).filter((v): v is ViewRecord => v !== null)
}
