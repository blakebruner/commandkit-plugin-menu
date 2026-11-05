# commandkit-plugin-menu

Live, persistent [Components V2](https://discord.com/developers/docs/components/overview) menus for
[CommandKit](https://commandkit.dev).

- **Menus update themselves.** Change your data, call `invalidate()`, and every open copy of the
  menu re-renders: public panels, other users' views, all of them.
- **Buttons survive restarts.** Each message is stored as a small *view* record (Redis or SQLite).
  Buttons only carry the view id, so a click after a deploy or crash works exactly like before.
- **Pagination built in**, plus single-page panels, per-view state, modals, select menus, item
  actions and in-place navigation between menus.
- **Write menus in JSX** (CommandKit's components), discord.js builders or raw API JSON.

```tsx
// src/app/menus/ticket-panel.tsx
import { ActionRow, Button, Container, TextDisplay } from "commandkit"
import { defineMenu } from "commandkit-plugin-menu"
import { ButtonStyle } from "discord.js"

export default defineMenu({
  name: "ticket-panel",
  key: (params: { ticketId: string }) => params.ticketId,
  load: params => db.ticket.findUniqueOrThrow({ where: { id: params.ticketId } }),
  render: ({ data: ticket, id }) => (
    <Container>
      <TextDisplay content={`## Ticket #${ticket.number}\nStatus: ${ticket.status}`} />
      <ActionRow>
        <Button customId={id("claim")} style={ButtonStyle.Success}>Claim</Button>
      </ActionRow>
    </Container>
  ),
  actions: {
    claim: async ctx => {
      await db.ticket.update({ where: { id: ctx.params.ticketId }, data: { status: "claimed" } })
      ctx.invalidate() // every other open view of this ticket updates too
    }
  }
})
```

```ts
// anywhere: a command, an event, a task...
await ticketPanel.send(channel, { ticketId })        // post a public panel
await ticketPanel.reply(interaction, { ticketId })    // reply with it
await ticketPanel.invalidate({ ticketId })            // push fresh data to every open copy
```

## Install

```sh
bun add commandkit-plugin-menu   # or npm / pnpm / yarn
```

Requires `commandkit` 1.2+ and `discord.js` 14.19+.

```ts
// commandkit.config.ts
import { defineConfig } from "commandkit/config"
import { menu, SqliteMenuStorage } from "commandkit-plugin-menu"

export default defineConfig({
  plugins: [
    menu({ storage: () => SqliteMenuStorage.open("./menus.db") })
  ]
})
```

Put menus in `src/app/menus/` (subfolders are fine; files starting with `_` are skipped). Every
exported menu in those files is registered at startup, which is what lets old buttons find their menu
after a restart.

### Storage

| Driver | Survives restarts | Notes |
| --- | --- | --- |
| `SqliteMenuStorage.open(path)` | ✅ | Uses `bun:sqlite` on Bun, `node:sqlite` on Node 22.5+. No extra dependency. |
| `new SqliteMenuStorage(db)` | ✅ | Pass any sync SQLite handle, e.g. `better-sqlite3`. |
| `new RedisMenuStorage(redis)` | ✅ | Pass an [ioredis](https://github.com/redis/ioredis) client. Works across shards/processes. |
| `MemoryMenuStorage` (default) | ❌ | Old buttons answer "this menu has expired" after a restart. |

```ts
import Redis from "ioredis"
menu({ storage: () => new RedisMenuStorage(new Redis(process.env.REDIS_URL!)) })

