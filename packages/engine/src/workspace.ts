import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ICONS } from "yenae-script";
import { insideWorkspace, SDK_SOURCE } from "./paths";

const ICON_LIST = ICONS.map((i) => `\`${i}\``).join(", ");

const SDK_VERSION = "0.1.0";

export const AGENTS_MD = `# Yenae Script workspace

Each folder with a \`package.json\` is a package: its own npm package, holding one or more scripts.
A new script usually gets a package of its own. Scripts are TypeScript files under the package's
\`scripts/\` folder. (How scripts are grouped in the app's launcher is separate, and kept by the app.)
Put shared code in \`lib/\` (never listed as scripts). Files starting with \`_\` are skipped too.

\`\`\`
my-package/
  package.json        # npm packages for the scripts in this package
  scripts/
    hello.ts          # one script
    backups/nightly.ts
  lib/helpers.ts      # imported by scripts
\`\`\`

## Writing a script

Keep scripts minimal: do exactly what the person asked, plus only what the task can't do
without. Don't add extra features, options or settings. People want to press Run and get the
result, so pick sensible values yourself, and only add a form field for something that truly
differs from run to run (like which folder). Every field gets a default that works.

\`\`\`ts
import { defineScript, text, number, boolean, select, file, folder, ask, show } from "yenae-script";
import { homedir } from "node:os";
import { join } from "node:path";

export default defineScript({
  name: "Resize images",
  description: "Shrink every image in a folder.",
  icon: "image", // the tile icon; see ICONS in yenae-script for the names
  params: {
    // Only what changes from run to run, each with a default that works.
    source: folder().label("Images").default(join(homedir(), "Pictures")),
  },
  // Suggested schedule; the user switches it on in the app.
  // schedule: { every: "10m" },
  async run({ source }) {
    const width = 1280; // a sensible fixed choice, not a setting
    console.log("plain output shows live in the app");
    if (!(await ask.confirm(\`Resize images in \${source}?\`))) return "Cancelled";
    show.table([{ file: "a.png", before: "2 MB", after: "300 KB" }]);
    show.markdown("**Done**");
    return "Resized 1 image"; // a returned string, array of rows or object is shown as the result
  },
});
\`\`\`

- Give every script a short \`name\`, a one-line \`description\` and an \`icon\`: the app shows them on its tile.
  Icons: ${ICON_LIST}.
- Params become a form; most scripts need none or one. Kinds: \`text\`, \`number\`, \`boolean\`, \`select\`, \`file\`, \`folder\`.
  Modifiers: \`.label()\`, \`.describe()\`, \`.default()\`, \`.optional()\`.
- Ask while running: \`ask.text\`, \`ask.select\`, \`ask.confirm\`, \`ask.file\`, \`ask.folder\`.
- Show results: \`show.text\`, \`show.markdown\`, \`show.table(rows)\`.
- Keep all work inside \`run\`. The app imports the file to read its params, so top-level code runs then too.
- A file without \`defineScript\` is a plain script: it runs top to bottom with no form.
- Add npm packages with \`bun add <pkg>\` inside the package. The app installs them when package.json changes.
- Scripts run with Bun, with the package folder as the working directory.
- Run one outside the app: \`bun scripts/hello.ts --name=value\`.

## Tools for agents

The Yenae Script MCP server (see \`.mcp.json\`) can list scripts, run them with params,
answer their questions, read run output and set schedules. After writing a script,
run it through MCP to check it works.
`;

export function ensureWorkspace(workspace: string, mcp: { url: string; token: string }) {
  mkdirSync(join(workspace, ".yenae", "sdk"), { recursive: true });

  // The SDK is copied into the workspace so projects can depend on it without npm.
  const sdkDir = join(workspace, ".yenae", "sdk");
  const src = readFileSync(SDK_SOURCE, "utf8");
  writeIfChanged(join(sdkDir, "index.ts"), src);
  writeIfChanged(
    join(sdkDir, "package.json"),
    JSON.stringify(
      { name: "yenae-script", version: SDK_VERSION, type: "module", main: "index.ts", types: "index.ts", exports: { ".": "./index.ts" } },
      null,
      2,
    ) + "\n",
  );

  // Kept current with the app, unless someone rewrote it by hand.
  const agentsMd = join(workspace, "AGENTS.md");
  if (!existsSync(agentsMd) || readFileSync(agentsMd, "utf8").startsWith("# Yenae Script workspace\n")) writeIfChanged(agentsMd, AGENTS_MD);
  writeIfMissing(join(workspace, "CLAUDE.md"), "@AGENTS.md\n");
  // .mcp.json holds the engine token, so keep it out of git.
  writeIfMissing(join(workspace, ".gitignore"), "node_modules/\n.yenae/\n.mcp.json\n");

  // Agents opened in the workspace find the MCP server here.
  const mcpPath = join(workspace, ".mcp.json");
  let mcpJson: any = {};
  try {
    mcpJson = JSON.parse(readFileSync(mcpPath, "utf8"));
  } catch {}
  mcpJson.mcpServers ??= {};
  mcpJson.mcpServers["yenae-script"] = {
    type: "http",
    url: mcp.url,
    headers: { Authorization: `Bearer ${mcp.token}` },
  };
  writeIfChanged(mcpPath, JSON.stringify(mcpJson, null, 2) + "\n");
}

/**
 * A brand-new scripts folder gets one "Examples" project, so the app opens with something
 * to try. Done once: delete the examples and they stay gone.
 */
