import type { ServerWebSocket } from "bun";
import type { Engine } from "./engine";
import { handleMcp } from "./mcp";

/** Origins allowed to call the API from a browser: the Tauri webview and the Vite dev server. */
const ALLOWED_ORIGINS = new Set([
  "tauri://localhost",
  "http://tauri.localhost",
  "https://tauri.localhost",
  "http://localhost:1420",
  "http://127.0.0.1:1420",
]);

export function serve(engine: Engine) {
  const sockets = new Set<ServerWebSocket<unknown>>();
  const broadcast = (msg: unknown) => {
    const s = JSON.stringify(msg);
    for (const ws of sockets) ws.send(s);
  };
  engine.runs.on((m) => broadcast(m));
  engine.onChange(() => broadcast({ type: "state" }));

  const authed = (req: Request, url: URL) => {
    const h = req.headers.get("authorization");
    const token = h?.startsWith("Bearer ") ? h.slice(7) : url.searchParams.get("token");
    return token === engine.settings.token;
  };

  const cors = (req: Request): Record<string, string> => {
    const origin = req.headers.get("origin");
    if (!origin || !ALLOWED_ORIGINS.has(origin)) return {};
    return {
      "access-control-allow-origin": origin,
      "access-control-allow-headers": "authorization, content-type, mcp-protocol-version, mcp-session-id",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      vary: "origin",
    };
  };

  const json = (req: Request, data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...cors(req) } });

  return Bun.serve({
    hostname: "127.0.0.1",
    port: engine.settings.port,
    idleTimeout: 255, // MCP run_script can wait a while
    async fetch(req, server) {
      const url = new URL(req.url);
      const origin = req.headers.get("origin");
      // A web page in a browser must never drive the engine (DNS rebinding, CSRF).
      if (origin && !ALLOWED_ORIGINS.has(origin)) return new Response("Forbidden origin", { status: 403 });
      if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(req) });
      if (url.pathname === "/health") return json(req, { ok: true });
      if (!authed(req, url)) return json(req, { error: "Unauthorized" }, 401);

      if (url.pathname === "/ws") {
        return server.upgrade(req) ? undefined : new Response("Upgrade failed", { status: 400 });
      }

      if (url.pathname === "/mcp") {
        if (req.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });
        const out = await handleMcp(engine, await req.json().catch(() => null));
        if (out === null) return new Response(null, { status: 202 });
        return json(req, out);
      }

      try {
        const body: any = req.method === "POST" ? await req.json().catch(() => ({})) : {};
        const q = (k: string) => url.searchParams.get(k) ?? undefined;
        switch (url.pathname) {
          case "/api/state":
            await engine.scanning;
            return json(req, engine.state());
          case "/api/ai":
            return json(req, engine.aiClients());
          case "/api/ai/connect":
            return json(req, engine.connectAiClient(body.id));
          case "/api/busy":
            return json(req, engine.busy());
          case "/api/rescan":
            await engine.rescan();
            return json(req, engine.state());
          case "/api/run":
            await engine.scanning;
            return json(req, { id: engine.run(body.script, body.params ?? {}, "manual").id });
          case "/api/runs":
            return json(req, engine.store.listRuns(q("script"), Number(q("limit") ?? 50)));
          case "/api/run/get": {
            const run = engine.runs.get(q("id") ?? "");
            return run ? json(req, run) : json(req, { error: "Not found" }, 404);
          }
          case "/api/run/stop":
            engine.runs.stop(body.run);
            return json(req, { ok: true });
          case "/api/run/answer":
            engine.runs.answer(body.run, body.id, body.value);
            return json(req, { ok: true });
          case "/api/schedule":
            return json(req, engine.setSchedule(body.script, body.every, body.params ?? {}, !!body.enabled));
          case "/api/layout":
            await engine.scanning;
            return json(req, engine.saveLayout(body.layout));
          case "/api/settings":
            engine.saveSettings({ workspace: body.workspace });
            await engine.scanning;
            return json(req, engine.state());
          case "/api/project":
            return json(req, { id: await engine.newProject(body.name) });
          case "/api/script":
            return json(req, await engine.newScript(body.project, body.file, body.description ?? "", body.harness));
          case "/api/edit-with":
            return json(req, { run: engine.editWith(body.script, body.harness, body.instructions ?? "") });
          case "/api/open":
            engine.open(body.script);
            return json(req, { ok: true });
          default:
            return json(req, { error: "Not found" }, 404);
        }
      } catch (e: any) {
        return json(req, { error: e?.message ?? String(e) }, 400);
      }
    },
    websocket: {
      open(ws) {
        sockets.add(ws);
      },
      close(ws) {
        sockets.delete(ws);
      },
      message() {},
    },
  });
}
