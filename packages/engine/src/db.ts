import { Database } from "bun:sqlite";
import { join } from "node:path";

export type RunStatus = "running" | "waiting" | "ok" | "failed" | "stopped";
export type RunSource = "manual" | "schedule" | "mcp";

export type RunEvent =
  | { t: "out" | "err"; text: string; at: number }
  | { t: "show"; item: unknown; at: number }
  | { t: "ask"; id: number; request: unknown; at: number }
  | { t: "answer"; id: number; value: unknown; at: number }
  | { t: "sys"; text: string; at: number };

export interface RunSummary {
  id: string;
  script: string;
  params: Record<string, unknown>;
  source: RunSource;
  status: RunStatus;
  exitCode: number | null;
  error: string | null;
  startedAt: number;
  endedAt: number | null;
}

export interface ScheduleRow {
  script: string;
  every: string;
  params: Record<string, unknown>;
  enabled: boolean;
  nextRun: number | null;
  lastRunId: string | null;
}

export class Store {
  db: Database;

  constructor(dataDir: string) {
    this.db = new Database(join(dataDir, "yenae-script.db"), { create: true });
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, script TEXT NOT NULL, params TEXT NOT NULL, source TEXT NOT NULL,
        status TEXT NOT NULL, exit_code INTEGER, error TEXT,
        started_at INTEGER NOT NULL, ended_at INTEGER, events TEXT
      );
      CREATE INDEX IF NOT EXISTS runs_script ON runs(script, started_at DESC);
      CREATE TABLE IF NOT EXISTS schedules (
        script TEXT PRIMARY KEY, every TEXT NOT NULL, params TEXT NOT NULL,
        enabled INTEGER NOT NULL, next_run INTEGER, last_run_id TEXT
      );
      CREATE TABLE IF NOT EXISTS meta_cache (
        path TEXT PRIMARY KEY, stamp TEXT NOT NULL, meta TEXT
      );
    `);
    // Runs that were live when the app last quit can't be resumed.
    this.db.run(
      "UPDATE runs SET status = 'stopped', ended_at = started_at, error = 'App closed during run' WHERE status IN ('running','waiting')",
    );
  }

  insertRun(r: RunSummary) {
    this.db.run(
      "INSERT INTO runs (id, script, params, source, status, started_at) VALUES (?, ?, ?, ?, ?, ?)",
      [r.id, r.script, JSON.stringify(r.params), r.source, r.status, r.startedAt],
    );
  }

  finishRun(r: RunSummary, events: RunEvent[]) {
    this.db.run("UPDATE runs SET status = ?, exit_code = ?, error = ?, ended_at = ?, events = ? WHERE id = ?", [
      r.status,
      r.exitCode,
      r.error,
      r.endedAt,
      JSON.stringify(events),
      r.id,
    ]);
  }

  listRuns(script: string | undefined, limit: number): RunSummary[] {
    const rows = script
      ? this.db
          .query("SELECT * FROM runs WHERE script = ? ORDER BY started_at DESC LIMIT ?")
          .all(script, limit)
      : this.db.query("SELECT * FROM runs ORDER BY started_at DESC LIMIT ?").all(limit);
    return (rows as any[]).map(toSummary);
  }

  getRun(id: string): (RunSummary & { events: RunEvent[] }) | null {
    const row = this.db.query("SELECT * FROM runs WHERE id = ?").get(id) as any;
    if (!row) return null;
    return { ...toSummary(row), events: row.events ? JSON.parse(row.events) : [] };
  }

  /** Keep the newest `keep` runs per script. */
  pruneRuns(script: string, keep = 200) {
    this.db.run(
      `DELETE FROM runs WHERE script = ? AND id NOT IN (
         SELECT id FROM runs WHERE script = ? ORDER BY started_at DESC LIMIT ?)`,
      [script, script, keep],
    );
  }

  schedules(): ScheduleRow[] {
    return (this.db.query("SELECT * FROM schedules").all() as any[]).map((r) => ({
      script: r.script,
      every: r.every,
      params: JSON.parse(r.params),
      enabled: !!r.enabled,
      nextRun: r.next_run,
      lastRunId: r.last_run_id,
    }));
  }

  saveSchedule(s: ScheduleRow) {
    this.db.run(
      `INSERT INTO schedules (script, every, params, enabled, next_run, last_run_id) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(script) DO UPDATE SET every = excluded.every, params = excluded.params,
         enabled = excluded.enabled, next_run = excluded.next_run, last_run_id = excluded.last_run_id`,
      [s.script, s.every, JSON.stringify(s.params), s.enabled ? 1 : 0, s.nextRun, s.lastRunId],
    );
  }

  cachedMeta(path: string, stamp: string): { meta: unknown } | null {
    const row = this.db.query("SELECT stamp, meta FROM meta_cache WHERE path = ?").get(path) as any;
    if (!row || row.stamp !== stamp) return null;
    return { meta: row.meta ? JSON.parse(row.meta) : null };
  }

  cacheMeta(path: string, stamp: string, meta: unknown) {
    this.db.run(
      "INSERT INTO meta_cache (path, stamp, meta) VALUES (?, ?, ?) ON CONFLICT(path) DO UPDATE SET stamp = excluded.stamp, meta = excluded.meta",
      [path, stamp, JSON.stringify(meta)],
    );
  }
}

function toSummary(r: any): RunSummary {
  return {
    id: r.id,
    script: r.script,
    params: JSON.parse(r.params),
    source: r.source,
    status: r.status,
    exitCode: r.exit_code,
    error: r.error,
    startedAt: r.started_at,
    endedAt: r.ended_at,
  };
}
