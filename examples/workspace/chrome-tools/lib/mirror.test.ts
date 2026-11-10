import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync, strToU8 } from "fflate";
import { checkTarget, extensionFiles, mirror } from "./mirror";

const zip = (name: string, version: string, extra: Record<string, string> = {}) =>
  zipSync({
    "ext/manifest.json": strToU8(JSON.stringify({ name, version, manifest_version: 3 })),
    "ext/bg.js": strToU8(`// ${version}`),
    ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [`ext/${k}`, strToU8(v)])),
  });

test("finds the extension inside a wrapper folder", () => {
  const { files, manifest } = extensionFiles(zip("A", "1"));
  expect([...files.keys()].sort()).toEqual(["bg.js", "manifest.json"]);
  expect(manifest.version).toBe("1");
});

test("mirrors every file and removes stale ones", () => {
  const dir = join(mkdtempSync(join(tmpdir(), "mirror-")), "out");
  mirror(dir, extensionFiles(zip("A", "1", { "old.js": "x" })).files);
  const r = mirror(dir, extensionFiles(zip("A", "2")).files);
  expect(r.removed).toEqual(["old.js"]);
  expect(readFileSync(join(dir, "bg.js"), "utf8")).toBe("// 2");
  expect(existsSync(join(dir, "old.js"))).toBe(false);
});

test("refuses a folder that isn't the same extension", () => {
  const base = mkdtempSync(join(tmpdir(), "mirror-"));
  const notExt = join(base, "docs");
  mkdirSync(notExt);
  writeFileSync(join(notExt, "notes.txt"), "keep me");
  expect(() => checkTarget(notExt, { name: "A" })).toThrow(/no manifest.json/);

  const other = join(base, "other");
  mkdirSync(other);
  writeFileSync(join(other, "manifest.json"), JSON.stringify({ name: "B" }));
  expect(() => checkTarget(other, { name: "A" })).toThrow(/Not overwriting/);
  expect(checkTarget(join(base, "new"), { name: "A" })).toBeNull();
});
