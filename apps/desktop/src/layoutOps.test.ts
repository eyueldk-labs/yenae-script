import { expect, test } from "bun:test";
import type { Layout } from "./api";
import { folderWith, moveFolder, moveScript, moveToFolder, renameFolder, ungroup, foldersOf, toggleInFolder } from "./layoutOps";

const base: Layout = {
  favourites: [],
  items: [
    { type: "script", id: "a" },
    { type: "script", id: "b" },
    { type: "folder", id: "f", name: "Tools", scripts: ["c", "d"] },
    { type: "script", id: "e" },
  ],
};
const shape = (l: Layout) => l.items.map((i) => (i.type === "script" ? i.id : `${i.name}[${i.scripts.join(",")}]`));

test("dropping a script onto another makes a folder in its place", () => {
  const { layout, created } = moveScript(base, "e", { kind: "into", ref: "a" });
  expect(shape(layout)).toEqual(["New group[a,e]", "b", "Tools[c,d]"]);
  expect(layout.items[0]!.id).toBe(created!);
});

test("dropping onto a folder adds to it; before/after reorders", () => {
  expect(shape(moveScript(base, "a", { kind: "into", ref: "f" }).layout)).toEqual(["b", "Tools[c,d,a]", "e"]);
  expect(shape(moveScript(base, "e", { kind: "before", ref: "a" }).layout)).toEqual(["e", "a", "b", "Tools[c,d]"]);
  expect(shape(moveScript(base, "a", { kind: "after", ref: "c" }).layout)).toEqual(["b", "Tools[c,a,d]", "e"]);
});

test("moving the last script out of a folder removes the folder", () => {
  const one = moveToFolder(moveToFolder(base, "c", null), "d", null);
  expect(shape(one)).toEqual(["a", "b", "e", "c", "d"]);
});

test("folders: make, rename, move, ungroup", () => {
  const { layout, created } = folderWith(base, "b", "Mine");
  expect(shape(layout)).toEqual(["a", "Mine[b]", "Tools[c,d]", "e"]);
  expect(shape(renameFolder(layout, created, "  Ours "))).toEqual(["a", "Ours[b]", "Tools[c,d]", "e"]);
  expect(shape(moveFolder(base, "f", "before", "a"))).toEqual(["Tools[c,d]", "a", "b", "e"]);
  expect(shape(ungroup(base, "f"))).toEqual(["a", "b", "c", "d", "e"]);
});

test("a script can be added to a second folder and taken out of one", () => {
  const base = { favourites: [], items: [{ type: "folder" as const, id: "f1", name: "Work", scripts: ["a.ts"] }, { type: "folder" as const, id: "f2", name: "Daily", scripts: ["b.ts"] }] };
  const both = toggleInFolder(base, "a.ts", "f2");
  expect(foldersOf(both, "a.ts").map((f) => f.id)).toEqual(["f1", "f2"]);
  const out = toggleInFolder(both, "a.ts", "f1");
  expect(foldersOf(out, "a.ts").map((f) => f.id)).toEqual(["f2"]);
  const none = toggleInFolder(out, "a.ts", "f2");
  expect(none.items.some((i) => i.type === "script" && i.id === "a.ts")).toBe(true);
});

test("dragging out of one folder leaves it in the others", () => {
  const base = { favourites: [], items: [{ type: "folder" as const, id: "f1", name: "Work", scripts: ["a.ts", "c.ts"] }, { type: "folder" as const, id: "f2", name: "Daily", scripts: ["a.ts", "b.ts"] }] };
  const { layout } = moveScript(base, "a.ts", { kind: "after", ref: "b.ts", in: "f2" }, "f1");
  expect(foldersOf(layout, "a.ts").map((f) => f.id)).toEqual(["f2"]);
  expect((layout.items[1] as any).scripts).toEqual(["b.ts", "a.ts"]);
});