// or set it from your own code, reusing an existing connection:
import { setMenuStorage } from "commandkit-plugin-menu"
setMenuStorage(new RedisMenuStorage(redis))
```

A custom driver (Prisma, Mongo, ...) only has to implement the small
[`MenuStorage`](src/storage/types.ts) interface.

## How updates reach people

Every rendered message is a **view**. Views that show the same data share a **key** (from
`key(params)`). `invalidate(params)` re-renders every view with that key; rapid calls are merged
into a single push (250 ms debounce by default), and data is loaded once per push, not once per
message.

Each menu picks an update mode, separately for public and ephemeral messages if you want:

| Mode | On `invalidate()` | Use it for |
| --- | --- | --- |
| `"live"` (default) | Messages are edited right away | Public panels, queues, dashboards |
| `"lazy"` | Nothing is sent; the menu re-renders with fresh data the next time someone clicks it | Ephemeral views nobody may still have open, very busy menus |

```ts
defineMenu({
  name: "ticket-manage",
  updates: { public: "live", ephemeral: "lazy" },
  // ...
})
```

**Ephemeral (hidden) messages have a hard Discord limit:** the bot can only edit them with an
interaction token, which expires 15 minutes after the interaction. The plugin keeps the latest token
for each ephemeral view (every click renews it), pushes to the view while the token is valid, and
falls back to refresh-on-click after that. Public messages have no such limit: while a token is
fresh they're edited through it too (so replies in channels the bot can't read still update), and
after that through the channel.

`invalidate(params, { force: true })` pushes to lazy views too.

## Defining menus

### `defineMenu(config)`

| Option | Description |
| --- | --- |
| `name` | Unique name, stored with each view. Renaming a menu expires its open messages. |
| `key(params)` | Which data a view shows. Defaults to the params themselves. |
| `load(params, { client })` | Fetch the data to render. Runs on every render, so read from your source of truth. |
| `initialState(params)` | Per-view state for a new view (tab, filter, ...). JSON only. |
| `render(ctx)` | Return JSX, builders or API JSON. `ctx` has `params`, `state`, `data`, `view`, `client` and `id()`. |
| `actions` | `{ name: ctx => ... }` handlers for buttons, selects and modals. |
| `updates` | `"live"` / `"lazy"` or `{ public, ephemeral }`. |
| `ephemeral` | Default for `.reply()`. |
| `access` | `"anyone"` (default), `"owner"` or `(ctx) => boolean \| string` (a string is shown as the denial message). |
| `replace` | When a new view opens, close older ones with the same key: `"owner"` (default for ephemeral), `"channel"` (one panel per channel) or `"none"` (default for public). |
| `ttl` | View lifetime in ms, or `{ public, ephemeral }`; `null` = forever. Defaults: public never, ephemeral 6 h. Clicks extend it. |
| `onExpire` | `"disable"` (default), `"delete"` or `"keep"` the message when the view expires. |
| `resyncOnStart` | Re-render this menu's live views when the bot starts, to catch changes made while it was down. |
| `debounce` | Debounce for `invalidate()` in ms. |

Params and state are stored, so they must be plain JSON: store ids, not discord.js objects. The
plugin throws a clear error if they aren't.

In `render`, wire components to actions with `ctx.id(action, arg?)`:

```tsx
<Button customId={id("remove", track.id)} style={ButtonStyle.Secondary}>Remove</Button>
```

The `arg` (an item id, a page number, ...) comes back as `ctx.arg`. Custom ids must be unique per
message and at most 100 characters; the plugin checks both and explains what to change.

### `definePaginatedMenu(config)`

Everything above, plus:

| Option | Description |
| --- | --- |
| `perPage` | Items per page (default 5). |
| `items(data, ctx)` | Pick the list out of `load()`'s result. Defaults to the result itself. |
| `renderItem(item, index, ctx)` | Render one item. `index` is its position in the full list. |
| `renderHeader(ctx)` / `renderFooter(ctx)` / `renderEmpty(ctx)` | Optional sections. |
| `color` | Container accent color. |
| `navigation` | Override buttons, labels, the page indicator or the jump select for this menu. |

The page is stored per view (in `state.page`), so two people can page through the same queue
independently, and a page shrinks back into range when items are removed.

```tsx
export default definePaginatedMenu({
  name: "music-queue",
  key: (params: { guildId: string }) => params.guildId,
  load: params => getQueue(params.guildId),
  items: queue => queue.upcoming,
  perPage: 5,
  ephemeral: true,
  renderHeader: ({ data }) => <TextDisplay content={`Now playing: ${data.current?.title ?? "nothing"}`} />,
  renderItem: (track, index, { id }) => (
    <Section>
      <TextDisplay content={`${index + 1}. ${track.title}`} />
      <Button customId={id("remove", track.id)} style={ButtonStyle.Secondary}>Remove</Button>
    </Section>
  ),
  actions: {
    remove: ctx => {
      removeTrack(ctx.params.guildId, ctx.arg!)
      ctx.invalidate()
    }
  }
})

