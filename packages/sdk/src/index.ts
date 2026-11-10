/**
 * yenae-script: the small API that Yenae Script scripts import.
 *
 *   import { defineScript, text, folder, ask, show } from "yenae-script";
 *
 *   export default defineScript({
 *     name: "Say hello",
 *     params: { who: text().default("world") },
 *     async run({ who }) {
 *       show.markdown(`# Hello ${who}`);
 *     },
 *   });
 *
 * The app reads `name`, `description`, `params` and `schedule` without calling
 * `run`, and builds a form from `params`. Keep real work inside `run`.
 *
 * This file has no dependencies and works outside the app too: run it with
 * `bun scripts/my-script.ts --who=you` and prompts fall back to the terminal.
 */

// ---------------------------------------------------------------- params

export type ParamKind = "text" | "number" | "boolean" | "select" | "file" | "folder";

export interface ParamSpec {
  kind: ParamKind;
  label?: string;
  description?: string;
  default?: unknown;
  optional?: boolean;
  /** text: placeholder; select: options */
  placeholder?: string;
  multiline?: boolean;
  secret?: boolean;
  options?: { value: string; label: string }[];
  min?: number;
  max?: number;
}

export class Param<T> {
  /** Type marker only; never set at runtime. */
  declare readonly _type: T;
  constructor(readonly spec: ParamSpec) {}
  label(label: string): Param<T> {
    return new Param<T>({ ...this.spec, label });
  }
  describe(description: string): Param<T> {
    return new Param<T>({ ...this.spec, description });
  }
  default(value: T): Param<T> {
    return new Param<T>({ ...this.spec, default: value });
  }
  optional(): Param<T | undefined> {
    return new Param<T | undefined>({ ...this.spec, optional: true });
  }
}

export const text = (opts: { placeholder?: string; multiline?: boolean; secret?: boolean } = {}) =>
  new Param<string>({ kind: "text", ...opts });
export const number = (opts: { min?: number; max?: number } = {}) =>
  new Param<number>({ kind: "number", ...opts });
export const boolean = () => new Param<boolean>({ kind: "boolean" });
export const select = <const V extends string>(options: readonly (V | { value: V; label: string })[]) =>
  new Param<V>({
    kind: "select",
    options: options.map((o) => (typeof o === "string" ? { value: o, label: o } : o)),
  });
export const file = () => new Param<string>({ kind: "file" });
export const folder = () => new Param<string>({ kind: "folder" });

export type Params = Record<string, Param<any>>;
export type ParamValues<P extends Params> = { [K in keyof P]: P[K]["_type"] };

// ---------------------------------------------------------------- scripts

export interface Schedule {
  /** "30s", "10m", "2h", "1d" */
  every: string;
}

export interface ScriptMeta {
  name: string;
  description?: string;
  params: Record<string, ParamSpec>;
  /** A suggested schedule. The user turns it on in the app. */
  schedule?: Schedule;
}

export interface ScriptDefinition<P extends Params = Params> {
  name: string;
  description?: string;
  params?: P;
  schedule?: Schedule;
  run: (params: ParamValues<P>) => unknown | Promise<unknown>;
}

export const DEFINITION = Symbol.for("yenae-script.definition");

export interface DefinedScript {
  [DEFINITION]: true;
  meta: ScriptMeta;
  run: (params: Record<string, unknown>) => unknown | Promise<unknown>;
}

export function defineScript<P extends Params = {}>(def: ScriptDefinition<P>): DefinedScript {
  const params: Record<string, ParamSpec> = {};
  for (const [key, p] of Object.entries(def.params ?? {})) params[key] = p.spec;
  const script: DefinedScript = {
    [DEFINITION]: true,
    meta: { name: def.name, description: def.description, params, schedule: def.schedule },
    run: def.run as DefinedScript["run"],
  };
  // Run directly with `bun file.ts`: no app host, so run with CLI args.
  // (Not under `bun test`, which makes the test file the main module.)
  if (!host() && process.env.NODE_ENV !== "test" && isMainModule(callerFile())) {
    queueMicrotask(() => runStandalone(script));
  }
  return script;
}

// ---------------------------------------------------------------- host

/** Implemented by the app's runner. Scripts never call this directly. */
export interface Host {
  ask(request: AskRequest): Promise<unknown>;
  show(item: ShowItem): void;
}

export type AskRequest =
  | { kind: "text"; message: string; default?: string; secret?: boolean; multiline?: boolean }
  | { kind: "select"; message: string; options: { value: string; label: string }[] }
  | { kind: "confirm"; message: string; default?: boolean }
  | { kind: "file" | "folder"; message: string };

export type ShowItem =
  | { kind: "text"; text: string }
  | { kind: "markdown"; markdown: string }
  | { kind: "table"; rows: Record<string, unknown>[] };

