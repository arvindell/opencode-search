import solidPlugin from "@opentui/solid/bun-plugin";
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const outdir = fileURLToPath(new URL("../dist/", import.meta.url));
await rm(outdir, { recursive: true, force: true });

const result = await Bun.build({
  entrypoints: [
    fileURLToPath(new URL("../src/tui.ts", import.meta.url)),
    fileURLToPath(new URL("../src/query-worker.ts", import.meta.url)),
  ],
  outdir,
  naming: "[name].js",
  format: "esm",
  target: "bun",
  packages: "external",
  plugins: [solidPlugin],
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exitCode = 1;
}
