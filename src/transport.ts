import {
  type APIMessage,
  type Client,
  MessageFlags,
  type MessageMentionOptions,
  MessagePayload,
  type RawFile,
  Routes
} from "discord.js"
import type { RenderedMenu } from "./render"
import type { MenuFile } from "./types"

/** Where an existing menu message lives. */
export type MessageTarget =
  | { kind: "channel"; channelId: string; messageId: string }
  | { kind: "webhook"; applicationId: string; token: string; messageId: string }

/**
 * Sends and edits menu messages outside of an interaction response (pushes, sweeps, closes).
 * The default goes straight to Discord's REST API; tests swap in a fake.
 */
export interface MenuTransport {
  send(channelId: string, menu: RenderedMenu): Promise<{ id: string }>
  edit(target: MessageTarget, menu: RenderedMenu): Promise<void>
  delete(target: MessageTarget): Promise<void>
}

export class DiscordTransport implements MenuTransport {
  constructor(private readonly client: Client) {}

  async send(channelId: string, menu: RenderedMenu): Promise<{ id: string }> {
    const files = await resolveFiles(menu.files)
    const message = (await this.client.rest.post(Routes.channelMessages(channelId), {
      body: messageBody(menu, files),
      files: files.length ? files : undefined
    })) as APIMessage
    return { id: message.id }
  }

  async edit(target: MessageTarget, menu: RenderedMenu): Promise<void> {
    const files = await resolveFiles(menu.files)
    await this.client.rest.patch(route(target), {
      body: messageBody(menu, files),
      files: files.length ? files : undefined,
      auth: target.kind === "channel"
    })
  }

  async delete(target: MessageTarget): Promise<void> {
    await this.client.rest.delete(route(target), { auth: target.kind === "channel" })
  }
}

function route(target: MessageTarget) {
  return target.kind === "channel"
    ? Routes.channelMessage(target.channelId, target.messageId)
    : Routes.webhookMessage(target.applicationId, target.token, target.messageId)
}

function messageBody(menu: RenderedMenu, files: RawFile[]) {
  const body: Record<string, unknown> = {
    components: menu.components,
    flags: MessageFlags.IsComponentsV2,
    allowed_mentions: allowedMentionsToAPI(menu.allowedMentions)
  }
  if (files.length) {
    body.attachments = files.map((file, id) => ({ id, filename: file.name }))
  }
  return body
}

export function allowedMentionsToAPI(mentions: MessageMentionOptions) {
  return {
    parse: mentions.parse,
    roles: mentions.roles,
    users: mentions.users,
    replied_user: mentions.repliedUser
  }
}

export async function resolveFiles(files: MenuFile[]): Promise<RawFile[]> {
  return Promise.all(
    files.map(async file => {
      if ("data" in file && "name" in file && !("attachment" in file)) {
        return { name: file.name, data: file.data, contentType: file.contentType }
      }
      return MessagePayload.resolveFile(file as Parameters<typeof MessagePayload.resolveFile>[0])
    })
  )
}
