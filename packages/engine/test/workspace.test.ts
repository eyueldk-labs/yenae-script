import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedExamples } from "../src/workspace";

const dirs: string[] = [];
const fresh = () => {
  const d = mkdtempSync(join(tmpdir(), "yenae-ws-"));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {}
  }
});

test("a new scripts folder gets the examples once", () => {
  const ws = fresh();
  seedExamples(ws);
  expect(existsSync(join(ws, "examples/scripts/say-hello.ts"))).toBe(true);
  expect(existsSync(join(ws, "examples/scripts/biggest-files.ts"))).toBe(true);
  // Deleted examples stay deleted.
  rmSync(join(ws, "examples"), { recursive: true });
  seedExamples(ws);
  expect(existsSync(join(ws, "examples"))).toBe(false);
});
