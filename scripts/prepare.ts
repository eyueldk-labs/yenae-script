/**
 * Prepares what the desktop app bundles:
 *   - the engine and runner, built to apps/desktop/src-tauri/resources/engine/
 *   - the SDK source the engine copies into each workspace
 *   - a pinned Bun binary, as the Tauri sidecar binaries/bun-<target triple>
 *
 *   bun scripts/prepare.ts [--target <rust triple>]
 */
import { mkdirSync, existsSync, copyFileSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { join } from "node:path";
import { unzipSync } from "fflate";

import { BUN_VERSION } from "./bun-version";
import { shellId } from "./shell-id";
export { BUN_VERSION };

const root = join(import.meta.dir, "..");
const tauri = join(root, "apps/desktop/src-tauri");
const out = join(tauri, "resources/engine");

// 1. Engine + runner
rmSync(out, { recursive: true, force: true });
const build = await Bun.build({
  entrypoints: [join(root, "packages/engine/src/main.ts"), join(root, "packages/engine/src/runner.ts")],
  outdir: out,
  target: "bun",
});
if (!build.success) {
  for (const l of build.logs) console.error(l);
  process.exit(1);
}
mkdirSync(join(out, "sdk"), { recursive: true });
copyFileSync(join(root, "packages/sdk/src/index.ts"), join(out, "sdk/index.ts"));
console.log("engine built");

// The shell's fingerprint, baked into the app so it knows which small updates fit it.
writeFileSync(join(tauri, "shell-id.txt"), shellId());
console.log(`shell id ${shellId()}`);

// 2. Bun sidecar
const ti = process.argv.indexOf("--target");
const triple =
  (ti > 0 ? process.argv[ti + 1] : undefined) ??
  process.env.TAURI_ENV_TARGET_TRIPLE ??
  /host: (\S+)/.exec(Bun.spawnSync(["rustc", "-vV"]).stdout.toString())?.[1];
if (!triple) throw new Error("Can't tell the target triple; pass --target.");

// "baseline" builds run on older CPUs without AVX2, which matters on random Windows machines.
const assets: Record<string, string> = {
  "x86_64-pc-windows-msvc": "bun-windows-x64-baseline",
  "aarch64-pc-windows-msvc": "bun-windows-aarch64",
  "x86_64-apple-darwin": "bun-darwin-x64-baseline",
  "aarch64-apple-darwin": "bun-darwin-aarch64",
  "x86_64-unknown-linux-gnu": "bun-linux-x64-baseline",
  "aarch64-unknown-linux-gnu": "bun-linux-aarch64",
};
const asset = assets[triple];
if (!asset) throw new Error(`No Bun build for ${triple}`);
const exe = triple.includes("windows") ? ".exe" : "";
const dest = join(tauri, "binaries", `bun-${triple}${exe}`);
const stampFile = `${dest}.version`;
if (existsSync(dest) && existsSync(stampFile) && (await Bun.file(stampFile).text()) === BUN_VERSION) {
  console.log(`bun ${BUN_VERSION} already at ${dest}`);
} else {
  const url = `https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/${asset}.zip`;
  console.log(`downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);
  const files = unzipSync(new Uint8Array(await res.arrayBuffer()));
  const entry = Object.keys(files).find((f) => f.endsWith(`/bun${exe}`));
  if (!entry) throw new Error("bun binary not found in zip");
  mkdirSync(join(tauri, "binaries"), { recursive: true });
  writeFileSync(dest, files[entry]!);
  if (!exe) chmodSync(dest, 0o755);
  writeFileSync(stampFile, BUN_VERSION);
  console.log(`bun ${BUN_VERSION} -> ${dest}`);
}
