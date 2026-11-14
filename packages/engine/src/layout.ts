/**
 * How the user arranged the home screen: favourites, folders and order. It lives in
 * the app's database, never on disk, so arranging never moves a script file.
 */

export type LayoutItem = { type: "script"; id: string } | { type: "folder"; id: string; name: string; scripts: string[] };

export interface Layout {
  favourites: string[];
  items: LayoutItem[];
}

export const EMPTY_LAYOUT: Layout = { favourites: [], items: [] };

/**
 * Make a saved (or client-sent) layout fit the scripts that exist now: drop gone or
 * repeated scripts, drop empty folders, and add new scripts at the end.
 */
export function normalizeLayout(raw: unknown, scriptIds: string[]): Layout {
  const known = new Set(scriptIds);
  const src = (raw && typeof raw === "object" ? raw : {}) as Partial<Layout>;
  const rawItems = Array.isArray(src.items) ? src.items : [];
  // A script can be in several folders (once in each). One that's in a folder isn't also
  // listed on its own at the top.
  const inFolder = new Set<string>();
  for (const it of rawItems)
    if (it?.type === "folder" && Array.isArray(it.scripts)) for (const id of it.scripts) if (typeof id === "string" && known.has(id)) inFolder.add(id);
  const seen = new Set<string>(inFolder);
  const topSeen = new Set<string>();
  const items: LayoutItem[] = [];
  const folderIds = new Set<string>();
  for (const it of rawItems) {
    if (it?.type === "script") {
      const id = it.id;
      if (typeof id !== "string" || !known.has(id) || inFolder.has(id) || topSeen.has(id)) continue;
      topSeen.add(id);
      seen.add(id);
      items.push({ type: "script", id });
    } else if (it?.type === "folder") {
      const scripts = [...new Set((Array.isArray(it.scripts) ? it.scripts : []).filter((id): id is string => typeof id === "string" && known.has(id)))];
      let id = typeof it.id === "string" && it.id ? it.id : `f${items.length}`;
      while (folderIds.has(id)) id += "_";
      folderIds.add(id);
      const name = typeof it.name === "string" && it.name.trim() ? it.name.trim().slice(0, 60) : "Folder";
      if (scripts.length) items.push({ type: "folder", id, name, scripts });
    }
  }
  for (const id of [...scriptIds].sort()) if (!seen.has(id)) items.push({ type: "script", id });
  // Favourites are gone: scripts that were favourites move to the front instead, once.
  const favs = [...new Set((Array.isArray(src.favourites) ? src.favourites : []).filter((id) => typeof id === "string" && known.has(id)))];
  if (favs.length) {
    const rank = (it: LayoutItem) => (it.type === "script" && favs.includes(it.id) ? favs.indexOf(it.id) : favs.length);
    items.sort((a, b) => rank(a) - rank(b));
  }
  return { favourites: [], items };
}
