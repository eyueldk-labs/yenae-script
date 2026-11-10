/**
 * The shell ID: a fingerprint of everything in the installed app that a small update
 * can't replace — the Rust shell, its config, icons, installer hooks and the bundled Bun.
 *
 * A small update (engine + UI) applies only to an app whose shell ID matches; anything
 * else gets the full installer. The shell bakes its ID in at build time (prepare.ts writes
 * src-tauri/shell-id.txt) and each release's bundle.json records it, so this function is
 * the one place that decides what counts.
 *
 *   bun scripts/shell-id.ts      prints it
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { BUN_VERSION } from "./bun-version";

const root = join(import.meta.dir, "..");
const tauri = join(root, "apps/desktop/src-tauri");

/** Files and folders under src-tauri that belong to the shell. */
const PARTS = ["src", "Cargo.toml", "Cargo.lock", "build.rs", "tauri.conf.json", "capabilities", "icons", "windows"];

function files(path: string): string[] {
  const st = statSync(path, { throwIfNoEntry: false });
  if (!st) return [];
  if (st.isFile()) return [path];
  return readdirSync(path)
    .sort()
    .flatMap((f) => files(join(path, f)));
}

export function shellId(): string {
  const h = createHash("sha256");
  h.update(`bun ${BUN_VERSION}\n`);
  for (const f of PARTS.flatMap((p) => files(join(tauri, p)))) {
    let data = readFileSync(f, "utf8");
    // The release version changes every release without changing the shell.
    if (f.endsWith("tauri.conf.json")) {
      const c = JSON.parse(data);
      delete c.version;
      data = JSON.stringify(c);
    }
    // Same bytes on Windows and Linux checkouts.
    data = data.replace(/\r\n/g, "\n");
    h.update(`${relative(tauri, f).replace(/\\/g, "/")}\n${data}\n`);
  }
  return h.digest("hex").slice(0, 16);
}

if (import.meta.main) console.log(shellId());
