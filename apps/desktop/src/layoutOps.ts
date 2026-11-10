/**
 * Pure edits to the home-screen layout (favourites, folders, order). The engine
 * normalizes whatever is saved, so these only need to express the user's intent.
 */
import type { Layout, LayoutItem } from "./api";

type Folder = Extract<LayoutItem, { type: "folder" }>;

/** Where a dragged script lands: before/after/into a tile, or at the end of a container. */
export type Target =
  | { kind: "before" | "after" | "into"; ref: string }
  | { kind: "end"; container: "items" | string };

const clone = (l: Layout): Layout => ({
  favourites: [...l.favourites],
  items: l.items.map((i) => (i.type === "folder" ? { ...i, scripts: [...i.scripts] } : { ...i })),
});

export function folderOf(l: Layout, id: string): Folder | null {
  return (l.items.find((i) => i.type === "folder" && i.scripts.includes(id)) as Folder | undefined) ?? null;
}

let n = 0;
export const newFolderId = () => `f${Date.now().toString(36)}${(n++).toString(36)}`;

/** Take a script out of wherever it is. Folders left empty disappear. */
function remove(l: Layout, id: string) {
  l.items = l.items
    .filter((i) => !(i.type === "script" && i.id === id))
    .map((i) => (i.type === "folder" ? { ...i, scripts: i.scripts.filter((s) => s !== id) } : i))
    .filter((i) => i.type === "script" || i.scripts.length > 0);
}

/** Move a script (dragged tile) to a target. Returns the new layout and a folder it created, if any. */
export function moveScript(layout: Layout, id: string, target: Target): { layout: Layout; created?: string } {
  if (target.kind !== "end" && target.ref === id) return { layout };
  const l = clone(layout);
  remove(l, id);
  if (target.kind === "end") {
    if (target.container === "items") l.items.push({ type: "script", id });
    else (l.items.find((i) => i.type === "folder" && i.id === target.container) as Folder | undefined)?.scripts.push(id);
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
  // The ref is a script inside a folder: stay in that folder.
  const host = folderOf(l, ref);
  if (host) {
    const at = host.scripts.indexOf(ref);
    host.scripts.splice(target.kind === "before" ? at : at + 1, 0, id);
    return { layout: l };
  }
  // The ref is a top-level script.
  const si = l.items.findIndex((i) => i.type === "script" && i.id === ref);
  if (si < 0) {
    l.items.push({ type: "script", id });
    return { layout: l };
  }
  if (target.kind === "into") {
    const created = newFolderId();
    l.items[si] = { type: "folder", id: created, name: "New folder", scripts: [ref, id] };
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

/** Put a script into a folder (null: out to the top level). */
export function moveToFolder(layout: Layout, id: string, folderId: string | null): Layout {
  return moveScript(layout, id, { kind: "end", container: folderId ?? "items" }).layout;
}

/** Make a folder holding one script, where that script was. */
export function folderWith(layout: Layout, id: string, name = "New folder"): { layout: Layout; created: string } {
  const l = clone(layout);
  const created = newFolderId();
  const si = l.items.findIndex((i) => i.type === "script" && i.id === id);
  if (si >= 0) l.items[si] = { type: "folder", id: created, name, scripts: [id] };
  else {
    remove(l, id);
    l.items.push({ type: "folder", id: created, name, scripts: [id] });
  }
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

export function toggleFavourite(layout: Layout, id: string): Layout {
  const l = clone(layout);
  l.favourites = l.favourites.includes(id) ? l.favourites.filter((x) => x !== id) : [...l.favourites, id];
  return l;
}

/** Reorder favourites: put `id` before `ref` (or at the end). */
export function moveFavourite(layout: Layout, id: string, ref: string | null, kind: "before" | "after" = "before"): Layout {
  const l = clone(layout);
  l.favourites = l.favourites.filter((x) => x !== id);
  let at = ref ? l.favourites.indexOf(ref) : -1;
  if (at < 0) at = l.favourites.length;
  else if (kind === "after") at++;
  l.favourites.splice(at, 0, id);
  return l;
}
