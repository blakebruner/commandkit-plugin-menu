import type {
  AccessRule,
  ActionHandler,
  CloseMode,
  LoadContext,
  MenuOutput,
  RenderContext,
  ReplacePolicy,
  TtlOptions,
  UpdateMode,
  UpdatePolicy
} from "./types"

export const MENU_BRAND = Symbol.for("commandkit-plugin-menu.definition")

/** The normalized form of a menu that the engine works with. */
export interface MenuRuntime {
  name: string
  kind: string
  key(params: unknown): string
  load(params: unknown, ctx: LoadContext): Promise<unknown>
  initialState(params: unknown): Record<string, unknown>
  render(ctx: RenderContext<any, any, any>): Promise<MenuOutput>
  actions: Map<string, ActionHandler<any, any, any>>
  updates: UpdatePolicy
  access: AccessRule<any, any>
  ttl: TtlOptions
  onExpire: CloseMode | undefined
  replace: ReplacePolicy | undefined
  ephemeral: boolean
  resyncOnStart: boolean
  debounce: number | undefined
}

export interface MenuDefinitionBase {
  readonly [MENU_BRAND]: true
  readonly name: string
  /** @internal */
  readonly runtime: MenuRuntime
}

export function isMenuDefinition(value: unknown): value is MenuDefinitionBase {
  return !!value && typeof value === "object" && (value as any)[MENU_BRAND] === true
}

const MENU_NAME = /^[A-Za-z0-9_.\-/]+$/

export function validateMenuName(name: unknown): asserts name is string {
  if (typeof name !== "string" || !MENU_NAME.test(name)) {
    throw new Error(
      `Invalid menu name ${JSON.stringify(name)}: use letters, numbers, ".", "-", "_" or "/" (no ":" or spaces).`
    )
  }
}

export function normalizeUpdates(
  updates: UpdateMode | Partial<UpdatePolicy> | undefined
): UpdatePolicy {
  if (typeof updates === "string") return { public: updates, ephemeral: updates }
  return { public: updates?.public ?? "live", ephemeral: updates?.ephemeral ?? "live" }
}
