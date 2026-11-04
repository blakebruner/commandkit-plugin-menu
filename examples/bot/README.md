# Example bot

A small CommandKit bot showing the menu plugin:

- `/ticket` creates a ticket channel with a **live public panel** (claim, manage, close).
  "Manage" opens a **lazy ephemeral** view with a modal for notes; saving a note updates the
  public panel for everyone.
- `/play <song>` and `/queue` show a **paginated** queue that updates for every viewer when the
  queue changes.

Views are stored in SQLite (`menus.db`), so restart the bot and click an old button: it still works.

```sh
cp .env.example .env   # add your bot token
bun install
bun run dev
```
