import { defineConfig } from "tsdown";

// One self-contained ESM file, shipped as an extra resource and run by the
// Electron binary with ELECTRON_RUN_AS_NODE=1 (ADR-0003).
export default defineConfig({
  entry: { main: "src/main.ts" },
  format: "esm",
  platform: "node",
  target: "node24",
  outDir: "dist",
  clean: true,
  dts: false,
  // Bundle every dependency: the packaged app ships this one file, no node_modules.
  deps: { alwaysBundle: [/./], onlyBundle: false },
});
