import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep, parse } from "node:path";
import { homedir } from "node:os";
import { unzipSync } from "fflate";

export interface Manifest {
  name?: string;
  version?: string;
  manifest_version?: number;
}

/** Unzip and return the files under the folder that holds manifest.json. */
export function extensionFiles(zip: Uint8Array): { files: Map<string, Uint8Array>; manifest: Manifest } {
  const all = unzipSync(zip);
  const paths = Object.keys(all).filter(
    (p) => !p.endsWith("/") && !p.startsWith("__MACOSX/") && !p.endsWith(".DS_Store"),
  );
  // The zip may wrap the extension in a top folder; use the shallowest manifest.json.
  const manifests = paths.filter((p) => p === "manifest.json" || p.endsWith("/manifest.json"));
  if (!manifests.length) throw new Error("The zip has no manifest.json, so it isn't an unpacked extension.");
  const root = manifests.sort((a, b) => a.split("/").length - b.split("/").length)[0]!.slice(0, -"manifest.json".length);
  const files = new Map<string, Uint8Array>();
  for (const p of paths) if (p.startsWith(root)) files.set(p.slice(root.length), all[p]!);
  const manifest = JSON.parse(new TextDecoder().decode(files.get("manifest.json")!)) as Manifest;
  return { files, manifest };
}

/**
 * Check that `target` is safe to mirror into: missing, empty, or an extension with
 * the same name as the zip's. Returns the target's manifest, if it has one.
 */
export function checkTarget(target: string, incoming: Manifest): Manifest | null {
  const abs = resolve(target);
  if (abs === parse(abs).root || abs === resolve(homedir())) throw new Error(`Refusing to mirror into ${abs}.`);
  if (!existsSync(abs)) return null;
  if (!statSync(abs).isDirectory()) throw new Error(`${abs} is a file, not a folder.`);
  if (readdirSync(abs).length === 0) return null;
  const mp = join(abs, "manifest.json");
  if (!existsSync(mp)) {
    throw new Error(`${abs} has files but no manifest.json. Pick the extension's folder or an empty one.`);
  }
  let current: Manifest;
  try {
    current = JSON.parse(readFileSync(mp, "utf8"));
  } catch {
    throw new Error(`${mp} isn't valid JSON.`);
  }
  if (current.name && incoming.name && current.name !== incoming.name) {
    throw new Error(`The folder holds "${current.name}" but the zip holds "${incoming.name}". Not overwriting.`);
  }
  return current;
}

/**
 * Write every file, whatever its date: zips often give all files the same timestamp,
 * so comparing dates would skip real changes. Then delete files the zip no longer has.
 */
export function mirror(target: string, files: Map<string, Uint8Array>) {
  const abs = resolve(target);
  mkdirSync(abs, { recursive: true });
  for (const [rel, data] of files) {
    const out = resolve(abs, rel);
    if (!out.startsWith(abs + sep)) throw new Error(`Unsafe path in zip: ${rel}`);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, data);
  }
  const keep = new Set([...files.keys()].map((p) => p.split("/").join(sep)));
  const removed: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        walk(p);
        if (readdirSync(p).length === 0) rmdirSync(p);
      } else if (!keep.has(relative(abs, p))) {
        rmSync(p);
        removed.push(relative(abs, p).split(sep).join("/"));
      }
    }
  };
  walk(abs);
  return { written: files.size, removed };
}
