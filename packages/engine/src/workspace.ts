import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { insideWorkspace, SDK_SOURCE } from "./paths";

const SDK_VERSION = "0.1.0";

export const AGENTS_MD = `# Yenae Script workspace

Each folder with a \`package.json\` is a project: one npm package holding related scripts.
Scripts are TypeScript files under the project's \`scripts/\` folder. Sub-folders group them.
Put shared code in \`lib/\` (never listed as scripts). Files starting with \`_\` are skipped too.

\`\`\`
my-project/
  package.json        # dependencies for every script in this project
  scripts/
    hello.ts          # one script
    backups/nightly.ts
  lib/helpers.ts      # imported by scripts
\`\`\`

## Writing a script

\`\`\`ts
import { defineScript, text, number, boolean, select, file, folder, ask, show } from "yenae-script";

export default defineScript({
  name: "Resize images",
  description: "Shrink every image in a folder.",
  params: {
    source: folder().label("Images"),
    width: number({ min: 16 }).default(1280),
    format: select(["jpg", "webp"]).default("webp"),
    dryRun: boolean().label("Dry run").default(false),
    note: text({ multiline: true }).optional(),
  },
  // Suggested schedule; the user switches it on in the app.
  // schedule: { every: "10m" },
  async run({ source, width, format, dryRun }) {
    console.log("plain output shows live in the app");
    if (!(await ask.confirm(\`Resize images in \${source}?\`))) return "Cancelled";
    show.table([{ file: "a.png", before: "2 MB", after: "300 KB" }]);
    show.markdown("**Done**");
    return "Resized 1 image"; // a returned string, array of rows or object is shown as the result
  },
});
\`\`\`

- Params become a form. Kinds: \`text\`, \`number\`, \`boolean\`, \`select\`, \`file\`, \`folder\`.
  Modifiers: \`.label()\`, \`.describe()\`, \`.default()\`, \`.optional()\`.
- Ask while running: \`ask.text\`, \`ask.select\`, \`ask.confirm\`, \`ask.file\`, \`ask.folder\`.
- Show results: \`show.text\`, \`show.markdown\`, \`show.table(rows)\`.
- Keep all work inside \`run\`. The app imports the file to read its params, so top-level code runs then too.
- A file without \`defineScript\` is a plain script: it runs top to bottom with no form.
- Add npm packages with \`bun add <pkg>\` inside the project. The app installs them when package.json changes.
- Scripts run with Bun, with the project folder as the working directory.
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

  writeIfMissing(join(workspace, "AGENTS.md"), AGENTS_MD);
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

export function createProject(workspace: string, name: string): string {
  const slug = slugify(name);
  if (!slug) throw new Error("Give the project a name.");
  const dir = insideWorkspace(workspace, slug);
  if (existsSync(join(dir, "package.json"))) throw new Error(`Project "${slug}" already exists.`);
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
