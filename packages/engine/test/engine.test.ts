import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../src/engine";

let dir: string;
let engine: Engine;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "yenae-test-"));
  const ws = join(dir, "ws");
  engine = new Engine(join(dir, "data"), { workspace: ws, port: 0 });
  engine.start();
  await engine.scanning;
  await engine.newProject("p");
  mkdirSync(join(ws, "p/scripts/sub"), { recursive: true });
  writeFileSync(
    join(ws, "p/scripts/ask.ts"),
    `import { defineScript, number, ask, show } from "yenae-script";
export default defineScript({
  name: "Ask", params: { n: number().default(2) },
  async run({ n }) {
    console.log("n is", n);
    const ok = await ask.confirm("Go?");
    show.text(ok ? "went" : "stayed");
    return [{ n }];
  },
});`,
  );
  writeFileSync(join(ws, "p/scripts/sub/plain.ts"), `// Says hi\nconsole.log("hi from plain");`);
  writeFileSync(join(ws, "p/scripts/broken.ts"), `import { defineScript } from "yenae-script";\nimport "does-not-exist";\nexport default defineScript({ name: "B", run() {} });`);
  await engine.rescan();
}, 60_000);

afterAll(() => {
  engine.stop();
  rmSync(dir, { recursive: true, force: true });
});

test("scan finds scripts, folders and params", () => {
  const ids = engine.scripts.map((s) => s.id);
  expect(ids).toEqual(["p/scripts/ask.ts", "p/scripts/broken.ts", "p/scripts/sub/plain.ts"]);
  const ask = engine.script("p/scripts/ask.ts");
  expect(ask.name).toBe("Ask");
  expect(ask.params.n?.default).toBe(2);
  const plain = engine.script("p/scripts/sub/plain.ts");
  expect(plain.plain).toBe(true);
  expect(plain.folder).toBe("sub");
  expect(plain.description).toBe("Says hi");
  expect(ask.asks).toBe(true);
  expect(plain.asks).toBe(false);
  expect(engine.script("p/scripts/broken.ts").error).toContain("does-not-exist");
});

test("a run asks, gets an answer and shows results", async () => {
  const run = engine.run("p/scripts/ask.ts", { n: "5" }, "manual");
  // Wait for the question.
  for (let i = 0; i < 100 && !engine.runs.live.get(run.id)?.pendingAsk; i++) await Bun.sleep(50);
  const live = engine.runs.live.get(run.id)!;
  expect(live.status).toBe("waiting");
  engine.runs.answer(run.id, live.pendingAsk!.id, true);
  const done = await engine.runs.whenDone(run.id);
  expect(done.status).toBe("ok");
  const saved = engine.store.getRun(run.id)!;
  const out = saved.events.filter((e) => e.t === "out").map((e: any) => e.text).join("");
  expect(out).toContain("n is 5");
  const shown = saved.events.filter((e) => e.t === "show").map((e: any) => e.item);
  expect(shown).toEqual([{ kind: "text", text: "went" }, { kind: "table", rows: [{ n: 5 }] }]);
}, 30_000);

test("plain scripts run and exit on their own", async () => {
  const run = engine.run("p/scripts/sub/plain.ts", {}, "manual");
  const done = await engine.runs.whenDone(run.id);
  expect(done.status).toBe("ok");
});

test("stop ends a run", async () => {
  const run = engine.run("p/scripts/ask.ts", {}, "manual");
  for (let i = 0; i < 100 && !engine.runs.live.get(run.id)?.pendingAsk; i++) await Bun.sleep(50);
  engine.runs.stop(run.id);
  const done = await engine.runs.whenDone(run.id);
  expect(done.status).toBe("stopped");
  const last = engine.store.getRun(run.id)!.events.at(-1) as any;
  expect(last.text).toMatch(/^Stopped in /);
  expect(last.text).not.toContain("exit");
}, 30_000);

test("state shows each schedule's last run and recent runs", async () => {
  engine.setSchedule("p/scripts/sub/plain.ts", "1h", {}, true);
  let sched: any;
  for (let i = 0; i < 100; i++) {
    sched = engine.state().schedules.find((s) => s.script === "p/scripts/sub/plain.ts");
    if (sched?.last && sched.last.status !== "running") break;
    await Bun.sleep(50);
  }
  expect(sched.last.status).toBe("ok");
  expect(sched.last.source).toBe("schedule");
  expect(sched.last.events).toBeUndefined();
  const recent = engine.state().recent;
  expect(recent[0]!.id).toBe(sched.last.id);
  engine.setSchedule("p/scripts/sub/plain.ts", "1h", {}, false);
}, 30_000);
