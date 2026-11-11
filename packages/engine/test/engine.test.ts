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
  engine = new Engine(join(dir, "data"), { workspace: ws, port: 0 }, { examples: false });
  engine.start();
  await engine.scanning;
  await engine.newProject("p");
  mkdirSync(join(ws, "p/scripts/sub"), { recursive: true });
  writeFileSync(
    join(ws, "p/scripts/ask.ts"),
    `import { defineScript, number, ask, show } from "yenae-script";
export default defineScript({
  name: "Ask", icon: "message", params: { n: number().default(2) },
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

afterAll(async () => {
  engine.stop();
  // Windows keeps files locked for a moment after the runs end; cleanup is best effort.
  await Bun.sleep(200);
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch {}
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
  expect(ask.icon).toBe("message");
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

test("the layout is saved, normalized and shown in state", () => {
  const saved = engine.saveLayout({
    favourites: ["p/scripts/ask.ts"],
    items: [{ type: "folder", id: "f", name: "Mine", scripts: ["p/scripts/sub/plain.ts", "p/scripts/ask.ts"] }],
  });
  expect(saved.items[0]).toEqual({ type: "folder", id: "f", name: "Mine", scripts: ["p/scripts/sub/plain.ts", "p/scripts/ask.ts"] });
  expect(saved.items.slice(1)).toEqual([{ type: "script", id: "p/scripts/broken.ts" }]);
  const st = engine.state();
  expect(st.layout).toEqual(saved);
  expect(st.lastRuns["p/scripts/ask.ts"]?.script).toBe("p/scripts/ask.ts");
});

test("busy while a run is live", async () => {
  const run = engine.run("p/scripts/ask.ts", {}, "manual");
  expect(engine.busy()).toEqual({ busy: true, reason: "a script is running" });
  for (let i = 0; i < 100 && !engine.runs.live.get(run.id)?.pendingAsk; i++) await Bun.sleep(50);
  engine.runs.stop(run.id);
  await engine.runs.whenDone(run.id);
  expect(engine.busy().reason).not.toBe("a script is running");
}, 30_000);

test("an agent's work shows as a run of the script: steps, messages, done", async () => {
  const { AGENTS } = await import("../src/agents");
  const claude = AGENTS.find((a) => a.id === "claude")!;
  const lines = [
    { type: "system", subtype: "init" },
    { type: "assistant", message: { content: [{ type: "tool_use", name: "Write", input: { file_path: "/ws/p/scripts/x.ts" } }] } },
    { type: "assistant", message: { content: [{ type: "tool_use", name: "mcp__yenae-script__run_script", input: {} }] } },
    { type: "assistant", message: { content: [{ type: "text", text: "It now lists your files." }] } },
    { type: "result", subtype: "success", is_error: false, result: "It now lists your files." },
  ];
  const code = `for (const l of ${JSON.stringify(lines.map((l) => JSON.stringify(l)))}) console.log(l);`;
  const run = engine.runs.startAgent("p/scripts/ask.ts", claude, [process.execPath, "-e", code], process.cwd(), undefined, "list files");
  // An agent at work holds back updates (a restart would cut it off), but not schedules.
  expect(engine.busy().reason).toBe("a script is being written");
  expect(engine.runs.isRunning("p/scripts/ask.ts")).toBe(false);
  const done = await engine.runs.whenDone(run.id);
  expect(done.status).toBe("ok");
  const ev = engine.store.getRun(run.id)!.events as any[];
  const sys = ev.filter((e) => e.t === "sys").map((e) => e.text);
  expect(sys).toContain("Writing x.ts");
  expect(sys).toContain("Trying the script");
  expect(ev.filter((e) => e.t === "show").length).toBe(1); // the final summary isn't repeated
}, 30_000);
