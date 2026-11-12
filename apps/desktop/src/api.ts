/** Client for the engine's local API. */

/** A coding agent installed on this computer ("Claude Code", short "Claude"). */
export type Harness = { id: string; name: string; short: string };

export interface ParamSpec {
  kind: "text" | "number" | "boolean" | "select" | "file" | "folder";
  label?: string;
  description?: string;
  default?: unknown;
  optional?: boolean;
  placeholder?: string;
  multiline?: boolean;
  secret?: boolean;
  options?: { value: string; label: string }[];
  min?: number;
  max?: number;
}

export interface Script {
  id: string;
  project: string;
  folder: string;
  name: string;
  description?: string;
  /** Icon name from defineScript (see the SDK's ICONS). */
  icon?: string;
  params: Record<string, ParamSpec>;
  schedule?: { every: string };
  plain: boolean;
  /** The script calls ask.* itself, so a run may stop and wait for an answer. */
  asks: boolean;
  error?: string;
}

export interface Schedule {
  script: string;
  every: string;
  params: Record<string, unknown>;
  enabled: boolean;
  nextRun: number | null;
  lastRunId: string | null;
  last: RunSummary | null;
}

export type LayoutItem = { type: "script"; id: string } | { type: "folder"; id: string; name: string; scripts: string[] };
export interface Layout {
  favourites: string[];
  items: LayoutItem[];
}

export type RunStatus = "running" | "waiting" | "ok" | "failed" | "stopped";

export interface RunSummary {
  id: string;
  script: string;
  params: Record<string, unknown>;
  source: "manual" | "schedule" | "mcp" | "agent";
  status: RunStatus;
  exitCode: number | null;
  error: string | null;
  startedAt: number;
  endedAt: number | null;
  pendingAsk?: { id: number; request: AskRequest } | null;
}

export type AskRequest =
  | { kind: "text"; message: string; default?: string; secret?: boolean; multiline?: boolean }
  | { kind: "select"; message: string; options: { value: string; label: string }[] }
  | { kind: "confirm"; message: string; default?: boolean }
  | { kind: "file" | "folder"; message: string };

export type ShowItem =
  | { kind: "text"; text: string }
  | { kind: "markdown"; markdown: string }
  | { kind: "table"; rows: Record<string, unknown>[] };

export type RunEvent =
  | { t: "out" | "err" | "sys"; text: string; at: number }
  | { t: "show"; item: ShowItem; at: number }
  | { t: "ask"; id: number; request: AskRequest; at: number }
  | { t: "answer"; id: number; value: unknown; at: number };

export interface RunDetail extends RunSummary {
  events: RunEvent[];
}

export interface State {
  workspace: string;
  mcpUrl: string;
  projects: { id: string; name: string }[];
  scripts: Script[];
  schedules: Schedule[];
  live: RunDetail[];
  /** Newest runs of any script. */
  recent: RunSummary[];
  /** The newest run of each script, by script id. */
  lastRuns: Record<string, RunSummary>;
  layout: Layout;
  harnesses: Harness[];
  platform: string;
}

export type ServerMsg =
  | { type: "state" }
  | { type: "run"; run: RunSummary }
  | { type: "event"; runId: string; event: RunEvent };

export const isTauri = () => "__TAURI_INTERNALS__" in window;

export interface Conn {
  base: string;
  token: string;
}

