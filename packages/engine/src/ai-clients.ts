import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * AI apps that can use Yenae Script's tools (run a script, read its results, write new
 * ones) through MCP. For each: whether it's on this computer, whether it's connected, a
 * one-click way to connect it, and instructions to do it by hand.
 *
 * Commands and file formats verified against each app's docs and source (Nov 2026).
 */
export const NAME = "yenae-script";

export interface AiClient {
  id: string;
  name: string;
  /** Installed on this computer (as far as we can tell). */
  found: boolean;
  /** Already set up to use Yenae Script. */
  connected: boolean;
  /** The app can connect it with one click. */
  canConnect: boolean;
  /** How to do it by hand. */
  steps: { text: string; code?: string }[];
}

interface Conn {
  url: string;
  token: string;
  /** The Bun that runs the engine (bundled with the app). */
  bun: string;
  workspace: string;
}

const home = homedir();
const appData = process.env.APPDATA ?? join(home, "AppData", "Roaming");

function readJson(path: string): any {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(path: string, data: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
}

/** Adds or replaces our entry under `key` in a JSON config file, keeping everything else. */
function mergeJson(path: string, key: string, entry: unknown) {
  const cfg = readJson(path) ?? {};
  cfg[key] ??= {};
  cfg[key][NAME] = entry;
  writeJson(path, cfg);
}

const hasEntry = (path: string, key: string) => !!readJson(path)?.[key]?.[NAME];

function run(argv: string[]) {
  const bin = Bun.which(argv[0]!);
  if (!bin) throw new Error(`${argv[0]} isn't on this computer's PATH.`);
  const cmd = /\.(cmd|bat)$/i.test(bin) ? ["cmd.exe", "/d", "/c", bin, ...argv.slice(1)] : [bin, ...argv.slice(1)];
  const p = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe", windowsHide: true } as any);
  if (p.exitCode !== 0) throw new Error((p.stderr.toString() || p.stdout.toString()).trim().split("\n").slice(-2).join(" ") || "It didn't work.");
}

/** The small program Claude Desktop starts: it passes MCP messages to Yenae Script. */
export function bridgePath(workspace: string) {
  return join(workspace, ".yenae", "mcp-bridge.js");
}

/**
 * Claude Desktop only starts local programs (stdio); it can't reach an address with a key.
 * This bridge, run by the app's own Bun, reads MCP messages on stdin and posts them to
 * Yenae Script. Written into the scripts folder so its path stays the same across updates.
 */
const BRIDGE = `// Written by Yenae Script: lets apps that only start local programs (like Claude Desktop) use it.
const url = process.env.YENAE_MCP_URL, token = process.env.YENAE_MCP_TOKEN;
let session = "";
let buf = "";
const post = async (line) => {
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: "Bearer " + token };
  if (session) headers["mcp-session-id"] = session;
  try {
    const res = await fetch(url, { method: "POST", headers, body: line });
    session = res.headers.get("mcp-session-id") || session;
    const text = await res.text();
    if (!text.trim()) return;
    if ((res.headers.get("content-type") || "").includes("text/event-stream")) {
      for (const l of text.split("\\n")) if (l.startsWith("data:")) process.stdout.write(l.slice(5).trim() + "\\n");
    } else process.stdout.write(text.trim() + "\\n");
  } catch (e) {
    const msg = JSON.parse(line);
    if (msg.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "Yenae Script isn't running. Open it and try again." } }) + "\\n");
  }
};
let chain = Promise.resolve();
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (line) chain = chain.then(() => post(line));
  }
});
`;

export function ensureBridge(workspace: string) {
  const p = bridgePath(workspace);
  try {
    if (readFileSync(p, "utf8") === BRIDGE) return;
  } catch {}
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, BRIDGE);
}

const header = (c: Conn) => `Authorization: Bearer ${c.token}`;

type Def = {
  id: string;
  name: string;
  found: () => boolean;
  connected: (c: Conn) => boolean;
  connect?: (c: Conn) => void;
  /** The file holding its settings, to see whether they still point at this app. */
  file?: () => string;
  steps: (c: Conn) => AiClient["steps"];
};

const claudeDesktopConfig = () =>
  process.platform === "win32"
    ? join(appData, "Claude", "claude_desktop_config.json")
    : process.platform === "darwin"
      ? join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json")
      : join(home, ".config", "Claude", "claude_desktop_config.json");

const desktopEntry = (c: Conn) => ({
  command: c.bun,
  args: [bridgePath(c.workspace)],
  env: { YENAE_MCP_URL: c.url, YENAE_MCP_TOKEN: c.token },
});

const codexConfig = () => join(process.env.CODEX_HOME ?? join(home, ".codex"), "config.toml");
const codexToml = (c: Conn) => `[mcp_servers.${NAME}]\nurl = "${c.url}"\nhttp_headers = { "Authorization" = "Bearer ${c.token}" }\n`;

