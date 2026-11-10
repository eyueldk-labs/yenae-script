/**
 * Builds a release's small update: the engine and the interface in one zip, with a
 * manifest naming its version and the shell it fits. Run after `prepare.ts` (engine) and
 * the UI build (apps/desktop/dist).
 *
 *   bun scripts/bundle.ts <version> <out dir>
 *
 * Writes <out>/yenae-bundle-<version>.zip. The release workflow signs it and lists it in
 * bundle.json under `bundle-<shell id>`.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { zipSync } from "fflate";
import { shellId } from "./shell-id";

const [version, out] = process.argv.slice(2);
if (!version || !out) throw new Error("usage: bun scripts/bundle.ts <version> <out dir>");

const root = join(import.meta.dir, "..");
const engine = join(root, "apps/desktop/src-tauri/resources/engine");
const ui = join(root, "apps/desktop/dist");
for (const [what, dir] of [["engine (run prepare.ts)", join(engine, "main.js")], ["UI (run the UI build)", join(ui, "index.html")]]) {
  if (!existsSync(dir)) throw new Error(`missing ${what}: ${dir}`);
}

const files: Record<string, Uint8Array> = {};
const add = (dir: string, prefix: string) => {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) add(p, prefix);
    else files[`${prefix}/${relative(prefix === "engine" ? engine : ui, p).replace(/\\/g, "/")}`] = readFileSync(p);
  }
};
add(engine, "engine");
add(ui, "ui");
const id = shellId();
files["manifest.json"] = new TextEncoder().encode(JSON.stringify({ version, shellId: id }, null, 2));

mkdirSync(out, { recursive: true });
const file = join(out, `yenae-bundle-${version}.zip`);
writeFileSync(file, zipSync(files, { level: 9 }));
console.log(`${file} (${(statSync(file).size / 1024).toFixed(0)} KB, shell ${id})`);
