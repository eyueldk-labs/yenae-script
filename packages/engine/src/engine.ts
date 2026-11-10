import { existsSync, mkdirSync, readFileSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { join, resolve } from "node:path";
import { Store, type ScheduleRow } from "./db";
import { Runs } from "./runs";
import { Scheduler } from "./scheduler";
import { scanWorkspace, type Project, type ScriptInfo } from "./scan";
import { ensureWorkspace, createProject, createScript } from "./workspace";
import { detectHarnesses, launchHarness, openInEditor } from "./launch";
import { insideWorkspace, parseEvery } from "./paths";
import type { RunSource } from "./db";

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
      schedules: this.store.schedules(),
      live: [...this.runs.live.keys()].map((id) => this.runs.get(id)),
      harnesses: detectHarnesses(),
      platform: process.platform,
    };
  }

  newProject(name: string) {
    const id = createProject(this.settings.workspace, name);
    return this.rescan().then(() => id);
  }

  async newScript(project: string, file: string, description: string, harness?: string) {
    const id = createScript(this.settings.workspace, project, file, description);
    await this.rescan();
    if (harness) this.editWith(id, harness, description);
    return id;
  }

  editWith(scriptId: string, harness: string, instructions: string) {
    const file = scriptId;
    const prompt = `You are working in a Yenae Script workspace. Read AGENTS.md first.

Task: ${instructions.trim() || "Improve this script."}

Script file: ${file}
${existsSync(insideWorkspace(this.settings.workspace, file)) ? "Edit that file." : "Create that file."}

When it's written, use the yenae-script MCP tools to run it and check the output.
Add npm packages to the project's package.json with \`bun add\` in the project folder if needed.
`;
    launchHarness(harness, this.settings.workspace, prompt);
  }

  open(scriptId: string) {
    openInEditor(this.settings.workspace, insideWorkspace(this.settings.workspace, scriptId));
  }
}
