import type { ParamSpec, RunStatus, RunSummary } from "./api";
import { fmtValue, labelOf } from "./Form";

export const STATUS: Record<RunStatus, string> = {
  running: "Running",
  waiting: "Needs your answer",
  ok: "Done",
  failed: "Failed",
  stopped: "Stopped",
};

export const isLive = (r: Pick<RunSummary, "status">) => r.status === "running" || r.status === "waiting";

/** "Ctrl" or "⌘", for shortcut hints (shown only in tooltips). */
export const MOD = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl";

export function fmtTime(t: number) {
  const d = new Date(t);
  const today = new Date().toDateString() === d.toDateString();
  return today ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : d.toLocaleString([], { dateStyle: "short", timeStyle: "short" });
}

/** A time in the future: "now", "in 40 s", "in 4 min", "at 14:30". */
export function fmtWhen(t: number) {
  const s = Math.round((t - Date.now()) / 1000);
  if (s <= 5) return "now";
  if (s < 60) return `in ${s} s`;
  if (s < 3600) return `in ${Math.round(s / 60)} min`;
  const d = new Date(t);
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const days = Math.round((new Date(d).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) / 86_400_000);
  if (days === 0) return `at ${time}`;
  if (days === 1) return `tomorrow at ${time}`;
  return `${d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" })} at ${time}`;
}

/** A time in the past: "just now", "4 min ago", "2 h ago", or the date. */
export function fmtAgo(t: number) {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 30) return "just now";
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return new Date(t).toLocaleDateString([], { day: "numeric", month: "short" });
}

export function fmtDur(ms: number) {
  return ms < 1000 ? `${ms} ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 60_000)} min`;
}

/** A run's values as the form labels them: "Name world · Times 3". */
export function fmtParams(p: Record<string, unknown>, specs: Record<string, ParamSpec> = {}) {
  return Object.entries(p)
    .map(([k, v]) => `${specs[k] ? labelOf(k, specs[k]!) : k} ${fmtValue(specs[k], v)}`)
    .join(" · ");
}

/** A script's last run in a few words: "Failed 2 min ago", "Waiting for you". */
export function lastLabel(r: RunSummary) {
  if (r.status === "waiting") return "Needs your answer";
  if (r.status === "running") return "Running now";
  return `${STATUS[r.status]} ${fmtAgo(r.endedAt ?? r.startedAt)}`;
}

export const SOURCE: Record<RunSummary["source"], string> = { manual: "", schedule: "automatic run", mcp: "run by an assistant" };

/** "10m" -> "10 minutes", "1d" -> "day", for "every …". */
export function fmtEvery(every: string) {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(s|sec|m|min|h|hr|d|day)?s?\s*$/i.exec(every);
  if (!m) return every;
  const n = Number(m[1]);
  const unit = { s: "second", m: "minute", h: "hour", d: "day" }[(m[2] ?? "m").toLowerCase()[0] as "s" | "m" | "h" | "d"];
  return n === 1 ? unit : `${n} ${unit}s`;
}

/** "10m" -> "10 min", "1h" -> "hour", for tight places like cards. */
export function fmtEveryShort(every: string) {
  return fmtEvery(every).replace(/minutes?/, "min").replace(/seconds?/, "sec");
}
