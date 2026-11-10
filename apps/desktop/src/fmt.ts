import type { RunStatus, RunSummary } from "./api";

export const STATUS: Record<RunStatus, string> = {
  running: "Running",
  waiting: "Waiting for you",
  ok: "Done",
  failed: "Failed",
  stopped: "Stopped",
};

export const isLive = (r: Pick<RunSummary, "status">) => r.status === "running" || r.status === "waiting";

/** "Ctrl" or "⌘", for shortcut hints. */
export const MOD = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl";

export function fmtTime(t: number) {
  const d = new Date(t);
  const today = new Date().toDateString() === d.toDateString();
  return today ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : d.toLocaleString([], { dateStyle: "short", timeStyle: "short" });
}

/** A time in the future: "now", "in 40 s", "in 4 min", "at 14:30". */
export function fmtWhen(t: number) {
  const s = Math.round((t - Date.now()) / 1000);
  if (s <= 5) return "now";
  if (s < 60) return `in ${s} s`;
  if (s < 3600) return `in ${Math.round(s / 60)} min`;
  return `at ${new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
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

export function fmtParams(p: Record<string, unknown>) {
  return Object.entries(p)
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join("  ");
}

export const SOURCE: Record<RunSummary["source"], string> = { manual: "", schedule: "scheduled", mcp: "agent" };
