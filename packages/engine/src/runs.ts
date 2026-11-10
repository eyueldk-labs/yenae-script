import type { Subprocess } from "bun";
import { BUN, RUNNER } from "./paths";
import type { RunEvent, RunSource, RunSummary, Store } from "./db";
import type { ScriptInfo, Project } from "./scan";
import type { ToEngine } from "./protocol";
import { ensureInstalled } from "./install";

export interface LiveRun extends RunSummary {
  events: RunEvent[];
  /** Open question from the script, if it is waiting. */
  pendingAsk: { id: number; request: unknown } | null;
}

export type RunListener = (
  msg: { type: "run"; run: RunSummary & { pendingAsk: LiveRun["pendingAsk"] } } | { type: "event"; runId: string; event: RunEvent },
) => void;

const MAX_EVENTS = 5000;
const MAX_TEXT = 2_000_000;

export class Runs {
  live = new Map<string, LiveRun & { proc?: Subprocess; textSize: number; stopping?: boolean }>();
  private listeners = new Set<RunListener>();
  private finished = new Map<string, (r: RunSummary) => void>();

  constructor(private store: Store) {}

  on(fn: RunListener) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(msg: Parameters<RunListener>[0]) {
    for (const l of this.listeners) l(msg);
  }

  private summary(r: LiveRun) {
    const { events, ...rest } = r as any;
    delete rest.proc;
    delete rest.textSize;
    delete rest.stopping;
    return rest as RunSummary & { pendingAsk: LiveRun["pendingAsk"] };
  }

  isRunning(script: string) {
    for (const r of this.live.values()) if (r.script === script) return true;
    return false;
  }

  get(id: string) {
    const live = this.live.get(id);
    if (live) return { ...this.summary(live), events: live.events };
    const done = this.store.getRun(id);
    return done ? { ...done, pendingAsk: null } : null;
  }

  /** Resolves when the run ends. */
  whenDone(id: string): Promise<RunSummary> {
    const live = this.live.get(id);
    if (!live) return Promise.resolve(this.store.getRun(id)!);
    return new Promise((resolve) => {
      const prev = this.finished.get(id);
      this.finished.set(id, (r) => {
        prev?.(r);
        resolve(r);
      });
    });
  }

  start(script: ScriptInfo, project: Project, params: Record<string, unknown>, source: RunSource): LiveRun {
    const id = crypto.randomUUID();
    const run: LiveRun & { textSize: number } = {
      id,
      script: script.id,
      params,
      source,
      status: "running",
      exitCode: null,
      error: null,
      startedAt: Date.now(),
      endedAt: null,
      events: [],
      pendingAsk: null,
      textSize: 0,
    };
    this.live.set(id, run);
    this.store.insertRun(run);
    this.emit({ type: "run", run: this.summary(run) });
    this.launch(run, script, project).catch((e) => this.finish(run, null, e.message ?? String(e)));
    return run;
  }

  private push(run: LiveRun & { textSize: number }, event: RunEvent) {
    if ((event.t === "out" || event.t === "err") && event.text) {
      if (run.textSize > MAX_TEXT) return;
      run.textSize += event.text.length;
      if (run.textSize > MAX_TEXT) event = { t: "sys", text: "Output limit reached; the rest is not shown.", at: event.at };
      const last = run.events[run.events.length - 1];
      // Merge consecutive chunks from the same stream to keep history small.
      if (last && last.t === event.t && "text" in last && event.at - last.at < 1000 && last.text.length < 8000) {
        last.text += (event as any).text;
        this.emit({ type: "event", runId: run.id, event: { ...event } });
        return;
      }
    }
    if (run.events.length >= MAX_EVENTS) return;
    run.events.push(event);
    this.emit({ type: "event", runId: run.id, event });
  }

