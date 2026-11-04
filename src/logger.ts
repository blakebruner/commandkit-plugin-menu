import { Logger } from "commandkit"

const PREFIX = "[menu]"

/** Thin wrapper so every plugin log line is tagged. */
export const log = {
  debug: (message: string) => Logger.debug(`${PREFIX} ${message}`),
  info: (message: string) => Logger.info(`${PREFIX} ${message}`),
  warn: (message: string) => Logger.warn(`${PREFIX} ${message}`),
  error: (message: string) => Logger.error(`${PREFIX} ${message}`)
}
