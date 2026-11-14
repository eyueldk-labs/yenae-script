/**
 * A small MCP server (Streamable HTTP, JSON responses) so local agents can find,
 * write, run and schedule scripts. Served at /mcp on the engine's port.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Engine } from "./engine";
import { AGENTS_MD } from "./workspace";
import { insideWorkspace } from "./paths";
import type { RunEvent } from "./db";

const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

type Tool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  call: (args: any) => Promise<unknown> | unknown;
};

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required });
const str = (description: string) => ({ type: "string", description });

export function mcpTools(engine: Engine): Tool[] {
  const runReport = async (runId: string, waitSeconds: number) => {
    const live = engine.runs.live.get(runId);
    if (live && waitSeconds > 0) {
      await Promise.race([
        engine.runs.whenDone(runId),
        new Promise((r) => setTimeout(r, waitSeconds * 1000)),
        // Return early when the script asks something.
        new Promise<void>((r) => {
          const off = engine.runs.on((m) => {
            if (m.type === "run" && m.run.id === runId && m.run.pendingAsk) {
              off();
              r();
            }
          });
          if (live.pendingAsk) r();
        }),
      ]);
    }
    const run = engine.runs.get(runId);
    if (!run) throw new Error(`No run ${runId}`);
    return formatRun(run as any);
  };

  return [
    {
      name: "guide",
      description: "How Yenae Script projects and scripts are laid out and written. Read before writing a script.",
      inputSchema: obj({}),
      call: () => `Workspace: ${engine.settings.workspace}\n\n${AGENTS_MD}`,
    },
    {
      name: "list_scripts",
      description: "List scripts in the workspace with their params and schedules.",
      inputSchema: obj({ query: str("Optional text to filter by name, description or path") }),
      call: async ({ query }) => {
        await engine.scanning;
        const q = (query ?? "").toLowerCase();
        const schedules = engine.store.schedules();
        return engine.scripts
          .filter((s) => !q || `${s.id} ${s.name} ${s.description ?? ""}`.toLowerCase().includes(q))
          .map((s) => ({
            script: s.id,
            name: s.name,
            description: s.description,
            params: s.params,
            error: s.error,
            schedule: schedules.find((x) => x.script === s.id) ?? null,
          }));
      },
    },
    {
      name: "read_file",
      description: "Read a file in the workspace. Path is relative to the workspace root.",
      inputSchema: obj({ path: str("e.g. my-package/scripts/hello.ts") }, ["path"]),
      call: ({ path }) => readFileSync(insideWorkspace(engine.settings.workspace, path), "utf8"),
    },
    {
      name: "write_file",
      description:
        "Create or overwrite a file in the workspace. Scripts go in <package>/scripts/. A new script usually gets its own package: create it first with create_package.",
      inputSchema: obj({ path: str("Workspace-relative path"), content: str("Full file content") }, ["path", "content"]),
      call: async ({ path, content }) => {
        if (/(^|[\\/])(node_modules|\.yenae)([\\/]|$)/.test(path)) throw new Error("That folder is managed by the app.");
        const abs = insideWorkspace(engine.settings.workspace, path);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, content);
        await engine.rescan();
        const s = engine.scripts.find((x) => x.id === path.replace(/\\/g, "/"));
        return s ? { written: path, script: s.id, name: s.name, params: s.params, error: s.error } : { written: path };
      },
    },
    {
      name: "create_package",
      description: "Create a package: a folder with its own package.json and scripts/. Returns its folder name.",
      inputSchema: obj({ name: str("Package name, e.g. chrome-tools") }, ["name"]),
      call: async ({ name }) => ({ package: await engine.newProject(name) }),
    },
    {
      name: "run_script",
      description:
        "Run a script and wait for it (up to wait_seconds). Returns status, output and results. If the script asks a question, returns it; reply with answer_question.",
      inputSchema: obj(
        {
          script: str("Script path from list_scripts"),
          params: { type: "object", description: "Param values by name" },
          wait_seconds: { type: "number", description: "Default 60" },
        },
        ["script"],
      ),
      call: async ({ script, params, wait_seconds }) => {
        await engine.scanning;
        const run = engine.run(script, params ?? {}, "mcp");
        return runReport(run.id, wait_seconds ?? 60);
      },
    },
    {
      name: "get_run",
      description: "Status and output of a run, optionally waiting for it to finish.",
      inputSchema: obj({ run: str("Run id"), wait_seconds: { type: "number" } }, ["run"]),
      call: ({ run, wait_seconds }) => runReport(run, wait_seconds ?? 0),
    },
    {
      name: "answer_question",
      description: "Answer the question a running script is waiting on, then wait for more output.",
      inputSchema: obj(
        {
          run: str("Run id"),
          value: { description: "text/file/folder: string; select: option value; confirm: boolean" },
          wait_seconds: { type: "number" },
        },
        ["run", "value"],
      ),
      call: ({ run, value, wait_seconds }) => {
        const live = engine.runs.live.get(run);
        if (!live?.pendingAsk) throw new Error("That run isn't waiting for an answer.");
        engine.runs.answer(run, live.pendingAsk.id, value);
        return runReport(run, wait_seconds ?? 60);
      },
    },
    {
      name: "stop_run",
      description: "Stop a running script.",
      inputSchema: obj({ run: str("Run id") }, ["run"]),
      call: async ({ run }) => {
        engine.runs.stop(run);
        return runReport(run, 5);
      },
    },
    {
      name: "list_runs",
      description: "Recent runs, newest first.",
      inputSchema: obj({ script: str("Optional script path"), limit: { type: "number" } }),
      call: ({ script, limit }) => engine.store.listRuns(script, Math.min(limit ?? 20, 100)),
    },
    {
      name: "set_schedule",
      description: "Run a script on an interval while the app is open, e.g. every 10m. Set enabled false to turn it off.",
      inputSchema: obj(
        {
          script: str("Script path"),
          every: str("Interval: 30s, 10m, 2h or 1d"),
          enabled: { type: "boolean" },
          params: { type: "object", description: "Param values used for scheduled runs" },
        },
        ["script", "every", "enabled"],
      ),
      call: ({ script, every, enabled, params }) => engine.setSchedule(script, every, params ?? {}, enabled),
    },
  ];
}

function formatRun(run: { id: string; script: string; status: string; exitCode: number | null; error: string | null; events: RunEvent[]; pendingAsk: any }) {
  let output = "";
  const results: unknown[] = [];
  for (const e of run.events) {
    if (e.t === "out" || e.t === "err" || e.t === "sys") output += e.t === "sys" ? `\n[${e.text}]\n` : e.text;
    else if (e.t === "show") results.push(e.item);
  }
  if (output.length > 20_000) output = "…(earlier output cut)\n" + output.slice(-20_000);
  return {
    run: run.id,
    script: run.script,
    status: run.status,
    exitCode: run.exitCode,
    error: run.error,
    question: run.pendingAsk?.request ?? null,
    output: output.trim(),
    results,
  };
}

/** Handle one POST /mcp body. Returns null for notifications (202, no body). */
export async function handleMcp(engine: Engine, body: any): Promise<unknown | null> {
  if (Array.isArray(body)) {
    const out = (await Promise.all(body.map((b) => handleMcp(engine, b)))).filter((x) => x !== null);
    return out.length ? out : null;
  }
  const { id, method, params } = body ?? {};
  const isNotification = id === undefined || id === null;
  const reply = (result: unknown) => ({ jsonrpc: "2.0", id, result });
  const fail = (code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });

  try {
    switch (method) {
      case "initialize": {
        const asked = params?.protocolVersion;
        return reply({
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "yenae-script", version: "0.1.0" },
          instructions: `Yenae Script runs the user's TypeScript scripts. Workspace: ${engine.settings.workspace}. Call guide before writing a script.`,
        });
      }
      case "ping":
        return reply({});
      case "tools/list":
        return reply({
          tools: mcpTools(engine).map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
        });
      case "tools/call": {
        const tool = mcpTools(engine).find((t) => t.name === params?.name);
        if (!tool) return fail(-32602, `Unknown tool ${params?.name}`);
        try {
          const result = await tool.call(params?.arguments ?? {});
          const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
          return reply({ content: [{ type: "text", text }], isError: false });
        } catch (e: any) {
          return reply({ content: [{ type: "text", text: e?.message ?? String(e) }], isError: true });
        }
      }
      default:
        if (isNotification) return null;
        return fail(-32601, `Method not found: ${method}`);
    }
  } catch (e: any) {
    return isNotification ? null : fail(-32603, e?.message ?? String(e));
  }
}

