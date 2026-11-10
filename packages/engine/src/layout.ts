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
  const seen = new Set<string>();
  const take = (id: unknown) => {
    if (typeof id !== "string" || !known.has(id) || seen.has(id)) return null;
    seen.add(id);
    return id;
  };
  const src = (raw && typeof raw === "object" ? raw : {}) as Partial<Layout>;
  const items: LayoutItem[] = [];
  const folderIds = new Set<string>();
  for (const it of Array.isArray(src.items) ? src.items : []) {
    if (it?.type === "script") {
      const id = take(it.id);
      if (id) items.push({ type: "script", id });
    } else if (it?.type === "folder") {
      const scripts = (Array.isArray(it.scripts) ? it.scripts : []).map(take).filter((x): x is string => !!x);
      let id = typeof it.id === "string" && it.id ? it.id : `f${items.length}`;
      while (folderIds.has(id)) id += "_";
      folderIds.add(id);
      const name = typeof it.name === "string" && it.name.trim() ? it.name.trim().slice(0, 60) : "Folder";
      if (scripts.length) items.push({ type: "folder", id, name, scripts });
    }
  }
  for (const id of [...scriptIds].sort()) if (!seen.has(id)) items.push({ type: "script", id });
  const favourites = [...new Set((Array.isArray(src.favourites) ? src.favourites : []).filter((id) => typeof id === "string" && known.has(id)))];
  return { favourites, items };
}
