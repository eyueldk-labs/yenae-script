import type { AskRequest, ScriptMeta, ShowItem } from "yenae-script";

/** Script process -> engine, over Bun IPC. */
export type ToEngine =
  | { t: "meta"; meta: ScriptMeta | null }
  | { t: "ask"; id: number; request: AskRequest }
  | { t: "show"; item: ShowItem }
  | { t: "error"; message: string }
  | { t: "done" };

/** Engine -> script process. */
export type ToRunner = { t: "answer"; id: number; value: unknown };