// lavalink-client: keep every open queue in sync
manager.on("trackStart", player => musicQueue.invalidate({ guildId: player.guildId }))
```

### Actions

```ts
actions: {
  async rename(ctx) {
    ctx.params          // the view's params
    ctx.state           // current state; ctx.setState({ ... }) to change it
    ctx.arg             // arg from ctx.id(action, arg)
    ctx.values          // select menu values
    ctx.fields          // modal fields (for modal submits)
    await ctx.load()    // the menu's data (cached for this action)

    ctx.invalidate()    // after this action, refresh every other view with the same key
    ctx.reply("Saved!") // ephemeral follow-up, sent after the menu updates
    ctx.open(otherMenu, params, { ephemeral: true })  // open another menu as a follow-up
    ctx.navigate(otherMenu, params)                    // swap this message to another menu
    ctx.close("disable" | "delete" | "keep")          // end this view
    await ctx.showModal(modal)                          // call first, before slow work
  }
}
```

After the action, the menu re-renders and the clicked message is updated in place. Slow actions are
auto-acknowledged after 2 seconds so Discord doesn't show "interaction failed". Clicks on the same
view are handled one at a time, so concurrent clicks never lose state.

Prefer `ctx.reply()` over answering `ctx.interaction` yourself. If an action does call
`interaction.reply()` / `deferReply()`, it must do so within those 2 seconds; the menu message is
then updated through a normal push instead.

Modals: give the modal `customId={ctx.id("save")}` and the submit is routed to the `save` action
of the same view, which then updates the message.

## Opening, updating and closing

Each definition has typed helpers, and there are equivalent functions that take a menu name:

| Definition helper | Function | |
| --- | --- | --- |
| `menu.reply(interaction, params?, options?)` | `replyMenu(interaction, name, params?, options?)` | Reply (or edit a deferred reply, or follow up). |
| `menu.send(channel, params?, options?)` | `sendMenu(channel, name, params?, options?)` | Post as a new public message. |
| `menu.invalidate(params?, options?)` | `invalidateMenu(name, params?, options?)` | Push fresh renders. No params = every view of the menu. |
| `menu.close(params?, mode?)` | `closeMenu(name, params?, mode?)` | Close views (`"disable"`, `"delete"` or `"keep"`). |
| `menu.views(params?)` | | List open views. |

`options` for `reply`/`send`: `ephemeral`, `state` (merged over `initialState`) and `ownerId`.

Views are cleaned up automatically when their message or channel is deleted (needs the
`GuildMessages` intent for message deletes), when an edit says the message is gone, and when they
expire.

## Plugin options

```ts
menu({
  storage,                 // see above
  directory: "menus",      // folder inside src/app
  prefix: "menu",          // custom id prefix
  debounce: 250,           // ms
  ttl: { public: null, ephemeral: 6 * 60 * 60 * 1000 },
  onExpire: "disable",
  sweepInterval: 60_000,   // how often expired views are cleaned up
  concurrency: 4,          // parallel edits per push
  deferAfter: 2000,        // auto-acknowledge slow actions after this many ms
  resyncOnStart: false,    // re-render every live view of every menu on startup
  messages: { expired: "...", forbidden: "...", error: "..." },
  navigation: {            // pagination controls: a button row, then a jump select
    first: { emoji: "⏪", style: ButtonStyle.Primary },
    previous: { emoji: "◀️", style: ButtonStyle.Primary },
    next: { emoji: "▶️", style: ButtonStyle.Primary },
    last: { emoji: "⏩", style: ButtonStyle.Primary },
    wrap: true,            // previous on page 1 goes to the last page, next on the last to page 1
    jump: true,            // jump select whenever there's more than one page ("auto" = more than 3)
    jumpWindow: 20,        // the select lists this many nearby pages, centred on the current one
    jumpPlaceholder: "🔄 Jump to a page ({page} / {pages})",
    jumpOption: "Page {page}",
    indicator: false       // optional small text above the buttons, e.g. "-# Page {page} of {pages}"
  }
})
```

In `commandkit dev`, editing a file in `src/app/menus` hot-reloads it and re-renders open messages
with the new code.

## How it works

A custom id looks like `menu:<viewId>:<action>[:<arg>]`. The view id points at a stored record:

```
{ id, menu, key, params, state, ephemeral, channelId, messageId,
  token, tokenExpiresAt, ownerId, expiresAt, ... }
```

On a click the plugin loads the record, runs the action, renders the menu from `load()` + state and
updates the message. On `invalidate()` it finds every record with that key and edits each message
(public messages through the channel, ephemeral ones through the stored interaction token). Nothing
about a view lives only in memory, which is why restarts and multiple processes just work.

## Example bot

[`examples/bot`](examples/bot) has a ticket system (live public panel + lazy private management
view with a modal) and a paginated music queue.

## Migrating from 0.1

0.2 is a rewrite. The main renames:

| 0.1 | 0.2 |
| --- | --- |
| `paginationMenu({ ... })` | `definePaginatedMenu({ ... })` |
| `createKey(params)` | `key(params)` |
| `fetch(params)` | `load(params)` (+ `items(data)` for paginated menus) |
| `onSessionStart(params)` → `sessionData` | `initialState(params)` → `state` (per view) |
| `renderTitle` | `renderHeader` |
| `sessionOptions.ephemeral` / `.ttl` / `.mode` | `ephemeral` / `ttl` / `access` + `replace` |
| auto-rewritten `customId="ping"` | `customId={id("ping")}` |
| `menuQueue.sendUpdate({ menu, params })` | `menu.invalidate(params)` / `invalidateMenu(name, params)` |

## License

MIT
