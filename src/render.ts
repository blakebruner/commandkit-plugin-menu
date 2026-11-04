import { ButtonStyle, ComponentType, type MessageMentionOptions } from "discord.js"
import { MAX_CUSTOM_ID_LENGTH } from "./custom-id"
import type { ComponentTree, MenuFile, MenuOutput } from "./types"

/** A rendered menu, ready to send. `components` is raw API JSON. */
export interface RenderedMenu {
  components: Record<string, any>[]
  files: MenuFile[]
  allowedMentions: MessageMentionOptions
}

/** Mentions are off by default: a menu re-rendering every few seconds should never ping anyone. */
export const DEFAULT_ALLOWED_MENTIONS: MessageMentionOptions = { parse: [] }

function isPayloadObject(value: unknown): value is {
  components: ComponentTree
  files?: MenuFile[]
  allowedMentions?: MessageMentionOptions
} {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    "components" in value &&
    !("type" in value) &&
    typeof (value as { toJSON?: unknown }).toJSON !== "function"
  )
}

/** Flatten fragments/arrays and convert builders to API JSON. */
export function toComponentJSON(tree: ComponentTree): Record<string, any>[] {
  const out: Record<string, any>[] = []
  const visit = (node: ComponentTree): void => {
    if (node === null || node === undefined || node === false) return
    if (Array.isArray(node)) {
      for (const child of node) visit(child)
      return
    }
    const json =
      typeof (node as { toJSON?: unknown }).toJSON === "function"
        ? (node as { toJSON(): unknown }).toJSON()
        : node
    if (Array.isArray(json)) {
      for (const child of json) visit(child as ComponentTree)
      return
    }
    if (!json || typeof json !== "object") {
      throw new TypeError(`Menu render returned an invalid component: ${String(json)}`)
    }
    out.push(json as Record<string, any>)
  }
  visit(tree)
  return out
}

export function normalizeOutput(output: MenuOutput): RenderedMenu {
  if (isPayloadObject(output)) {
    return {
      components: toComponentJSON(output.components),
      files: output.files ?? [],
      allowedMentions: output.allowedMentions ?? DEFAULT_ALLOWED_MENTIONS
    }
  }
  return {
    components: toComponentJSON(output as ComponentTree),
    files: [],
    allowedMentions: DEFAULT_ALLOWED_MENTIONS
  }
}

/** Visit every component object in an API component tree (containers, sections, accessories, rows). */
export function walkComponents(
  components: unknown,
  visit: (component: Record<string, any>) => void
): void {
  if (Array.isArray(components)) {
    for (const c of components) walkComponents(c, visit)
    return
  }
  if (!components || typeof components !== "object") return
  const component = components as Record<string, any>
  if (typeof component.type === "number") visit(component)
  if (component.components) walkComponents(component.components, visit)
  if (component.accessory) walkComponents(component.accessory, visit)
  if (component.component) walkComponents(component.component, visit)
}

/** Discord rejects messages with duplicate or over-long custom ids; report it with a clear message. */
export function validateCustomIds(menu: string, components: Record<string, any>[]): void {
  const seen = new Set<string>()
  walkComponents(components, component => {
    const id = component.custom_id
    if (typeof id !== "string") return
    if (id.length > MAX_CUSTOM_ID_LENGTH) {
      throw new Error(
        `Menu "${menu}": custom id "${id}" is longer than ${MAX_CUSTOM_ID_LENGTH} chars`
      )
    }
    if (seen.has(id)) {
      throw new Error(
        `Menu "${menu}": custom id "${id}" is used twice in one message. Discord needs unique ids; ` +
          "pass an arg to ctx.id(action, arg), for example the item id."
      )
    }
    seen.add(id)
  })
}

const SELECT_TYPES = new Set<number>([
  ComponentType.StringSelect,
  ComponentType.UserSelect,
  ComponentType.RoleSelect,
  ComponentType.MentionableSelect,
  ComponentType.ChannelSelect
])

/** Return a deep copy with every interactive component disabled (link buttons stay usable). */
export function disableComponents(components: Record<string, any>[]): Record<string, any>[] {
  const copy = JSON.parse(JSON.stringify(components)) as Record<string, any>[]
  walkComponents(copy, component => {
    if (component.type === ComponentType.Button) {
      if (component.style !== ButtonStyle.Link && component.style !== ButtonStyle.Premium) {
        component.disabled = true
      }
    } else if (SELECT_TYPES.has(component.type)) {
      component.disabled = true
    }
  })
  return copy
}
