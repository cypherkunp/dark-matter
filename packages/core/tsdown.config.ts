import { cp, readdir, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { defineConfig } from "tsdown";

/**
 * @parcel/watcher's JS is bundled, but its native binary can't be: it loads
 * `@parcel/watcher-<platform>-<arch>` at runtime, resolved from main.mjs. Every
 * installed platform package is copied to dist/node_modules, which ships beside
 * main.mjs (electron-builder.yml). N-API, so it runs under ELECTRON_RUN_AS_NODE.
 */
const copyWatcherBinaries = async () => {
  const watcher = dirname(await realpath(createRequire(import.meta.url).resolve("@parcel/watcher/package.json")));
  const scope = dirname(watcher);
  for (const name of await readdir(scope)) {
    if (!name.startsWith("watcher-")) continue;
    await cp(await realpath(join(scope, name)), join("dist/node_modules/@parcel", name), {
      recursive: true,
      dereference: true,
    });
  }
};

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
  // jsonc-parser's `main` is a UMD build whose dynamic requires don't bundle; use its ESM build.
  alias: { "jsonc-parser": "jsonc-parser/lib/esm/main.js" },
  // Keep lazily imported modules (@parcel/watcher's JS) in the one file too.
  outputOptions: { inlineDynamicImports: true },
  onSuccess: copyWatcherBinaries,
});