/** In the app, ask Tauri where the engine is. In a browser (dev), read ?engine=&token=. */
export async function connect(): Promise<Conn> {
  if (isTauri()) {
    const { invoke } = await import("@tauri-apps/api/core");
    // The shell starts (and if needed restarts) the engine; a first start after an install
    // can take a while (a virus scan of the new files). Wait until it's up or says it failed.
    for (;;) {
      const info = await invoke<{ port: number; token: string } | null>("engine_info");
      if (info) return { base: `http://127.0.0.1:${info.port}`, token: info.token };
      const st = await invoke<EngineStatus>("engine_status").catch(() => null);
      if (st?.failed) throw new EngineError(st);
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  const q = new URLSearchParams(location.search);
  const token = q.get("token") ?? localStorage.getItem("yenae.token") ?? "";
  const base = q.get("engine") ?? localStorage.getItem("yenae.engine") ?? "http://127.0.0.1:47321";
  try {
    localStorage.setItem("yenae.token", token);
    localStorage.setItem("yenae.engine", base);
  } catch {}
  return { base, token };
}

export type EngineStatus = { ready: boolean; failed: string | null; log: string[]; version: string; logFile: string };

/** The engine couldn't be started; carries what it said, for the error screen. */
export class EngineError extends Error {
  constructor(public status: EngineStatus) {
    super(status.failed ?? "The background engine didn't start.");
  }
}

export class Api {
  constructor(private conn: Conn) {}

  get token() {
    return this.conn.token;
  }

  private async req<T>(path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(this.conn.base + path, {
        method: body === undefined ? "GET" : "POST",
        headers: { authorization: `Bearer ${this.conn.token}`, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      // fetch only says "Failed to fetch"; the cause is almost always the engine being down.
      throw new Error("The engine isn't responding.");
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    return data as T;
  }

  state = () => this.req<State>("/api/state");
  rescan = () => this.req<State>("/api/rescan", {});
  run = (script: string, params: Record<string, unknown>) => this.req<{ id: string }>("/api/run", { script, params });
  runs = (script: string) => this.req<RunSummary[]>(`/api/runs?script=${encodeURIComponent(script)}&limit=50`);
  getRun = (id: string) => this.req<RunDetail>(`/api/run/get?id=${encodeURIComponent(id)}`);
  stop = (run: string) => this.req("/api/run/stop", { run });
  answer = (run: string, id: number, value: unknown) => this.req("/api/run/answer", { run, id, value });
  schedule = (script: string, every: string, params: Record<string, unknown>, enabled: boolean) =>
    this.req<Schedule>("/api/schedule", { script, every, params, enabled });
  saveLayout = (layout: Layout) => this.req<Layout>("/api/layout", { layout });
  settings = (workspace: string) => this.req<State>("/api/settings", { workspace });
  newProject = (name: string) => this.req<{ id: string }>("/api/project", { name });
  /** Creates a script; with an agent, it starts writing it (`run` is that agent's run). */
  newScript = (project: string, file: string, description: string, harness?: string) =>
    this.req<{ id: string; run: string | null }>("/api/script", { project, file, description, harness });
  /** Has an agent change a script, in the background; returns the agent's run. */
  editWith = (script: string, harness: string, instructions: string) =>
    this.req<{ run: string }>("/api/edit-with", { script, harness, instructions });
  aiClients = () => this.req<import("./AiConnect").AiClient[]>("/api/ai");
  connectAi = (id: string) => this.req<import("./AiConnect").AiClient[]>("/api/ai/connect", { id });
  open = (script: string) => this.req("/api/open", { script });

  listen(onMsg: (m: ServerMsg) => void, onStatus: (up: boolean) => void) {
    let ws: WebSocket | null = null;
    let closed = false;
    const open = () => {
      ws = new WebSocket(`${this.conn.base.replace(/^http/, "ws")}/ws?token=${this.conn.token}`);
      ws.onopen = () => onStatus(true);
      ws.onmessage = (e) => onMsg(JSON.parse(e.data));
      ws.onclose = () => {
        onStatus(false);
        if (!closed) setTimeout(open, 1000);
      };
    };
    open();
    return () => {
      closed = true;
      ws?.close();
    };
  }
}

/** Pick a file or folder with the OS dialog. Null if cancelled or not in the app. */
export async function pickPath(kind: "file" | "folder", title?: string): Promise<string | null> {
  if (!isTauri()) return null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const r = await open({ directory: kind === "folder", multiple: false, title });
  return typeof r === "string" ? r : null;
}
