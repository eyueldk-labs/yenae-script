import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { RunEvent } from "./db";

/**
 * Coding agents installed on the person's computer that can write or change a script.
 * Yenae Script has no agent of its own: it runs theirs headless (no terminal window) in
 * the scripts folder, and turns what the agent reports into a run's live output.
 */
export interface Agent {
  id: string;
  /** "Claude Code" */
  name: string;
  /** "Claude": the assistant, in sentences like "Claude is writing it". */
  short: string;
  bin: string;
  /** Command-line arguments; `task` is a short instruction pointing at the task file. */
  args(task: string, ctx: { workspace: string; mcpConfig: string }): string[];
  /** Whether the full prompt goes in on stdin (more robust than an argument). */
  stdin?: boolean;
  /** Turns one line of the agent's output into run events. */
  parse(line: string, state: ParseState): RunEvent[];
}

/** Agents that stream their reply in pieces: what's collected so far comes out as one message. */
export function flushText(st: ParseState): RunEvent[] {
  const t = st.buf?.trim();
  st.buf = "";
  if (!t) return [];
  st.lastText = t;
  return [said(t)];
}

export interface ParseState {
  /** Reply text streamed in pieces, not shown yet. */
  buf?: string;
  /** The last thing the agent said, so its final summary isn't shown twice. */
  lastText?: string;
  /** Set when the agent reports it finished, and whether that was an error. */
  result?: { ok: boolean; text: string };
  /** Tool calls waiting for their result: id -> tool name. */
  tools?: Record<string, string>;
}

const now = () => Date.now();
const step = (text: string): RunEvent => ({ t: "sys", text, at: now() });
const said = (markdown: string): RunEvent => ({ t: "show", item: { kind: "markdown", markdown }, at: now() });

/** What a tool printed or changed, shortened to its last lines so the panel stays readable. */
export function detail(text: unknown, lines = 14, chars = 1500): RunEvent[] {
  let t = typeof text === "string" ? text : Array.isArray(text) ? text.map((c: any) => (typeof c === "string" ? c : (c?.text ?? ""))).join("\n") : "";
  t = t.replace(/\r/g, "").replace(/\n+$/, "");
  if (!t.trim()) return [];
  let ls = t.split("\n");
  const cut = ls.length > lines;
  if (cut) ls = ls.slice(-lines);
  let out = ls.join("\n");
  if (out.length > chars) out = out.slice(-chars);
  return [{ t: "out", text: (cut || out.length < t.length ? "…\n" : "") + out + "\n", at: now() }];
}

/** The change an edit makes, as "- old / + new" lines. */
function editDetail(input: any): RunEvent[] {
  const edits: { old_string?: string; new_string?: string }[] = Array.isArray(input?.edits) ? input.edits : [input ?? {}];
  const lines: string[] = [];
  for (const e of edits) {
    for (const l of String(e.old_string ?? "").split("\n")) if (l.trim()) lines.push(`- ${l}`);
    for (const l of String(e.new_string ?? "").split("\n")) if (l.trim()) lines.push(`+ ${l}`);
  }
  return lines.length ? detail(lines.slice(0, 40).join("\n"), 20) : [];
}

/** "Editing say-hello.ts", "Trying the script": what a tool call means, in a few words. */
function describeTool(name: string, input: any): string | null {
  const file = typeof input?.file_path === "string" ? basename(input.file_path) : typeof input?.path === "string" ? basename(input.path) : "";
  if (/^(Write)$/i.test(name)) return file ? `Writing ${file}` : "Writing a file";
  if (/^(Edit|MultiEdit|apply_patch|replace|edit_file|write_file)$/i.test(name)) return file ? `Editing ${file}` : "Editing";
  if (/^(Read|read_file|view)$/i.test(name)) return file ? `Reading ${file}` : "Reading";
  if (/^(Glob|Grep|LS|list_directory|glob|grep|search_file_content)$/i.test(name)) return "Looking around the scripts folder";
  if (/^(Bash|shell|run_shell_command|exec_command)$/i.test(name)) {
    const c = String(input?.description ?? input?.command ?? "").split("\n")[0]!.slice(0, 80);
    return c ? `Running: ${c}` : "Running a command";
  }
  if (/run_script/.test(name)) return "Trying the script";
  if (/get_run|answer_question|stop_run/.test(name)) return "Checking the result";
  if (/TodoWrite|ToolSearch|thinking/i.test(name)) return null;
  if (/WebFetch|web_fetch|fetch/i.test(name)) return "Reading a web page";
  if (/WebSearch|web_search|google_web_search/i.test(name)) return "Searching the web";
  return name ? `Using ${name.replace(/^mcp__[^_]+(?:-[^_]+)*__/, "").replace(/_/g, " ")}` : null;
}

