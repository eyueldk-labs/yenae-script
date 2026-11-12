import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Store, type ScheduleRow } from "./db";
import { Runs } from "./runs";
import { Scheduler } from "./scheduler";
import { scanWorkspace, type Project, type ScriptInfo } from "./scan";
import { ensureWorkspace, createProject, createScript, seedExamples } from "./workspace";
import { openInEditor, revealPath } from "./launch";
import { agentCommand, detectAgents } from "./agents";
import { aiClients, connectAiClient, ensureBridge, resyncAiClients } from "./ai-clients";
import { insideWorkspace, parseEvery } from "./paths";
import type { RunSource, RunSummary } from "./db";
import { normalizeLayout, type Layout } from "./layout";

export interface Settings {
  workspace: string;
  port: number;
  token: string;
}

export class Engine {
  store: Store;
  runs: Runs;
  scheduler: Scheduler;
  settings: Settings;
  projects: Project[] = [];
  scripts: ScriptInfo[] = [];
  scanning: Promise<void> | null = null;
  private watcher: FSWatcher | null = null;
  private changeListeners = new Set<() => void>();

  constructor(
    private dataDir: string,
    overrides: Partial<Settings>,
    /** examples: false leaves a new scripts folder empty (tests). */
    private opts: { examples?: boolean } = {},
  ) {
    mkdirSync(dataDir, { recursive: true });
    this.settings = this.loadSettings(overrides);
    this.store = new Store(dataDir);
    this.runs = new Runs(this.store);
    this.scheduler = new Scheduler(this.store, (s) => this.runScheduled(s));
  }

  get mcpUrl() {
    return `http://127.0.0.1:${this.settings.port}/mcp`;
  }

  private loadSettings(overrides: Partial<Settings>): Settings {
    const path = join(this.dataDir, "settings.json");
    let saved: Partial<Settings> = {};
    try {
      saved = JSON.parse(readFileSync(path, "utf8"));
    } catch {}
    const home = process.env.USERPROFILE ?? process.env.HOME ?? ".";
    const s: Settings = {
      workspace: resolve(overrides.workspace ?? saved.workspace ?? join(home, "yenae-scripts")),
      port: overrides.port ?? saved.port ?? 47321,
      token: saved.token ?? crypto.randomUUID().replace(/-/g, ""),
    };
    // Don't persist a dev override of the workspace.
    writeFileSync(path, JSON.stringify({ ...s, workspace: saved.workspace ?? s.workspace }, null, 2));
    return s;
  }

  /** Listens on another port from now on (0 while the system picks one). */
  setPort(port: number) {
    this.settings.port = port;
    if (!port) return;
    const path = join(this.dataDir, "settings.json");
    let saved: any = {};
    try {
      saved = JSON.parse(readFileSync(path, "utf8"));
    } catch {}
    writeFileSync(path, JSON.stringify({ ...saved, port }, null, 2));
    // AI apps connected to the old address: point them at the new one (in the background).
    setTimeout(() => resyncAiClients(this.mcpConn), 1000);
  }

  saveSettings(patch: Partial<Pick<Settings, "workspace">>) {
    if (patch.workspace) {
      this.settings.workspace = resolve(patch.workspace);
      writeFileSync(join(this.dataDir, "settings.json"), JSON.stringify(this.settings, null, 2));
      this.openWorkspace();
    }
  }

  onChange(fn: () => void) {
    this.changeListeners.add(fn);
    return () => this.changeListeners.delete(fn);
  }

  start() {
    this.openWorkspace();
    this.scheduler.start();
  }

  stop() {
    this.scheduler.stop();
    this.runs.stopAll();
    this.watcher?.close();
  }

  private openWorkspace() {
    mkdirSync(this.settings.workspace, { recursive: true });
    ensureWorkspace(this.settings.workspace, { url: this.mcpUrl, token: this.settings.token });
    if (this.opts.examples !== false) seedExamples(this.settings.workspace);
    ensureBridge(this.settings.workspace);
    this.emptyOldTrash();
    this.watcher?.close();
    let debounce: Timer | undefined;
    try {
      this.watcher = watch(this.settings.workspace, { recursive: true }, (_e, file) => {
        const f = String(file ?? "").replace(/\\/g, "/");
        if (/(^|\/)(node_modules|\.yenae|\.git)(\/|$)/.test(f)) return;
        clearTimeout(debounce);
        debounce = setTimeout(() => this.rescan(), 400);
      });
    } catch {
      this.watcher = null; // Still works; changes show after a manual refresh.
    }
    this.rescan();
  }

  rescan(): Promise<void> {
    const next = (async () => {
      await this.scanning?.catch(() => {});
      const { projects, scripts } = await scanWorkspace(this.settings.workspace, this.store);
      this.projects = projects;
      this.scripts = scripts;
      for (const l of this.changeListeners) l();
    })();
    this.scanning = next;
    return next;
  }

