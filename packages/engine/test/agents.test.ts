import { expect, test } from "bun:test";
import { AGENTS, type ParseState } from "../src/agents";

const claude = AGENTS.find((a) => a.id === "claude")!;

test("Claude's edits and command output show in the run", () => {
  const st: ParseState = {};
  const lines = [
    { type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Edit", input: { file_path: "/w/a.ts", old_string: "const x = 1;", new_string: "const x = 2;" } }] } },
    { type: "assistant", message: { content: [{ type: "tool_use", id: "t2", name: "Bash", input: { command: "bun scripts/a.ts" } }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t2", content: "hello\nworld" }] } },
    { type: "assistant", message: { content: [{ type: "tool_use", id: "t3", name: "mcp__yenae-script__whatever_tool", input: {} }] } },
  ];
  const ev = lines.flatMap((l) => claude.parse(JSON.stringify(l), st));
  const text = ev.map((e: any) => `${e.t}:${e.text ?? ""}`);
  expect(text).toEqual([
    "sys:Editing a.ts",
    "out:- const x = 1;\n+ const x = 2;\n",
    "sys:Running: bun scripts/a.ts",
    "out:hello\nworld\n",
    "sys:Using whatever tool",
  ]);
});

test("tools Claude wasn't allowed to use are said in words", () => {
  const ev = claude.parse(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "Done.", permission_denials: [{ tool_name: "mcp__chrome-devtools__new_page" }] }), {});
  expect(ev.map((e: any) => e.text ?? e.item?.markdown)).toEqual(["Done.", "Not allowed here: new page"]);
});

test("the agents only load the app's own MCP server", () => {
  const ctx = { workspace: "/w", mcpConfig: "/w/.mcp.json" };
  expect(claude.args("t", ctx)).toContain("--strict-mcp-config");
  expect(AGENTS.find((a) => a.id === "gemini")!.args("t", ctx).join(" ")).toContain("--allowed-mcp-server-names yenae-script");
});