/** Claude Code: `claude -p --output-format stream-json`. */
function parseClaude(line: string, st: ParseState): RunEvent[] {
  let d: any;
  try {
    d = JSON.parse(line);
  } catch {
    return [];
  }
  const out: RunEvent[] = [];
  if (d.type === "assistant") {
    for (const c of d.message?.content ?? []) {
      if (c.type === "text" && c.text?.trim()) {
        st.lastText = c.text.trim();
        out.push(said(st.lastText!));
      } else if (c.type === "tool_use") {
        const name = String(c.name ?? "").replace(/^mcp__[^_]+(?:-[^_]+)*__/, "");
        const s = describeTool(name, c.input);
        if (s) out.push(step(s));
        if (/^(Edit|MultiEdit)$/.test(name)) out.push(...editDetail(c.input));
        else if (name === "Write") out.push(...detail(c.input?.content, 10));
        if (c.id) (st.tools ??= {})[c.id] = name;
      }
    }
  } else if (d.type === "user") {
    // Results of its tool calls: show what commands and script runs printed.
    for (const c of d.message?.content ?? []) {
      if (c.type !== "tool_result") continue;
      const name = st.tools?.[c.tool_use_id] ?? "";
      delete st.tools?.[c.tool_use_id];
      if (/^(Bash|run_script|get_run)$/.test(name) || c.is_error) out.push(...detail(c.content));
    }
  } else if (d.type === "result") {
    const text = String(d.result ?? "").trim();
    st.result = { ok: !d.is_error && d.subtype === "success", text };
    if (text && text !== st.lastText) out.push(said(text));
  }
  return out;
}

const json = (line: string): any => {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
};
const toolStep = (name: string, input: any) => {
  const s = describeTool(name, input);
  return s ? [step(s)] : [];
};

/** Codex: `codex exec --json` (thread/turn/item events). */
function parseCodex(line: string, st: ParseState): RunEvent[] {
  const d = json(line);
  if (!d) return [];
  const it = d.item ?? {};
  if (d.type === "item.started" || d.type === "item.completed") {
    if (it.type === "agent_message" && d.type === "item.completed" && it.text?.trim()) {
      st.lastText = it.text.trim();
      return [said(st.lastText!)];
    }
    if (d.type === "item.completed") {
      if (it.type === "command_execution") return detail(it.aggregated_output);
      if (it.type === "mcp_tool_call") return detail(it.result?.content ?? it.error?.message);
      if (it.type === "reasoning" && it.text?.trim()) return [step(String(it.text).trim().split("\n")[0]!.replace(/\*\*/g, "").slice(0, 140))];
      return [];
    }
    if (it.type === "command_execution") return toolStep("Bash", { command: it.command });
    if (it.type === "file_change") return [step(it.changes?.length === 1 && it.changes[0]?.path ? `Editing ${basename(it.changes[0].path)}` : `Editing ${it.changes?.length ?? ""} files`.replace("  ", " "))];
    if (it.type === "mcp_tool_call") return toolStep(String(it.tool ?? ""), it.arguments);
  }
  if (d.type === "turn.completed") st.result = { ok: true, text: "" };
  if (d.type === "turn.failed" || d.type === "error") st.result = { ok: false, text: String(d.error?.message ?? d.message ?? "") };
  return [];
}

/** Gemini CLI: `gemini --output-format stream-json`. */
function parseGemini(line: string, st: ParseState): RunEvent[] {
  const d = json(line);
  if (!d) return [];
  if (d.type === "message" && d.role === "assistant") {
    st.buf = (d.delta ? (st.buf ?? "") : "") + String(d.content ?? "");
    return [];
  }
  const out = flushText(st);
  if (d.type === "tool_use") {
    out.push(...toolStep(String(d.tool_name ?? ""), d.parameters));
    if (/^(replace|edit)$/i.test(String(d.tool_name))) out.push(...editDetail(d.parameters));
    if (d.tool_id) (st.tools ??= {})[d.tool_id] = String(d.tool_name ?? "");
  }
  if (d.type === "tool_result") {
    const name = st.tools?.[d.tool_id] ?? "";
    if (/shell|run_script|get_run/i.test(name) || d.status === "error") out.push(...detail(d.output ?? d.error?.message));
  }
  if (d.type === "result") st.result = { ok: d.status === "success", text: String(d.error?.message ?? "") };
  if (d.type === "error") st.result = { ok: false, text: String(d.message ?? d.error ?? "") };
  return out;
}

