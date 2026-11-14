import { expect, test } from "bun:test";
import { normalizeLayout } from "../src/layout";

const ids = ["a.ts", "b.ts", "c.ts", "d.ts"];

test("new scripts are added at the end, gone ones dropped", () => {
  const l = normalizeLayout({ favourites: ["c.ts", "gone.ts"], items: [{ type: "script", id: "c.ts" }, { type: "script", id: "gone.ts" }] }, ids);
  expect(l.items.map((i) => (i.type === "script" ? i.id : i.name))).toEqual(["c.ts", "a.ts", "b.ts", "d.ts"]);
  expect(l.favourites).toEqual([]);
});

test("old favourites move to the front, in their order", () => {
  const l = normalizeLayout({ favourites: ["d.ts", "b.ts"], items: [{ type: "script", id: "a.ts" }, { type: "script", id: "b.ts" }, { type: "script", id: "c.ts" }, { type: "script", id: "d.ts" }] }, ids);
  expect(l.items.map((i) => (i.type === "script" ? i.id : i.name))).toEqual(["d.ts", "b.ts", "a.ts", "c.ts"]);
  expect(l.favourites).toEqual([]);
});

test("a script lives in one place; empty folders go away", () => {
  const l = normalizeLayout(
    {
      items: [
        { type: "folder", id: "f1", name: "  Tools ", scripts: ["a.ts", "b.ts"] },
        { type: "script", id: "a.ts" },
        { type: "folder", id: "f2", name: "Empty", scripts: ["gone.ts"] },
      ],
    },
    ids,
  );
  expect(l.items).toEqual([
    { type: "folder", id: "f1", name: "Tools", scripts: ["a.ts", "b.ts"] },
    { type: "script", id: "c.ts" },
    { type: "script", id: "d.ts" },
  ]);
});

test("garbage input gives the default order", () => {
  expect(normalizeLayout("nope", ids).items.length).toBe(4);
  expect(normalizeLayout({ items: [null, { type: "folder" }] }, ids).items.length).toBe(4);
});

test("a script can be in several folders, and isn't also listed on its own", () => {
  const ids = ["a.ts", "b.ts", "c.ts"];
  const l = normalizeLayout(
    {
      favourites: [],
      items: [
        { type: "script", id: "a.ts" },
        { type: "folder", id: "f1", name: "Work", scripts: ["a.ts", "b.ts", "a.ts"] },
        { type: "folder", id: "f2", name: "Daily", scripts: ["a.ts"] },
      ],
    },
    ids,
  );
  expect(l.items).toEqual([
    { type: "folder", id: "f1", name: "Work", scripts: ["a.ts", "b.ts"] },
    { type: "folder", id: "f2", name: "Daily", scripts: ["a.ts"] },
    { type: "script", id: "c.ts" },
  ]);
});
