import { isTauri } from "./api";

/** A newer version of the app, as the updater reports it. */
export type Update = { version: string; notes?: string | null };

/** The newest version if it is newer than this one; null if up to date or not in the desktop app. */
export async function checkUpdate(): Promise<Update | null> {
  if (!isTauri()) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<Update | null>("check_update");
}

/** Downloads and installs the newest version, then restarts into it. */
export async function installUpdate(): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("install_update");
}

/** This app's version ("0.1.0"), or null in a browser. */
export async function appVersion(): Promise<string | null> {
  if (!isTauri()) return null;
  const { getVersion } = await import("@tauri-apps/api/app");
  return getVersion();
}