  private async launch(run: LiveRun & { textSize: number; proc?: Subprocess; stopping?: boolean }, script: ScriptInfo, project: Project) {
    await ensureInstalled(project.dir, (text) => this.push(run, { t: "sys", text, at: Date.now() }));
    if (run.stopping) return this.finish(run, null, null);

    let doneTimer: Timer | undefined;
    const proc = Bun.spawn([BUN, RUNNER, "run", script.path], {
      cwd: project.dir,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      serialization: "json",
      windowsHide: true,
      env: {
        ...process.env,
        YENAE_PARAMS: JSON.stringify(run.params),
        YENAE_RUN_ID: run.id,
        FORCE_COLOR: "0",
        NO_COLOR: "1",
      },
      ipc: (msg: ToEngine) => {
        const at = Date.now();
        switch (msg.t) {
          case "show":
            this.push(run, { t: "show", item: msg.item, at });
            break;
          case "ask":
            run.pendingAsk = { id: msg.id, request: msg.request };
            run.status = "waiting";
            this.push(run, { t: "ask", id: msg.id, request: msg.request, at });
            this.emit({ type: "run", run: this.summary(run) });
            break;
          case "error":
            run.error = msg.message;
            break;
          case "done":
            // run() finished. Give stray timers a moment, then end the process.
            doneTimer = setTimeout(() => proc.kill(), 3000);
            break;
        }
      },
    } as any);
    run.proc = proc;

    const pump = async (stream: ReadableStream<Uint8Array>, t: "out" | "err") => {
      const decoder = new TextDecoder();
      for await (const chunk of stream) this.push(run, { t, text: decoder.decode(chunk, { stream: true }), at: Date.now() });
    };
    await Promise.all([pump(proc.stdout as unknown as ReadableStream, "out"), pump(proc.stderr as unknown as ReadableStream, "err")]);
    const code = await proc.exited;
    clearTimeout(doneTimer);
    this.finish(run, doneTimer ? 0 : code, null);
  }

  private finish(run: LiveRun & { stopping?: boolean }, code: number | null, error: string | null) {
    if (!this.live.has(run.id)) return;
    run.exitCode = code;
    if (error) run.error = error;
    run.status = run.stopping ? "stopped" : code === 0 && !run.error ? "ok" : "failed";
    run.endedAt = Date.now();
    run.pendingAsk = null;
    const ms = run.endedAt - run.startedAt;
    const label = run.status === "ok" ? "Done" : run.status === "stopped" ? "Stopped" : "Failed";
    this.push(run as any, { t: "sys", text: `${label} in ${fmtMs(ms)}${code !== null && code !== 0 ? ` (exit ${code})` : ""}`, at: run.endedAt });
    this.store.finishRun(run, run.events);
    this.store.pruneRuns(run.script);
    this.live.delete(run.id);
    this.emit({ type: "run", run: this.summary(run) });
    this.finished.get(run.id)?.(this.summary(run));
    this.finished.delete(run.id);
  }

  answer(runId: string, askId: number, value: unknown) {
    const run = this.live.get(runId);
    if (!run?.proc || run.pendingAsk?.id !== askId) throw new Error("That question is no longer open.");
    run.proc.send({ t: "answer", id: askId, value });
    run.pendingAsk = null;
    run.status = "running";
    this.push(run, { t: "answer", id: askId, value, at: Date.now() });
    this.emit({ type: "run", run: this.summary(run) });
  }

  stop(runId: string) {
    const run = this.live.get(runId);
    if (!run) return;
    run.stopping = true;
    if (run.proc) killTree(run.proc);
  }

  stopAll() {
    for (const id of this.live.keys()) this.stop(id);
  }
}

/** Stop a script and anything it started. */
function killTree(proc: Subprocess) {
  if (process.platform === "win32") {
    // Kills child processes too; proc.kill() alone would leave them running.
    Bun.spawn(["taskkill", "/pid", String(proc.pid), "/T", "/F"], { stdout: "ignore", stderr: "ignore", windowsHide: true } as any);
  } else {
    proc.kill("SIGTERM");
    setTimeout(() => {
      if (proc.exitCode === null) proc.kill("SIGKILL");
    }, 3000);
  }
}

function fmtMs(ms: number) {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;
}
