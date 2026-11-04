import type { Client } from "discord.js"
import { MenuEngine } from "../src/engine"
import type { RenderedMenu } from "../src/render"
import { walkComponents } from "../src/render"
import type { MenuStorage } from "../src/storage/types"
import type { MenuTransport, MessageTarget } from "../src/transport"

let snowflake = 1000n
export const nextId = () => String(++snowflake)

export class FakeTransport implements MenuTransport {
  sent: Array<{ channelId: string; menu: RenderedMenu; id: string }> = []
  edits: Array<{ target: MessageTarget; menu: RenderedMenu }> = []
  deletes: MessageTarget[] = []
  /** Error to throw for the next edit/delete, e.g. `{ code: 10008 }`. */
  failNext: unknown = null

  async send(channelId: string, menu: RenderedMenu) {
    const id = nextId()
    this.sent.push({ channelId, menu, id })
    return { id }
  }
  async edit(target: MessageTarget, menu: RenderedMenu) {
    this.throwIfFailing()
    this.edits.push({ target, menu })
  }
  async delete(target: MessageTarget) {
    this.throwIfFailing()
    this.deletes.push(target)
  }
  private throwIfFailing() {
    if (this.failNext) {
      const error = this.failNext
      this.failNext = null
      throw error
    }
  }
}

export const fakeClient = { application: { id: "app-1" } } as unknown as Client

export function createEngine(storage?: MenuStorage) {
  const engine = new MenuEngine()
  engine.configure({ debounce: 5, deferAfter: 0, sweepInterval: 0 })
  if (storage) engine.setStorage(storage)
  const transport = new FakeTransport()
  engine.attachClient(fakeClient, transport)
  return { engine, transport }
}

type Call = { method: string; payload?: any }

interface FakeInteractionInit {
  kind?: "command" | "button" | "select" | "modal"
  customId?: string
  userId?: string
  values?: string[]
  fields?: Record<string, string>
  messageId?: string
  messageComponents?: any[]
  fromMessage?: boolean
  channelId?: string
  guildId?: string | null
}

/** A stand-in for a discord.js interaction that records how it was answered. */
export function fakeInteraction(init: FakeInteractionInit = {}) {
  const kind = init.kind ?? "command"
  const calls: Call[] = []
  const replyId = nextId()
  const self: any = {
    calls,
    id: nextId(),
    token: `token-${nextId()}`,
    applicationId: "app-1",
    createdTimestamp: Date.now(),
    customId: init.customId ?? "",
    user: { id: init.userId ?? "user-1" },
    guildId: init.guildId === undefined ? "guild-1" : init.guildId,
    channelId: init.channelId ?? "channel-1",
    deferred: false,
    replied: false,
    ephemeral: null as boolean | null,
    values: init.values ?? [],
    fields: init.fields
      ? { getTextInputValue: (name: string) => init.fields![name], fields: init.fields }
      : undefined,
    message:
      kind === "command" || (kind === "modal" && init.fromMessage === false)
        ? null
        : {
            id: init.messageId ?? nextId(),
            components: (init.messageComponents ?? []).map(c => ({ toJSON: () => c })),
            delete: async () => calls.push({ method: "message.delete" })
          },
    isMessageComponent: () => kind === "button" || kind === "select",
    isModalSubmit: () => kind === "modal",
    isAnySelectMenu: () => kind === "select",
    isFromMessage: () => kind === "modal" && init.fromMessage !== false,
    async reply(payload: any) {
      calls.push({ method: "reply", payload })
      self.replied = true
      self.ephemeral = Boolean((payload.flags ?? 0) & 64)
      return payload.withResponse ? { resource: { message: { id: replyId } } } : undefined
    },
    async fetchReply() {
      return { id: replyId }
    },
    async deferReply(payload: any) {
      calls.push({ method: "deferReply", payload })
      self.deferred = true
      self.ephemeral = Boolean((payload?.flags ?? 0) & 64)
    },
    async deferUpdate() {
      calls.push({ method: "deferUpdate" })
      self.deferred = true
    },
    async update(payload: any) {
      calls.push({ method: "update", payload })
      self.replied = true
    },
    async editReply(payload: any) {
      calls.push({ method: "editReply", payload })
      return { id: replyId }
    },
    async followUp(payload: any) {
      calls.push({ method: "followUp", payload })
      return { id: nextId() }
    },
    async deleteReply() {
      calls.push({ method: "deleteReply" })
    },
    async showModal(payload: any) {
      calls.push({ method: "showModal", payload })
      self.replied = true
    }
  }
  return self
}

/** All TextDisplay contents in a rendered component tree, in order. */
export function texts(components: any): string[] {
  const out: string[] = []
  walkComponents(components, c => {
    if (c.type === 10) out.push(c.content)
  })
  return out
}

/** All custom ids in a rendered component tree, in order. */
export function customIds(components: any): string[] {
  const out: string[] = []
  walkComponents(components, c => {
    if (typeof c.custom_id === "string") out.push(c.custom_id)
  })
  return out
}

export function findCustomId(components: any, action: string): string {
  const id = customIds(components).find(id => id.split(":")[2] === action)
  if (!id) throw new Error(`No component for action ${action} in ${customIds(components)}`)
  return id
}

export const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
