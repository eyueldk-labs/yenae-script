/**
 * Writes a release's bundle.json: where apps find its small update. It is listed under
 * `bundle-<shell id>`, so only apps with that exact shell take it (see shell-id.ts).
 *
 *   bun scripts/bundle-feed.ts <version> <zip> <zip url> <notes file> <out json>
 *
 * The zip's signature is read from <zip>.sig (made by `tauri signer sign`).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { shellId } from "./shell-id";

const [version, zip, url, notesFile, out] = process.argv.slice(2);
if (!out) throw new Error("usage: bun scripts/bundle-feed.ts <version> <zip> <zip url> <notes file> <out json>");
const feed = {
  version,
  notes: readFileSync(notesFile, "utf8").trim(),
  pub_date: new Date().toISOString(),
  platforms: { [`bundle-${shellId()}`]: { url, signature: readFileSync(`${zip}.sig`, "utf8").trim() } },
};
writeFileSync(out, JSON.stringify(feed, null, 2) + "\n");
console.log(`${out}: ${version} for shell ${shellId()}`);