export const HOST = Symbol.for("yenae-script.host");

function host(): Host | undefined {
  return (globalThis as any)[HOST];
}

/** The file that called defineScript, from the stack trace. */
function callerFile(): string | undefined {
  const lines = (new Error().stack ?? "").split("\n").slice(1);
  for (const line of lines) {
    const loc = line.replace(/^\s*at\s+/, "").replace(/^.*?\((.*)\)\s*$/, "$1");
    const m = /^(?:file:\/\/)?(.+?):\d+:\d+$/.exec(loc.trim());
    if (!m) continue;
    const f = m[1]!;
    if (!/[\\/]index\.ts$/.test(f) || !/(yenae-script|sdk)[\\/](src[\\/])?index\.ts$/.test(f)) return f;
  }
}

/** True when the script calling defineScript was started directly (`bun my-script.ts`). */
function isMainModule(caller: string | undefined): boolean {
  const main = (globalThis as any).Bun?.main ?? process.argv[1];
  if (!caller || typeof main !== "string") return false;
  const norm = (s: string) => s.replace(/\\/g, "/").toLowerCase();
  return norm(main) === norm(caller);
}

// ---------------------------------------------------------------- ask / show

export const ask = {
  text(message: string, opts: { default?: string; secret?: boolean; multiline?: boolean } = {}) {
    return request<string>({ kind: "text", message, ...opts });
  },
  select<const V extends string>(message: string, options: readonly (V | { value: V; label: string })[]) {
    return request<V>({
      kind: "select",
      message,
      options: options.map((o) => (typeof o === "string" ? { value: o, label: o } : o)),
    });
  },
  confirm(message: string, opts: { default?: boolean } = {}) {
    return request<boolean>({ kind: "confirm", message, ...opts });
  },
  file(message = "Choose a file") {
    return request<string>({ kind: "file", message });
  },
  folder(message = "Choose a folder") {
    return request<string>({ kind: "folder", message });
  },
};

export const show = {
  text(text: string) {
    emit({ kind: "text", text });
  },
  markdown(markdown: string) {
    emit({ kind: "markdown", markdown });
  },
  table(rows: Record<string, unknown>[]) {
    emit({ kind: "table", rows });
  },
};

async function request<T>(req: AskRequest): Promise<T> {
  const h = host();
  if (h) return (await h.ask(req)) as T;
  return terminalAsk(req) as T;
}

function emit(item: ShowItem) {
  const h = host();
  if (h) return h.show(item);
  if (item.kind === "text") console.log(item.text);
  else if (item.kind === "markdown") console.log(item.markdown);
  else console.table(item.rows);
}

// ---------------------------------------------------------------- standalone fallback

function terminalAsk(req: AskRequest): unknown {
  const p = (globalThis as any).prompt as ((m: string, d?: string) => string | null) | undefined;
  if (!p) throw new Error(`Cannot ask "${req.message}": no app and no terminal prompt.`);
  switch (req.kind) {
    case "confirm": {
      const a = p(`${req.message} (y/n)`, req.default ? "y" : "n");
      return /^y/i.test(a ?? "");
    }
    case "select": {
      req.options.forEach((o, i) => console.log(`  ${i + 1}. ${o.label}`));
      const a = Number(p(req.message, "1"));
      return req.options[Math.max(0, a - 1)]?.value;
    }
    case "text":
      return p(req.message, req.default) ?? "";
    default:
      return p(`${req.message} (path)`) ?? "";
  }
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of argv) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    if (m) out[m[1]!] = m[2] ?? "true";
  }
  return out;
}

async function runStandalone(script: DefinedScript) {
  const args = parseArgs(process.argv.slice(2));
  const values = coerceParams(script.meta.params, args);
  try {
    const result = await script.run(values);
    if (result !== undefined) console.log(typeof result === "string" ? result : JSON.stringify(result, null, 2));
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  }
}

/** Fill defaults and convert strings to the param's type. Throws on a missing required value. */
export function coerceParams(
  specs: Record<string, ParamSpec>,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(specs)) {
    let v = input[key];
    if (v === undefined || v === "") v = spec.default;
    if (v === undefined || v === "") {
      if (spec.kind === "boolean") v = false;
      else if (spec.optional) continue;
      else throw new Error(`Missing value for "${spec.label ?? key}"`);
    }
    if (spec.kind === "number") {
      const n = typeof v === "number" ? v : Number(v);
      if (Number.isNaN(n)) throw new Error(`"${spec.label ?? key}" must be a number`);
      v = n;
    } else if (spec.kind === "boolean") {
      v = v === true || v === "true" || v === "1" || v === "on";
    } else {
      v = String(v);
    }
    out[key] = v;
  }
  return out;
}
