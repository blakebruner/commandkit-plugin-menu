import type { ViewRecord } from "../types"

/**
 * Where views are kept. Pick a persistent driver (Redis or SQLite) so menus keep working after the
 * bot restarts; the memory driver forgets everything on restart.
 *
 * Drivers only store records and look them up. All menu logic lives in the engine, so a custom driver
 * (Prisma, Mongo, ...) only has to implement these methods.
 */
export interface MenuStorage {
  get(id: string): Promise<ViewRecord | null>
  /** Insert or replace a view, keeping lookups by key, menu, channel and message in sync. */
  save(view: ViewRecord): Promise<void>
  delete(id: string): Promise<void>
  findByKey(menu: string, key: string): Promise<ViewRecord[]>
  findByMenu(menu: string): Promise<ViewRecord[]>
  findByChannel(channelId: string): Promise<ViewRecord[]>
  findByMessage(messageId: string): Promise<ViewRecord | null>
  /** Views whose `expiresAt` is at or before `now`, oldest first. */
  findExpired(now: number, limit: number): Promise<ViewRecord[]>
  close?(): Promise<void>
}
