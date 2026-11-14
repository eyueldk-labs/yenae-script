/**
 * Pure edits to the home-screen layout (favourites, folders, order). The engine
 * normalizes whatever is saved, so these only need to express the user's intent.
 */
import type { Layout, LayoutItem } from "./api";

type Folder = Extract<LayoutItem, { type: "folder" }>;

/**
 * Where a dragged script lands: before/after/into a tile (`in`: the container that tile is
 * shown in, since a script can be in several folders), or at the end of a container.
 */
export type Target =
  | { kind: "before" | "after" | "into"; ref: string; in?: string }
  | { kind: "end"; container: "items" | string };

const clone = (l: Layout): Layout => ({
  favourites: [...l.favourites],
  items: l.items.map((i) => (i.type === "folder" ? { ...i, scripts: [...i.scripts] } : { ...i })),
});

export function folderOf(l: Layout, id: string): Folder | null {
  return foldersOf(l, id)[0] ?? null;
}

/** Every folder a script is in (a script can be in several). */
export function foldersOf(l: Layout, id: string): Folder[] {
  return l.items.filter((i): i is Folder => i.type === "folder" && i.scripts.includes(id));
}

let n = 0;
export const newFolderId = () => `f${Date.now().toString(36)}${(n++).toString(36)}`;

/**
 * Take a script out of one place (`from`: "items" or a folder id), or out of everywhere.
 * Folders left empty disappear.
 */
function remove(l: Layout, id: string, from?: string) {
  l.items = l.items
    .filter((i) => !(i.type === "script" && i.id === id && (!from || from === "items")))
    .map((i) => (i.type === "folder" && (!from || from === i.id) ? { ...i, scripts: i.scripts.filter((s) => s !== id) } : i))
    .filter((i) => i.type === "script" || i.scripts.length > 0);
}

/** Into a folder at a position, once: it leaves the top level, and any earlier spot in that folder. */
function putInFolder(l: Layout, f: Folder, id: string, at?: { ref: string; after: boolean }) {
  f.scripts = f.scripts.filter((s) => s !== id);
  l.items = l.items.filter((i) => !(i.type === "script" && i.id === id));
  const i = at ? f.scripts.indexOf(at.ref) : -1;
  if (i < 0) f.scripts.push(id);
  else f.scripts.splice(at!.after ? i + 1 : i, 0, id);
}

/**
 * Move a script (dragged tile) to a target, taking it out of `from` (where it was dragged
 * from; everywhere if not given). Returns the new layout and a folder it created, if any.
 */
export function moveScript(layout: Layout, id: string, target: Target, from?: string): { layout: Layout; created?: string } {
  if (target.kind !== "end" && target.ref === id) return { layout };
  const l = clone(layout);
  remove(l, id, from === "fav" ? "items" : from);
  if (target.kind === "end") {
    if (target.container === "items") {
      l.items = l.items.filter((i) => !(i.type === "script" && i.id === id));
      l.items.push({ type: "script", id });
    } else {
      const f = l.items.find((i) => i.type === "folder" && i.id === target.container) as Folder | undefined;
      if (f) putInFolder(l, f, id);
    }
    return { layout: l };
  }
  const { ref } = target;
  // The ref is a folder at the top level.
  const fi = l.items.findIndex((i) => i.type === "folder" && i.id === ref);
  if (fi >= 0) {
    const f = l.items[fi] as Folder;
    if (target.kind === "into") f.scripts.push(id);
    else l.items.splice(target.kind === "before" ? fi : fi + 1, 0, { type: "script", id });
    return { layout: l };
  }
  // The ref is a script inside a folder (the one it's shown in): go into that folder.
  const host =
    target.in && target.in !== "items" && target.in !== "fav"
      ? (l.items.find((i) => i.type === "folder" && i.id === target.in) as Folder | undefined)
      : target.in
        ? undefined
        : (folderOf(l, ref) ?? undefined);
  if (host) {
    putInFolder(l, host, id, { ref, after: target.kind !== "before" });
    return { layout: l };
  }
  l.items = l.items.filter((i) => !(i.type === "script" && i.id === id));
  // The ref is a top-level script.
  const si = l.items.findIndex((i) => i.type === "script" && i.id === ref);
  if (si < 0) {
    l.items.push({ type: "script", id });
    return { layout: l };
  }
  if (target.kind === "into") {
    const created = newFolderId();
    l.items[si] = { type: "folder", id: created, name: "New group", scripts: [ref, id] };
    return { layout: l, created };
  }
  l.items.splice(target.kind === "before" ? si : si + 1, 0, { type: "script", id });
  return { layout: l };
}

/** Move a whole folder before or after another top-level item. */
export function moveFolder(layout: Layout, folderId: string, kind: "before" | "after", ref: string): Layout {
  if (folderId === ref) return layout;
  const l = clone(layout);
  const from = l.items.findIndex((i) => i.type === "folder" && i.id === folderId);
  if (from < 0) return layout;
  const [f] = l.items.splice(from, 1);
  let to = l.items.findIndex((i) => i.id === ref);
  if (to < 0) to = l.items.length;
  else if (kind === "after") to++;
  l.items.splice(to, 0, f!);
  return l;
}

/** Put a script into a folder (null: out of every folder, to the top level). */
export function moveToFolder(layout: Layout, id: string, folderId: string | null): Layout {
  return moveScript(layout, id, { kind: "end", container: folderId ?? "items" }).layout;
}

/**
 * Add a script to a folder, keeping it in the others; or take it out of that one folder.
 * Out of its last folder, it goes back to the top level.
 */
export function toggleInFolder(layout: Layout, id: string, folderId: string): Layout {
  const l = clone(layout);
  const f = l.items.find((i) => i.type === "folder" && i.id === folderId) as Folder | undefined;
  if (!f) return layout;
  if (!f.scripts.includes(id)) {
    putInFolder(l, f, id);
    return l;
  }
  const at = l.items.indexOf(f);
  remove(l, id, folderId);
  if (!foldersOf(l, id).length) l.items.splice(Math.min(at + 1, l.items.length), 0, { type: "script", id });
  return l;
}

/** Make a folder holding one script, where that script was. */
export function folderWith(layout: Layout, id: string, name = "New group"): { layout: Layout; created: string } {
  const l = clone(layout);
  const created = newFolderId();
  const si = l.items.findIndex((i) => i.type === "script" && i.id === id);
  if (si >= 0) l.items[si] = { type: "folder", id: created, name, scripts: [id] };
  // Already in folders: it stays in them too.
  else l.items.push({ type: "folder", id: created, name, scripts: [id] });
  return { layout: l, created };
}

export function renameFolder(layout: Layout, folderId: string, name: string): Layout {
  const l = clone(layout);
  const f = l.items.find((i) => i.type === "folder" && i.id === folderId) as Folder | undefined;
  if (f && name.trim()) f.name = name.trim().slice(0, 60);
  return l;
}

/** Undo a folder: its scripts take its place, in order. */
export function ungroup(layout: Layout, folderId: string): Layout {
  const l = clone(layout);
  const at = l.items.findIndex((i) => i.type === "folder" && i.id === folderId);
  if (at < 0) return layout;
  const f = l.items[at] as Folder;
  l.items.splice(at, 1, ...f.scripts.map((id) => ({ type: "script" as const, id })));
  return l;
}