/** OpenCode: `opencode run --format json` (step/text/tool_use parts). */
function parseOpenCode(line: string, st: ParseState): RunEvent[] {
  const d = json(line);
  if (!d) return [];
  if (d.type === "text") {
    st.buf = (st.buf ?? "") + String(d.part?.text ?? "");
    return [];
  }
  const out = flushText(st);
  if (d.type === "tool_use") {
    const tool = String(d.part?.tool ?? "");
    const state = d.part?.state ?? {};
    // One step per tool call, however often it's reported; what it printed once it's done.
    const id = String(d.part?.callID ?? d.part?.id ?? "");
    st.tools ??= {};
    if (!id || !(id in st.tools)) {
      if (id) st.tools[id] = tool;
      out.push(...toolStep(tool, state.input));
      if (/^(edit)$/i.test(tool)) out.push(...editDetail({ old_string: state.input?.oldString, new_string: state.input?.newString }));
    }
    if ((state.status === "completed" && /bash|run_script|get_run/i.test(tool)) || state.status === "error") out.push(...detail(state.output ?? state.error));
  }
  if (d.type === "error") st.result = { ok: false, text: String(d.error?.message ?? d.error?.data?.message ?? "") };
  return out;
}

export const AGENTS: Agent[] = [
  {
    id: "claude",
    name: "Claude Code",
    short: "Claude",
    bin: "claude",
    stdin: true,
    args: (_task, { mcpConfig }) => [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      // Edits in the scripts folder go ahead without asking; commands are limited to Bun.
      "--permission-mode",
      "acceptEdits",
      "--allowedTools",
      "Read,Write,Edit,MultiEdit,Glob,Grep,Bash(bun:*),Bash(bunx:*),mcp__yenae-script",
      // The app's own tools, so it can run the script it wrote and check the result.
      "--mcp-config",
      mcpConfig,
    ],
    parse: parseClaude,
  },
  {
    id: "codex",
    name: "Codex",
    short: "Codex",
    bin: "codex",
    // `exec` never asks; the sandbox lets it write in the scripts folder only.
    args: (task, { workspace }) => ["exec", "--json", "--sandbox", "workspace-write", "--skip-git-repo-check", "-C", workspace, task],
    parse: parseCodex,
  },
  {
    id: "gemini",
    name: "Gemini CLI",
    short: "Gemini",
    bin: "gemini",
    // --skip-trust: otherwise an untrusted folder silently turns auto-edit back off.
    args: (task) => ["-p", task, "--approval-mode", "auto_edit", "--output-format", "stream-json", "--skip-trust"],
    parse: parseGemini,
  },
  {
    id: "opencode",
    name: "OpenCode",
    short: "OpenCode",
    bin: "opencode",
    // --auto approves its own requests; without it they are refused when nobody can answer.
    args: (task) => ["run", "--format", "json", "--auto", task],
    parse: parseOpenCode,
  },
];

export function detectAgents() {
  return AGENTS.filter((a) => Bun.which(a.bin)).map(({ id, name, short }) => ({ id, name, short }));
}

/**
 * Writes the task to `.yenae/tasks/` (so it never has to survive shell quoting) and returns
 * the command to run, the text for stdin, and the short instruction.
 */
export function agentCommand(agentId: string, workspace: string, prompt: string) {
  const a = AGENTS.find((x) => x.id === agentId);
  const bin = a && Bun.which(a.bin);
  if (!a || !bin) throw new Error(`${a?.name ?? agentId} isn't installed, or isn't on this computer's PATH.`);
  const dir = join(workspace, ".yenae", "tasks");
  mkdirSync(dir, { recursive: true });
  const name = `task-${new Date().toISOString().replace(/[:.]/g, "-")}.md`;
  writeFileSync(join(dir, name), prompt);
  const task = `Read .yenae/tasks/${name} and do what it asks.`;
  const args = a.args(task, { workspace, mcpConfig: join(workspace, ".mcp.json") });
  // npm installs a .cmd shim on Windows, which only cmd.exe can start. The arguments are
  // plain words and flags (the task itself is in the file or on stdin), so this is safe.
  const argv = /\.(cmd|bat)$/i.test(bin) ? ["cmd.exe", "/d", "/c", bin, ...args] : [bin, ...args];
  return { agent: a, argv, stdin: a.stdin ? prompt : undefined };
}
