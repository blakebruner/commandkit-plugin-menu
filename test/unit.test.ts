import { ActionRow, Button, Container, Separator, TextDisplay } from "commandkit"
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  ContainerBuilder,
  TextDisplayBuilder
} from "discord.js"
import { describe, expect, it } from "vitest"
import { decodeCustomId, encodeCustomId, validateActionName } from "../src/custom-id"
import { disableComponents, normalizeOutput, validateCustomIds } from "../src/render"
import { assertSerializable, stableStringify } from "../src/utils"

describe("custom ids", () => {
  it("round-trips view, action and arg", () => {
    const id = encodeCustomId("menu", "abc123", "remove", "track:42")
    expect(id).toBe("menu:abc123:remove:track:42")
    expect(decodeCustomId("menu", id)).toEqual({
      viewId: "abc123",
      action: "remove",
      arg: "track:42"
    })
    expect(decodeCustomId("menu", "menu:abc123:next")).toEqual({
      viewId: "abc123",
      action: "next",
      arg: undefined
    })
  })

  it("ignores ids from other prefixes or malformed ids", () => {
    expect(decodeCustomId("menu", "ticket:abc:close")).toBeNull()
    expect(decodeCustomId("menu", "menuX:abc:close")).toBeNull()
    expect(decodeCustomId("menu", "menu:abc")).toBeNull()
    expect(decodeCustomId("menu", "menu::close")).toBeNull()
  })

  it("rejects ids over Discord's 100 character limit", () => {
    expect(() => encodeCustomId("menu", "abc", "x", "y".repeat(100))).toThrow(/100/)
  })

  it("rejects reserved and malformed action names", () => {
    expect(() => validateActionName("$next", "m")).toThrow(/reserved/)
    expect(() => validateActionName("a:b", "m")).toThrow(/invalid/)
    expect(() => validateActionName("close-ticket", "m")).not.toThrow()
  })
})

describe("render output", () => {
  it("accepts discord.js builders, raw JSON, nested fragments and falsy holes", () => {
    const out = normalizeOutput([
      new ContainerBuilder().addTextDisplayComponents(new TextDisplayBuilder().setContent("hi")),
      [null, false, [{ type: ComponentType.TextDisplay, content: "raw" }]],
      undefined
    ])
    expect(out.components).toHaveLength(2)
    expect(out.components[0]!.type).toBe(ComponentType.Container)
    expect(out.components[1]).toEqual({ type: ComponentType.TextDisplay, content: "raw" })
    expect(out.allowedMentions).toEqual({ parse: [] })
  })

  it("accepts CommandKit JSX components", () => {
    const tree = Container({
      accentColor: "Blue",
      children: [
        TextDisplay({ content: "hello" }),
        Separator({}),
        ActionRow({
          children: [Button({ customId: "menu:v:go", style: ButtonStyle.Primary, children: "Go" })]
        })
      ] as any
    })
    const out = normalizeOutput(tree)
    expect(out.components[0]!.type).toBe(ComponentType.Container)
    expect(JSON.stringify(out.components)).toContain("menu:v:go")
  })

  it("accepts a full payload with files and mentions", () => {
    const out = normalizeOutput({
      components: [{ type: ComponentType.TextDisplay, content: "x" }],
      files: [{ name: "a.png", data: Buffer.from("png") }],
      allowedMentions: { users: ["1"] }
    })
    expect(out.files).toHaveLength(1)
    expect(out.allowedMentions).toEqual({ users: ["1"] })
  })

  it("reports duplicate custom ids clearly", () => {
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId("menu:v:ping").setLabel("a").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("menu:v:ping").setLabel("b").setStyle(ButtonStyle.Primary)
    )
    const { components } = normalizeOutput(row)
    expect(() => validateCustomIds("demo", components)).toThrow(/used twice/)
  })

  it("disables buttons and selects but leaves link buttons alone", () => {
    const components = [
      {
        type: ComponentType.Container,
        components: [
          {
            type: ComponentType.Section,
            components: [{ type: ComponentType.TextDisplay, content: "x" }],
            accessory: { type: ComponentType.Button, style: ButtonStyle.Primary, custom_id: "a" }
          },
          {
            type: ComponentType.ActionRow,
            components: [
              { type: ComponentType.Button, style: ButtonStyle.Link, url: "https://x.y" },
              { type: ComponentType.StringSelect, custom_id: "s", options: [] }
            ]
          }
        ]
      }
    ]
    const disabled = disableComponents(components)
    const container = disabled[0]!
    expect(container.components[0].accessory.disabled).toBe(true)
    expect(container.components[1].components[0].disabled).toBeUndefined()
    expect(container.components[1].components[1].disabled).toBe(true)
    // original untouched
    expect((components[0]!.components[0] as any).accessory.disabled).toBeUndefined()
  })
})

describe("utils", () => {
  it("stable stringify ignores key order", () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: 3 } })).toBe(
      stableStringify({ a: { c: 3, d: 2 }, b: 1 })
    )
  })

  it("refuses non-JSON params with a useful path", () => {
    expect(() => assertSerializable({ ok: "1", user: new Map() }, "Menu params")).toThrow(
      /Menu params\.user is a Map/
    )
    expect(() => assertSerializable({ n: 1n }, "Menu params")).toThrow(/bigint/)
    expect(() => assertSerializable({ a: [1, "x", { b: null }] }, "Menu params")).not.toThrow()
  })
})
