import { defineConfig } from "commandkit/config"
import { menu, SqliteMenuStorage } from "commandkit-plugin-menu"

export default defineConfig({
  plugins: [
    menu({
      // Views are stored in SQLite, so buttons keep working after a restart.
      // Swap for `new RedisMenuStorage(new Redis(process.env.REDIS_URL))` to use Redis instead.
      storage: () => SqliteMenuStorage.open("./menus.db")
    })
  ]
})
