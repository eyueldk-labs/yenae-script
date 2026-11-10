import type { ScheduleRow, Store } from "./db";
import { parseEvery } from "./paths";

/**
 * Runs enabled schedules while the app is open. A run that is still going when the
 * next one is due is skipped, and runs missed while the app was closed are not made up.
 */
export class Scheduler {
  private timer: Timer | undefined;

  constructor(
    private store: Store,
    private trigger: (s: ScheduleRow) => Promise<string | null>,
  ) {}

  start() {
    // Missed runs aren't made up: anything overdue runs once, now.
    this.timer = setInterval(() => this.tick(), 5000);
    this.tick();
  }

  stop() {
    clearInterval(this.timer);
  }

  set(script: string, every: string, params: Record<string, unknown>, enabled: boolean): ScheduleRow {
    const ms = parseEvery(every);
    const prev = this.store.schedules().find((s) => s.script === script);
    const wasOn = prev?.enabled && prev.every === every;
    const row: ScheduleRow = {
      script,
      every,
      params,
      enabled,
      // Turning a schedule on runs it now; changing nothing keeps its slot.
      nextRun: enabled ? (wasOn ? prev!.nextRun : Date.now()) : null,
      lastRunId: prev?.lastRunId ?? null,
    };
    if (enabled && row.nextRun === null) row.nextRun = Date.now() + ms;
    this.store.saveSchedule(row);
    if (enabled) queueMicrotask(() => this.tick());
    return row;
  }

  private busy = false;
  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      const now = Date.now();
      for (const s of this.store.schedules()) {
        if (!s.enabled || s.nextRun === null || s.nextRun > now) continue;
        let ms: number;
        try {
          ms = parseEvery(s.every);
        } catch {
          continue;
        }
        const runId = await this.trigger(s).catch(() => null);
        this.store.saveSchedule({ ...s, nextRun: now + ms, lastRunId: runId ?? s.lastRunId });
      }
    } finally {
      this.busy = false;
    }
  }
}