const DEFS: Def[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    found: () => !!Bun.which("claude"),
    connected: () => hasEntry(join(home, ".claude.json"), "mcpServers"),
    file: () => join(home, ".claude.json"),
    connect: (c) => {
      try {
        run(["claude", "mcp", "remove", "--scope", "user", NAME]);
      } catch {}
      run(["claude", "mcp", "add", "--transport", "http", "--scope", "user", NAME, c.url, "--header", header(c)]);
    },
    steps: (c) => [{ text: "In a terminal:", code: `claude mcp add --transport http --scope user ${NAME} ${c.url} --header "${header(c)}"` }],
  },
  {
    id: "claude-desktop",
    name: "Claude Desktop",
    found: () => existsSync(dirname(claudeDesktopConfig())),
    connected: () => hasEntry(claudeDesktopConfig(), "mcpServers"),
    file: claudeDesktopConfig,
    connect: (c) => mergeJson(claudeDesktopConfig(), "mcpServers", desktopEntry(c)),
    steps: (c) => [
      { text: `Open Claude Desktop → Settings → Developer → Edit Config, add this under "mcpServers", save, and restart Claude:`, code: JSON.stringify({ [NAME]: desktopEntry(c) }, null, 2) },
    ],
  },
  {
    id: "codex",
    name: "Codex",
    found: () => !!Bun.which("codex") || existsSync(dirname(codexConfig())),
    connected: () => {
      try {
        return readFileSync(codexConfig(), "utf8").includes(`[mcp_servers.${NAME}]`);
      } catch {
        return false;
      }
    },
    file: codexConfig,
    connect: (c) => {
      const p = codexConfig();
      let t = "";
      try {
        t = readFileSync(p, "utf8");
      } catch {}
      // Replace our section if it's there (up to the next section), else add it.
      const re = new RegExp(`\\[mcp_servers\\.${NAME}\\][\\s\\S]*?(?=\\n\\[|$)`);
      t = re.test(t) ? t.replace(re, codexToml(c).trimEnd()) : `${t.trimEnd()}${t.trim() ? "\n\n" : ""}${codexToml(c)}`;
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, t.endsWith("\n") ? t : t + "\n");
    },
    steps: (c) => [{ text: `Add this to ${codexConfig()}:`, code: codexToml(c) }],
  },
  {
    id: "gemini",
    name: "Gemini CLI",
    found: () => !!Bun.which("gemini"),
    connected: () => hasEntry(join(home, ".gemini", "settings.json"), "mcpServers"),
    file: () => join(home, ".gemini", "settings.json"),
    connect: (c) => mergeJson(join(home, ".gemini", "settings.json"), "mcpServers", { httpUrl: c.url, headers: { Authorization: `Bearer ${c.token}` } }),
    steps: (c) => [{ text: "In a terminal:", code: `gemini mcp add --scope user --transport http --header "${header(c)}" ${NAME} ${c.url}` }],
  },
  {
    id: "cursor",
    name: "Cursor",
    found: () => !!Bun.which("cursor") || existsSync(join(home, ".cursor")),
    connected: () => hasEntry(join(home, ".cursor", "mcp.json"), "mcpServers"),
    file: () => join(home, ".cursor", "mcp.json"),
    connect: (c) => mergeJson(join(home, ".cursor", "mcp.json"), "mcpServers", { url: c.url, headers: { Authorization: `Bearer ${c.token}` } }),
    steps: (c) => [
      { text: `Add this under "mcpServers" in ${join(home, ".cursor", "mcp.json")}:`, code: JSON.stringify({ [NAME]: { url: c.url, headers: { Authorization: `Bearer ${c.token}` } } }, null, 2) },
    ],
  },
  {
    id: "vscode",
    name: "VS Code (Copilot)",
    found: () => !!Bun.which("code") || existsSync(join(home, ".copilot")),
    connected: () => hasEntry(join(process.env.COPILOT_HOME ?? join(home, ".copilot"), "mcp-config.json"), "mcpServers"),
    file: () => join(process.env.COPILOT_HOME ?? join(home, ".copilot"), "mcp-config.json"),
    connect: (c) =>
      mergeJson(join(process.env.COPILOT_HOME ?? join(home, ".copilot"), "mcp-config.json"), "mcpServers", {
        type: "http",
        url: c.url,
        headers: { Authorization: `Bearer ${c.token}` },
        tools: ["*"],
      }),
    steps: (c) => [
      {
        text: "In a terminal:",
        code: `code --add-mcp '${JSON.stringify({ name: NAME, type: "http", url: c.url, headers: { Authorization: `Bearer ${c.token}` } })}'`,
      },
    ],
  },
  {
    id: "opencode",
    name: "OpenCode",
    found: () => !!Bun.which("opencode"),
    connected: () => {
      const cfg = readJson(join(home, ".config", "opencode", "opencode.json"));
      return !!(cfg?.mcp?.servers?.[NAME] ?? cfg?.mcp?.[NAME]);
    },
    steps: (c) => [{ text: "In a terminal:", code: `opencode mcp add ${NAME} --global --url ${c.url} --header Authorization="Bearer ${c.token}"` }],
  },
];

export function aiClients(c: Conn): AiClient[] {
  return DEFS.map((d) => ({
    id: d.id,
    name: d.name,
    found: safe(d.found),
    connected: safe(() => d.connected(c)),
    canConnect: !!d.connect,
    steps: d.steps(c),
  }));
}

export function connectAiClient(id: string, c: Conn) {
  const d = DEFS.find((x) => x.id === id);
  if (!d?.connect) throw new Error("Connect it by hand with the steps shown.");
  if (id === "claude-desktop") ensureBridge(c.workspace);
  d.connect(c);
}

/**
 * After the app moved to another port, updates the AI apps that were connected to it, so
 * they keep working without being set up again.
 */
export function resyncAiClients(c: Conn) {
  for (const d of DEFS) {
    if (!d.connect || !d.file || !safe(() => d.connected(c))) continue;
    try {
      if (readFileSync(d.file(), "utf8").includes(c.url)) continue;
      if (d.id === "claude-desktop") ensureBridge(c.workspace);
      d.connect(c);
    } catch {}
  }
}

function safe(f: () => boolean) {
  try {
    return f();
  } catch {
    return false;
  }
}
