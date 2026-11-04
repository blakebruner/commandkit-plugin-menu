import type {
  APIMessageTopLevelComponent,
  AttachmentBuilder,
  Awaitable,
  Client,
  MessageComponentInteraction,
  MessageMentionOptions,
  ModalSubmitFields,
  ModalSubmitInteraction,
  User
} from "discord.js"

/**
 * How a view reacts when its data changes.
 *
 * - `"live"`: `invalidate()` pushes a fresh render to every tracked message right away.
 * - `"lazy"`: `invalidate()` leaves the message alone. The menu re-renders with fresh data the next
 *   time someone clicks it. Good for ephemeral menus nobody may still have open, or busy panels where
 *   an instant push isn't worth the API calls.
 */
export type UpdateMode = "live" | "lazy"

/** Update mode for public messages and for ephemeral (hidden) messages. */
export interface UpdatePolicy {
  public: UpdateMode
  ephemeral: UpdateMode
}

/** What happens to the old views when a new one is opened for the same menu and key. */
export type ReplacePolicy = "owner" | "channel" | "none"

/** What happens to the Discord message when a view expires or is closed. */
export type CloseMode = "disable" | "delete" | "keep"

/**
 * Everything the plugin remembers about one rendered menu message. This record is what makes a
 * menu survive a restart: buttons only carry the view id, and the rest is read from storage.
 */
export interface ViewRecord {
  /** Short random id, embedded in every custom id on the message. */
  id: string
  /** Menu name (the `name` from `defineMenu`). */
  menu: string
  /** Data key from the menu's `key(params)`. Views that share a key share data and updates. */
  key: string
  /** JSON-serializable params the menu was opened with. */
  params: unknown
  /** JSON-serializable per-view state (current page, selected tab, ...). */
  state: unknown
  ephemeral: boolean
  /** User who opened the menu, if any. */
  ownerId: string | null
  guildId: string | null
  channelId: string | null
  /** Message id. Set for public messages, and for ephemeral ones when Discord returned it. */
  messageId: string | null
  /** Application id, used to edit ephemeral messages through the interaction webhook. */
  applicationId: string | null
  /** Latest interaction token for an ephemeral view. Valid for 15 minutes after the interaction. */
  token: string | null
  /** Which message the token edits: `"@original"` or a follow-up message id. */
  tokenTarget: string | null
  tokenExpiresAt: number | null
  createdAt: number
  updatedAt: number
  /** When the view is dropped by the sweeper. `null` means never. */
  expiresAt: number | null
}

/** Anything with a `toJSON()` (discord.js builders, CommandKit JSX output) or raw API JSON. */
export type ComponentLike =
  | { toJSON(): unknown }
  | APIMessageTopLevelComponent
  | Record<string, any>

/** A file to upload with the menu message. */
export type MenuFile =
  | AttachmentBuilder
  | { name: string; data: Buffer | Uint8Array | string; contentType?: string }

/** Nested arrays are allowed so JSX fragments can be returned directly. */
export type ComponentTree = ComponentLike | null | undefined | false | ComponentTree[]

/** What a menu's `render` may return. Menus always render as Components V2 messages. */
export type MenuOutput =
  | ComponentTree
  | {
      components: ComponentTree
      files?: MenuFile[]
      allowedMentions?: MessageMentionOptions
    }

/** Information about the view being rendered or interacted with. */
export interface ViewInfo {
  id: string
  menu: string
  key: string
  ephemeral: boolean
  ownerId: string | null
  guildId: string | null
  channelId: string | null
  messageId: string | null
}

export interface LoadContext {
  client: Client
}

export interface RenderContext<Params, State, Data> {
  params: Params
  state: State
  data: Data
  view: ViewInfo
  client: Client
  /**
   * Build a custom id that routes to one of this menu's actions.
   * @param action an action name from `actions`
   * @param arg optional extra value, e.g. an item id. Read it back as `ctx.arg` in the action.
   */
  id(action: string, arg?: string | number): string
}

export interface ActionContext<Params, State, Data> {
  interaction: MessageComponentInteraction | ModalSubmitInteraction
  user: User
  client: Client
  params: Params
  /** State before this action. Use `setState` to change it. */
  state: State
  /** The `arg` passed to `ctx.id(action, arg)` when the component was rendered. */
  arg: string | undefined
  /** Selected values for select menus, otherwise an empty array. */
  values: string[]
  /** Modal fields when the action came from a modal submit, otherwise `null`. */
  fields: ModalSubmitFields | null
  view: ViewInfo
  /** Merge a patch into this view's state. The menu re-renders after the action. */
  setState(patch: Partial<State> | ((state: State) => Partial<State>)): void
  /** Load the menu's data for these params (cached for the rest of the action). */
  load(): Promise<Data>
  /** Build a custom id for this view, e.g. for a modal this action shows. */
  id(action: string, arg?: string | number): string
  /**
   * Mark this menu's data as changed. Every other live view with the same key is re-rendered once the
   * action finishes. This view always re-renders anyway.
   */
  invalidate(options?: { force?: boolean }): void
  /** Send a follow-up message after the menu updates. Ephemeral unless `ephemeral: false`. */
  reply(message: string | (Record<string, any> & { ephemeral?: boolean })): void
  /** Show a modal. Must be called before any slow work, since Discord needs it within 3 seconds. */
  showModal(modal: { toJSON(): unknown } | Record<string, any>): Promise<void>
  /** Open another menu as a follow-up (for example a private management view from a public panel). */
  open(menu: string | { name: string }, params?: unknown, options?: OpenOptions): void
  /** Swap this message over to a different menu, in place. */
  navigate(menu: string | { name: string }, params?: unknown, state?: unknown): void
  /** Close this view: disable its components (default), delete the message, or leave it as is. */
  close(mode?: CloseMode): void
}

export type ActionHandler<Params, State, Data> = (
  ctx: ActionContext<Params, State, Data>
) => Awaitable<void>

/** `"anyone"`, `"owner"` (only the user who opened it), or a custom check. */
export type AccessRule<Params, State> =
  | "anyone"
  | "owner"
  | ((ctx: {
      user: User
      view: ViewInfo
      params: Params
      state: State
      interaction: MessageComponentInteraction | ModalSubmitInteraction
    }) => Awaitable<boolean | string>)

export interface TtlOptions {
  /** Lifetime of a public message view in ms. `null` = never expires. */
  public?: number | null
  /** Lifetime of an ephemeral view in ms. `null` = never expires. */
  ephemeral?: number | null
}

export interface OpenOptions {
  /** Send as an ephemeral (hidden) message. Defaults to the menu's `ephemeral` option. */
  ephemeral?: boolean
  /** Starting state, merged over `initialState`. */
  state?: Record<string, unknown>
  /** Owner of the view, used by `access: "owner"` and `replace: "owner"`. */
  ownerId?: string
}

export interface ViewRef {
  id: string
  menu: string
  key: string
  messageId: string | null
  channelId: string | null
  ephemeral: boolean
}
