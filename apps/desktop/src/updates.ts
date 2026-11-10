import { useEffect, useState } from "react";
import { isTauri } from "./api";

/** Where updates stand, as the app's shell reports it (see src-tauri/src/updates.rs). */
export type UpdateStatus = {
  /** The version running now. */
  version: string;
  /** A newer version that is downloaded and ready. */
  ready: string | null;
  /** The ready version needs the installer (the window closes for a moment), not a quick restart. */
  full: boolean;
  notes: string | null;
  /** "Restart to update" was pressed while a script was running: it waits for it to finish. */
  waiting: boolean;
  applying: boolean;
  checking: boolean;
  /** An update that failed to apply. */
  error: string | null;
  /** The last check failed (e.g. offline). */
  checkError: string | null;
  /** Shown once after an update. */
  whatsNew: { version: string; notes: string } | null;
};

const invoke = async <T,>(cmd: string, args?: Record<string, unknown>) => (await import("@tauri-apps/api/core")).invoke<T>(cmd, args);

export async function updateStatus(): Promise<UpdateStatus | null> {
  if (!isTauri()) return null;
  return invoke<UpdateStatus>("update_status").catch(() => null);
}

/** Calls back whenever the status changes. Returns a function that stops listening. */
export function onUpdateStatus(cb: (s: UpdateStatus) => void): () => void {
  if (!isTauri()) return () => {};
  let off: (() => void) | undefined;
  let stopped = false;
  import("@tauri-apps/api/event").then(({ listen }) =>
    listen<UpdateStatus>("update-status", (e) => cb(e.payload)).then((f) => (stopped ? f() : (off = f))),
  );
  return () => {
    stopped = true;
    off?.();
  };
}

/** Looks for an update now. Resolves to whether one is ready. */
export const checkUpdates = () => invoke<boolean>("check_updates");
/** Restarts into the ready version now, or as soon as nothing is running. */
export const applyUpdate = () => invoke<void>("apply_update");
export const dismissWhatsNew = () => invoke<void>("dismiss_whats_new").catch(() => {});

/** Tells the shell this interface drew, so a freshly applied version is known to work. */
export function reportUiReady() {
  if (isTauri()) invoke("ui_ready").catch(() => {});
}

/** The update status, kept current. Null outside the desktop app. */
export function useUpdateStatus() {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  useEffect(() => {
    updateStatus().then(setStatus);
    return onUpdateStatus(setStatus);
  }, []);
  return status;
}

/** Release notes as lines: "- Faster start" -> "Faster start". */
export function noteLines(notes: string | null | undefined) {
  return (notes ?? "")
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*(?:[-*•]|\d+\.)\s+/, "").replace(/\*\*|__|`/g, "").trim())
    .filter((l) => l && !/^#/.test(l));
}