export function seedExamples(workspace: string) {
  const marker = join(workspace, ".yenae", "examples-added");
  if (existsSync(marker)) return;
  const hasProject = readdirSync(workspace, { withFileTypes: true }).some(
    (d) => d.isDirectory() && !d.name.startsWith(".") && existsSync(join(workspace, d.name, "package.json")),
  );
  if (!hasProject && !existsSync(join(workspace, "examples"))) {
    createProject(workspace, "examples");
    for (const [file, body] of Object.entries(EXAMPLES)) writeFileSync(join(workspace, "examples", "scripts", file), body);
  }
  mkdirSync(join(workspace, ".yenae"), { recursive: true });
  writeFileSync(marker, new Date().toISOString() + "\n");
}

const EXAMPLES: Record<string, string> = {
  "say-hello.ts": `import { defineScript, text, number, ask, show } from "yenae-script";

// A first script: fill in the form, press Run now, then answer its question.
export default defineScript({
  name: "Say hello",
  description: "Try me: fill in your name, press Run now and answer the question.",
  icon: "message",
  params: {
    name: text().label("Your name").default("friend"),
    times: number({ min: 1, max: 5 }).label("How many times").default(2),
  },
  async run({ name, times }) {
    for (let i = 1; i <= times; i++) {
      console.log(\`Hello, \${name}!\`);
      await Bun.sleep(400);
    }
    const colour = await ask.select("Pick a colour", ["Red", "Green", "Blue"]);
    show.markdown(\`**Nice to meet you, \${name}.** You picked \${colour.toLowerCase()}.\`);
  },
});
`,
  "biggest-files.ts": `import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { defineScript, folder, show } from "yenae-script";

/** 532 -> "532 B", 48213 -> "47.1 KB", 3e9 -> "2.79 GB". */
const readable = (b: number) =>
  b < 1024 ? \`\${b} B\` : b < 1024 ** 2 ? \`\${(b / 1024).toFixed(1)} KB\` : b < 1024 ** 3 ? \`\${(b / 1024 ** 2).toFixed(1)} MB\` : \`\${(b / 1024 ** 3).toFixed(2)} GB\`;

// Lists the biggest files in a folder, as a table.
export default defineScript({
  name: "Biggest files",
  description: "Shows the 15 biggest files in a folder you choose.",
  icon: "chart",
  params: {
    dir: folder().label("Folder to check"),
  },
  async run({ dir }) {
    const rows = readdirSync(dir)
      .map((name) => {
        try {
          const s = statSync(join(dir, name));
          return s.isFile() ? { file: name, size: readable(s.size), bytes: s.size } : null;
        } catch {
          return null;
        }
      })
      .filter((r) => r !== null)
      .sort((a, b) => b.bytes - a.bytes)
      .slice(0, 15)
      .map(({ file, size }) => ({ file, size }));
    if (!rows.length) return "No files in that folder.";
    show.table(rows);
  },
});
`,
};

export function createProject(workspace: string, name: string): string {
  const slug = slugify(name);
  if (!slug) throw new Error("Give the package a name.");
  const dir = insideWorkspace(workspace, slug);
  if (existsSync(join(dir, "package.json"))) throw new Error(`Package "${slug}" already exists.`);
  mkdirSync(join(dir, "scripts"), { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify(
      { name: slug, private: true, type: "module", dependencies: { "yenae-script": "file:../.yenae/sdk" } },
      null,
      2,
    ) + "\n",
  );
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          target: "ESNext",
          module: "Preserve",
          moduleResolution: "Bundler",
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          allowImportingTsExtensions: true,
        },
      },
      null,
      2,
    ) + "\n",
  );
  return slug;
}

export function scriptTemplate(name: string, description: string) {
  return `import { defineScript, text, show } from "yenae-script";

export default defineScript({
  name: ${JSON.stringify(name)},
  description: ${JSON.stringify(description)},
  params: {
    message: text().default("Hello"),
  },
  async run({ message }) {
    show.text(message);
  },
});
`;
}

/** Create `<project>/scripts/<file>.ts` and return its workspace-relative path. */
export function createScript(workspace: string, project: string, file: string, description: string): string {
  let rel = file.trim().replace(/\\/g, "/").replace(/^\/+/, "");
  if (!rel) throw new Error("Give the script a file name.");
  if (!/\.[mc]?[tj]sx?$/.test(rel)) rel += ".ts";
  rel = rel
    .split("/")
    .map((part, i, all) => (i === all.length - 1 ? slugify(part.replace(/\.[^.]+$/, "")) + part.slice(part.lastIndexOf(".")) : slugify(part)))
    .join("/");
  const full = `${project}/scripts/${rel}`;
  const abs = insideWorkspace(workspace, full);
  if (existsSync(abs)) throw new Error(`${full} already exists.`);
  mkdirSync(dirname(abs), { recursive: true });
  const base = rel.split("/").pop()!.replace(/\.[^.]+$/, "").replace(/-/g, " ");
  writeFileSync(abs, scriptTemplate(base.charAt(0).toUpperCase() + base.slice(1), description));
  return full;
}

export function slugify(s: string) {
  return s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function writeIfMissing(path: string, content: string) {
  if (!existsSync(path)) writeFileSync(path, content);
}

function writeIfChanged(path: string, content: string) {
  try {
    if (readFileSync(path, "utf8") === content) return;
  } catch {}
  writeFileSync(path, content);
}