  script(id: string): ScriptInfo {
    const s = this.scripts.find((x) => x.id === id || x.id === id.replace(/\\/g, "/"));
    if (!s) throw new Error(`No script "${id}". Scripts live in <project>/scripts/.`);
    return s;
  }

  run(scriptId: string, params: Record<string, unknown>, source: RunSource) {
    const script = this.script(scriptId);
    if (script.error) throw new Error(`Can't run ${script.id}: ${script.error}`);
    const project = this.projects.find((p) => p.id === script.project)!;
    return this.runs.start(script, project, params, source);
  }

  private async runScheduled(s: ScheduleRow): Promise<string | null> {
    if (this.runs.isRunning(s.script)) return null; // still going: skip this slot
    await this.scanning;
    try {
      return this.run(s.script, s.params, "schedule").id;
    } catch {
      return null;
    }
  }

  setSchedule(script: string, every: string, params: Record<string, unknown>, enabled: boolean) {
    this.script(script);
    parseEvery(every);
    const row = this.scheduler.set(script, every, params, enabled);
    for (const l of this.changeListeners) l();
    return row;
  }

  state() {
    return {
      workspace: this.settings.workspace,
      mcpUrl: this.mcpUrl,
      projects: this.projects.map(({ id, name }) => ({ id, name })),
      scripts: this.scripts.map(({ path, ...s }) => s),
      // Each schedule carries its last run, so a failing one can't hide behind its interval.
      schedules: this.store.schedules().map((s) => ({ ...s, last: this.lastRun(s.lastRunId) })),
      layout: this.layout(),
      // The newest run of every script, for tiles and the list view.
      lastRuns: Object.fromEntries(
        this.store.lastRuns().map((r) => [r.script, this.runs.live.has(r.id) ? summarize(this.runs.get(r.id)!) : r]),
      ),
      recent: this.store.listRuns(undefined, 12).map((r) => (this.runs.live.has(r.id) ? summarize(this.runs.get(r.id)!) : r)),
      live: [...this.runs.live.keys()].map((id) => this.runs.get(id)),
      harnesses: detectAgents(),
      platform: process.platform,
    };
  }

  /**
   * Whether now is a bad moment to restart the engine (the app asks before applying an
   * update): a script is running or waiting for an answer, or a schedule is due soon.
   */
  busy(withinMs = 5 * 60_000): { busy: boolean; reason?: string } {
    const live = [...this.runs.live.values()];
    if (live.some((r) => r.source !== "agent")) return { busy: true, reason: "a script is running" };
    // Restarting would cut an agent off halfway through changing a script.
    if (live.length) return { busy: true, reason: "a script is being written" };
    const soon = Date.now() + withinMs;
    const due = this.store.schedules().find((s) => s.enabled && s.nextRun !== null && s.nextRun <= soon);
    if (due) return { busy: true, reason: "a schedule is about to run" };
    return { busy: false };
  }

  private get layoutKey() {
    return `layout:${this.settings.workspace}`;
  }

  layout(): Layout {
    return normalizeLayout(this.store.getValue(this.layoutKey), this.scripts.map((s) => s.id));
  }

  /** A script's code, for the app's editor. */
  readSource(scriptId: string) {
    this.script(scriptId);
    return readFileSync(insideWorkspace(this.settings.workspace, scriptId), "utf8");
  }

  /** Saves a script's code and says whether it still loads (the error if not). */
  async writeSource(scriptId: string, text: string) {
    this.script(scriptId);
    writeFileSync(insideWorkspace(this.settings.workspace, scriptId), text);
    await this.rescan();
    return { error: this.scripts.find((x) => x.id === scriptId)?.error ?? null };
  }

  private get trashDir() {
    return join(this.settings.workspace, ".yenae", "trash");
  }

  /**
   * Deletes a script: anything it has running stops, its schedule is turned off, and the
   * file moves to `.yenae/trash/` (with its schedule and place in the layout) so it can be
   * put back. Returns the id to restore it with.
   */
  async deleteScript(scriptId: string) {
    this.script(scriptId);
    for (const r of [...this.runs.live.values()]) if (r.script === scriptId) this.runs.stop(r.id);
    const schedule = this.store.schedules().find((x) => x.script === scriptId) ?? null;
    if (schedule?.enabled) this.scheduler.set(scriptId, schedule.every, schedule.params, false);
    const trashId = String(Date.now());
    const dir = join(this.trashDir, trashId);
    const dest = join(dir, "files", scriptId);
    mkdirSync(dirname(dest), { recursive: true });
    renameSync(insideWorkspace(this.settings.workspace, scriptId), dest);
    writeFileSync(join(dir, "meta.json"), JSON.stringify({ script: scriptId, schedule, layout: this.layout() }, null, 2));
    await this.rescan();
    return trashId;
  }

