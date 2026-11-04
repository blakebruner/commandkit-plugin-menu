import { defineConfig } from "tsup"

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "node20",
  external: ["commandkit", "discord.js", "bun:sqlite", "node:sqlite"],
  // keep `node:` prefixes: `node:sqlite` has no unprefixed alias
  removeNodeProtocol: false
})
