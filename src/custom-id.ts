/**
 * Custom id format: `<prefix>:<viewId>:<action>[:<arg>]`
 *
 * The id carries only the view id and the action. Everything else (menu, params, state) lives in
 * storage, so any process can handle a click, including one that just restarted.
 */

export const MAX_CUSTOM_ID_LENGTH = 100

/** Built-in actions (pagination and so on) start with `$` so they never clash with user actions. */
export const BUILTIN_ACTION_PREFIX = "$"

export interface ParsedCustomId {
  viewId: string
  action: string
  arg: string | undefined
}

export function validateActionName(name: string, menu: string): void {
  if (!name || /[:\s]/.test(name)) {
    throw new Error(
      `Menu "${menu}": action name "${name}" is invalid. Use letters, numbers, - or _ (no ":" or spaces).`
    )
  }
  if (name.startsWith(BUILTIN_ACTION_PREFIX)) {
    throw new Error(
      `Menu "${menu}": action names starting with "${BUILTIN_ACTION_PREFIX}" are reserved for built-in actions.`
    )
  }
}

export function encodeCustomId(
  prefix: string,
  viewId: string,
  action: string,
  arg?: string | number
): string {
  let id = `${prefix}:${viewId}:${action}`
  if (arg !== undefined && arg !== null && arg !== "") {
    id += `:${arg}`
  }
  if (id.length > MAX_CUSTOM_ID_LENGTH) {
    throw new Error(
      `Custom id for action "${action}" is ${id.length} characters; Discord allows ${MAX_CUSTOM_ID_LENGTH}. ` +
        "Pass a shorter arg (an id or index rather than a full value)."
    )
  }
  return id
}

export function decodeCustomId(prefix: string, customId: string): ParsedCustomId | null {
  if (!customId.startsWith(`${prefix}:`)) return null
  const rest = customId.slice(prefix.length + 1)
  const first = rest.indexOf(":")
  if (first <= 0) return null
  const viewId = rest.slice(0, first)
  const afterView = rest.slice(first + 1)
  const second = afterView.indexOf(":")
  const action = second === -1 ? afterView : afterView.slice(0, second)
  const arg = second === -1 ? undefined : afterView.slice(second + 1)
  if (!action) return null
  return { viewId, action, arg }
}
