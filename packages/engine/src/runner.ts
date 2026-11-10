/**
 * Runs inside the script's process: `bun runner.js <describe|run> <script>`.
 *
 * It installs a host for the SDK, imports the script and either reports its
 * metadata (describe) or calls its `run` (run). Messages to the engine go over
 * Bun's IPC channel, so the script's stdout and stderr stay plain output.
 *
 * The SDK is found by symbols, not imports: the script's copy of `yenae-script`
 * lives in its project's node_modules, not next to this file.
 */
import { pathToFileURL } from "node:url";
import type { ToEngine, ToRunner } from "./protocol";
import { coerce } from "./coerce";

const DEFINITION = Symbol.for("yenae-script.definition");
const HOST = Symbol.for("yenae-script.host");

const [mode, scriptPath] = process.argv.slice(2);
const channel = (process as any).channel as { ref(): void; unref(): void } | undefined;

function send(msg: ToEngine) {
  process.send?.(msg);
}

// The IPC channel keeps the process alive. Hold it only while waiting on an answer,
// so plain scripts exit on their own like they would under `bun script.ts`.
channel?.unref();
let waiting = 0;
const pending = new Map<number, (v: unknown) => void>();
let nextId = 1;

process.on("message", (msg: ToRunner) => {
  if (msg.t === "answer") {
    const resolve = pending.get(msg.id);
    if (!resolve) return;
    pending.delete(msg.id);
    if (--waiting === 0) channel?.unref();
    resolve(msg.value);
  }
});

(globalThis as any)[HOST] = {
  ask(request: any) {
    if (mode === "describe") {
      return Promise.reject(new Error(`ask.${request.kind}() ran while reading the script's params. Move it inside run().`));
    }
    const id = nextId++;
    if (waiting++ === 0) channel?.ref();
    return new Promise((resolve) => {
      pending.set(id, resolve);
      send({ t: "ask", id, request });
    });
  },
  show(item: any) {
    send({ t: "show", item });
  },
};

function findDefinition(mod: Record<string, unknown>) {
  const candidates = [mod.default, ...Object.values(mod)];
  return candidates.find((v: any) => v && typeof v === "object" && v[DEFINITION]) as
    | { meta: any; run: (p: Record<string, unknown>) => unknown }
    | undefined;
}

function toShow(result: unknown) {
  if (result === undefined || result === null) return;
  if (typeof result === "string") return send({ t: "show", item: { kind: "text", text: result } });
  if (Array.isArray(result) && result.every((r) => r && typeof r === "object" && !Array.isArray(r)))
    return send({ t: "show", item: { kind: "table", rows: result as any } });
  send({ t: "show", item: { kind: "text", text: JSON.stringify(result, null, 2) } });
}

function fail(e: unknown) {
  const err = e instanceof Error ? e : new Error(String(e));
  console.error(err.stack ?? err.message);
  send({ t: "error", message: err.message });
  process.exitCode = 1;
}

async function main() {
  if (!scriptPath || (mode !== "describe" && mode !== "run")) {
    console.error("usage: runner <describe|run> <script>");
    process.exit(2);
  }
  if (mode === "describe") process.env.YENAE_DESCRIBE = "1";

  const mod = await import(pathToFileURL(scriptPath).href);
  const def = findDefinition(mod);

  if (mode === "describe") {
    send({ t: "meta", meta: def ? def.meta : null });
    // Don't wait for timers a script may have started at the top level.
    setTimeout(() => process.exit(0), 50);
    return;
  }

  if (!def) return; // A plain script already ran when it was imported.

  const input = JSON.parse(process.env.YENAE_PARAMS || "{}");
  const values = coerce(def.meta.params ?? {}, input);
  const result = await def.run(values);
  toShow(result);
  send({ t: "done" });
}

process.on("unhandledRejection", fail);
main().catch(fail);