  /** Puts a deleted script back: its file, its schedule (if it was on) and its place. */
  async restoreScript(trashId: string) {
    if (!/^\d+$/.test(trashId)) throw new Error("Nothing to restore.");
    const dir = join(this.trashDir, trashId);
    const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) as { script: string; schedule: ScheduleRow | null; layout: Layout };
    const target = insideWorkspace(this.settings.workspace, meta.script);
    if (existsSync(target)) throw new Error("A script with that name exists again, so it can't be put back.");
    mkdirSync(dirname(target), { recursive: true });
    renameSync(join(dir, "files", meta.script), target);
    rmSync(dir, { recursive: true, force: true });
    await this.rescan();
    if (meta.schedule?.enabled) this.scheduler.set(meta.script, meta.schedule.every, meta.schedule.params, true);
    this.saveLayout(meta.layout);
    return meta.script;
  }

  /** Deleted scripts are kept for 30 days. */
  private emptyOldTrash() {
    try {
      for (const name of readdirSync(this.trashDir)) {
        const p = join(this.trashDir, name);
        if (Date.now() - statSync(p).mtimeMs > 30 * 86_400_000) rmSync(p, { recursive: true, force: true });
      }
    } catch {}
  }

  saveLayout(raw: unknown) {
    const layout = normalizeLayout(raw, this.scripts.map((s) => s.id));
    this.store.setValue(this.layoutKey, layout);
    for (const l of this.changeListeners) l();
    return layout;
  }

  private lastRun(id: string | null) {
    if (!id) return null;
    const r = this.runs.get(id);
    return r ? summarize(r) : null;
  }

  newProject(name: string) {
    const id = createProject(this.settings.workspace, name);
    return this.rescan().then(() => id);
  }

  async newScript(project: string, file: string, description: string, harness?: string) {
    const id = createScript(this.settings.workspace, project, file, description);
    await this.rescan();
    const run = harness ? this.editWith(id, harness, description, true) : null;
    return { id, run };
  }

  /**
   * Has a coding agent write or change a script, in the background: no terminal window.
   * It shows as a run of the script (live steps, Stop, history). Returns the run id.
   */
  editWith(scriptId: string, harness: string, instructions: string, isNew = false) {
    const file = scriptId;
    const prompt = `You are working in a Yenae Script workspace (a folder of small TypeScript scripts). Read AGENTS.md first: it explains defineScript, the form fields, ask and show.

Task: ${instructions.trim() || "Improve this script."}

Script file: ${file}
${isNew ? "It holds a placeholder: replace it with the real script." : "Change that file."}

Keep it minimal: do exactly what was asked, plus only what the task clearly can't do without. No extra features, options or settings that weren't asked for.
People want to run it right away, without setting anything up. Only add a form field for something that truly differs from run to run (like which folder), and give every field a sensible default so Run works straight away. Pick good values yourself instead of asking for them.
${isNew ? "" : "Don't add new form fields or features unless the change asks for them.\n"}Give it a clear name, a one-line description in plain words, an icon, and plain labels on its fields (with units, like "Older than (days)").
When it's written, if you have the yenae-script MCP tools (run_script, get_run), use them to run it once and check it works; fix it if not. If it needs an npm package, add it with \`bun add\` in the project folder.
The person using this app may not be technical. Finish with one or two plain sentences saying what the script does now.
`;
    const { agent, argv, stdin } = agentCommand(harness, this.settings.workspace, prompt);
    const run = this.runs.startAgent(scriptId, agent, argv, this.settings.workspace, stdin, instructions.trim() || "Improve this script.");
    // The agent changed files: pick them up when it's done.
    this.runs.whenDone(run.id).then(() => this.rescan());
    return run.id;
  }

  /** AI apps on this computer that can use Yenae Script, and how to connect each. */
  aiClients() {
    return aiClients(this.mcpConn);
  }

  connectAiClient(id: string) {
    connectAiClient(id, this.mcpConn);
    return this.aiClients();
  }

  private get mcpConn() {
    return { url: this.mcpUrl, token: this.settings.token, bun: process.execPath, workspace: this.settings.workspace };
  }

  open(scriptId: string) {
    openInEditor(this.settings.workspace, insideWorkspace(this.settings.workspace, scriptId));
  }

  /** Shows the script's file in Explorer (or the system's file manager). */
  reveal(scriptId: string) {
    this.script(scriptId);
    revealPath(insideWorkspace(this.settings.workspace, scriptId));
  }
}

function summarize(r: RunSummary & { events?: unknown; pendingAsk?: unknown }): RunSummary & { pendingAsk?: unknown } {
  const { events, ...rest } = r;
  return rest;
}
