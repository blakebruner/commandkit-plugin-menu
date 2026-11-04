import type { ViewRecord } from "../types"
import { clone } from "../utils"
import type { MenuStorage } from "./types"

/**
 * In-process storage. Fine for development and tests, but views are lost when the bot restarts, so
 * old buttons answer with the "expired" message.
 */
export class MemoryMenuStorage implements MenuStorage {
  private views = new Map<string, ViewRecord>()

  async get(id: string): Promise<ViewRecord | null> {
    const view = this.views.get(id)
    return view ? clone(view) : null
  }

  async save(view: ViewRecord): Promise<void> {
    this.views.set(view.id, clone(view))
  }

  async delete(id: string): Promise<void> {
    this.views.delete(id)
  }

  async findByKey(menu: string, key: string): Promise<ViewRecord[]> {
    return this.filter(v => v.menu === menu && v.key === key)
  }

  async findByMenu(menu: string): Promise<ViewRecord[]> {
    return this.filter(v => v.menu === menu)
  }

  async findByChannel(channelId: string): Promise<ViewRecord[]> {
    return this.filter(v => v.channelId === channelId)
  }

  async findByMessage(messageId: string): Promise<ViewRecord | null> {
    return this.filter(v => v.messageId === messageId)[0] ?? null
  }

  async findExpired(now: number, limit: number): Promise<ViewRecord[]> {
    return this.filter(v => v.expiresAt !== null && v.expiresAt <= now)
      .sort((a, b) => a.expiresAt! - b.expiresAt!)
      .slice(0, limit)
  }

  /** Number of stored views (handy in tests). */
  get size(): number {
    return this.views.size
  }

  private filter(predicate: (view: ViewRecord) => boolean): ViewRecord[] {
    const out: ViewRecord[] = []
    for (const view of this.views.values()) {
      if (predicate(view)) out.push(clone(view))
    }
    return out
  }
}
