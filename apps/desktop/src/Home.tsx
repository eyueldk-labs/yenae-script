import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Star } from "lucide-react";
import type { Api, Layout, LayoutItem, RunDetail, RunSummary, Script, State } from "./api";
import { FolderIcon, ScriptIcon } from "./icons";
import { Menu, type MenuEntry } from "./Menu";
import { labelOf } from "./Form";
import { lastLabel, isLive } from "./fmt";
import { folderOf, folderWith, moveFavourite, moveFolder, moveScript, moveToFolder, renameFolder, toggleFavourite, ungroup, type Target } from "./layoutOps";

type Folder = Extract<LayoutItem, { type: "folder" }>;
type Badge = { kind: "failed" | "waiting" | "running" | "error"; text: string } | null;

const TILE = 88;
const GAP = 8;

/** What a tile's corner says, most urgent first. */
export function badgeOf(script: Script, state: State, runs: Record<string, RunDetail>): Badge {
  const live = Object.values(runs).find((r) => r.script === script.id && isLive(r));
  if (live?.status === "waiting") return { kind: "waiting", text: "Waiting for you" };
  if (live) return { kind: "running", text: "Running" };
  const sched = state.schedules.find((s) => s.script === script.id && s.enabled);
  const last = sched?.last ? (runs[sched.last.id] ?? sched.last) : null;
  if (last?.status === "failed") return { kind: "failed", text: `Scheduled run failed` };
  if (script.error) return { kind: "error", text: "Doesn't load" };
  return null;
}

export function Home({
  api,
  state,
  runs,
  layout,
  onLayout,
  selected,
  onOpen,
  onRun,
  onEditWith,
  query,
  view,
  arranging,
}: {
  api: Api;
  state: State;
  runs: Record<string, RunDetail>;
  layout: Layout;
  onLayout: (l: Layout) => void;
  selected: string | null;
  onOpen: (id: string, focus: boolean) => void;
  onRun: (id: string) => void;
  onEditWith: (id: string) => void;
  query: string;
  view: "grid" | "list";
  arranging: boolean;
}) {
  const byId = useMemo(() => new Map(state.scripts.map((s) => [s.id, s])), [state.scripts]);
  const [openFolder, setOpenFolder] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; id: string; folder?: boolean } | null>(null);
  const [peek, setPeek] = useState<{ id: string; rect: DOMRect } | null>(null);
  const peekTimer = useRef<number | undefined>(undefined);
  const drag = useRef<{ id: string; folder: boolean; fav: boolean } | null>(null);
  const [drop, setDrop] = useState<{ ref: string; kind: string } | null>(null);

  useEffect(() => () => clearTimeout(peekTimer.current), []);
  // A folder that no longer exists can't stay open.
  useEffect(() => {
    if (openFolder && !layout.items.some((i) => i.id === openFolder)) setOpenFolder(null);
  }, [layout, openFolder]);

  const badge = (s: Script) => badgeOf(s, state, runs);
  const last = (id: string): RunSummary | null => {
    const r = state.lastRuns[id];
    return r ? (runs[r.id] ?? r) : null;
  };
  const folderName = (id: string) => folderOf(layout, id)?.name;

  // ---- search: every script, flat, folders included ----
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const results = useMemo(() => {
    if (!words.length) return [];
    return state.scripts.filter((s) => {
      const hay = [s.name, s.description ?? "", s.id, folderName(s.id) ?? "", ...Object.entries(s.params).map(([k, p]) => labelOf(k, p))].join(" ").toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  }, [query, state.scripts, layout]);

  // ---- hover preview ----
  const hover = (id: string | null, el?: HTMLElement) => {
    clearTimeout(peekTimer.current);
    if (!id || arranging || drag.current) return setPeek(null);
    peekTimer.current = window.setTimeout(() => setPeek({ id, rect: el!.getBoundingClientRect() }), 450);
  };

  // ---- drag and drop ----
  // Left or right edge of a tile: drop beside it. Its middle: drop into it (makes or fills a folder).
  const zone = (e: React.DragEvent, inFav: boolean) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    if (inFav || drag.current?.folder) return x < 0.5 ? "before" : "after";
    return x < 0.28 ? "before" : x > 0.72 ? "after" : "into";
  };
  const onTileDrop = (ref: string, refIsFolder: boolean, inFav: boolean, kind: string) => {
    const d = drag.current;
    drag.current = null;
    setDrop(null);
    if (!d || d.id === ref) return;
    if (inFav) {
      // Dropped among favourites: make it one, at this spot.
      let l = layout.favourites.includes(d.id) ? layout : toggleFavourite(layout, d.id);
      onLayout(moveFavourite(l, d.id, ref, kind as "before" | "after"));
      return;
    }
    if (d.folder) {
      if (!refIsFolder && folderOf(layout, ref)) return;
      onLayout(moveFolder(layout, d.id, kind as "before" | "after", ref));
      return;
    }
    const { layout: next, created } = moveScript(layout, d.id, { kind: kind as Target["kind"], ref } as Target);
    onLayout(next);
    if (created) {
      setOpenFolder(created);
      setRenaming(created);
    }
  };
  const dropZoneProps = (container: "fav" | "items" | string) => ({
    onDragOver: (e: React.DragEvent) => {
      if (drag.current && (container !== "fav" || !drag.current.folder)) e.preventDefault();
    },
    onDrop: (e: React.DragEvent) => {
      if (e.defaultPrevented) return;
      const d = drag.current;
      drag.current = null;
      setDrop(null);
      if (!d) return;
      e.preventDefault();
      if (container === "fav") {
        if (!d.folder) onLayout(moveFavourite(layout.favourites.includes(d.id) ? layout : toggleFavourite(layout, d.id), d.id, null));
      } else if (!d.folder && !d.fav) onLayout(moveScript(layout, d.id, { kind: "end", container: container === "items" ? "items" : container }).layout);
    },
  });

  // ---- context menu ----
  const scriptMenu = (id: string): MenuEntry[] => {
    const s = byId.get(id)!;
    const fav = layout.favourites.includes(id);
    const home = folderOf(layout, id);
    const folders = layout.items.filter((i): i is Folder => i.type === "folder" && i.id !== home?.id);
    return [
      { label: "Open", onSelect: () => onOpen(id, true) },
      { label: "Run", hint: Object.keys(s.params).length ? "last values" : "", onSelect: () => onRun(id), disabled: !!s.error },
      { label: fav ? "Remove from favourites" : "Add to favourites", onSelect: () => onLayout(toggleFavourite(layout, id)) },
      "separator",
      { heading: "Move to folder" },
      ...folders.map((f) => ({ label: f.name, onSelect: () => onLayout(moveToFolder(layout, id, f.id)) })),
      {
        label: "New folder…",
        onSelect: () => {
          const { layout: next, created } = folderWith(layout, id);
          onLayout(next);
          setOpenFolder(created);
          setRenaming(created);
        },
      },
      ...(home ? [{ label: `Out of ${home.name}`, onSelect: () => onLayout(moveToFolder(layout, id, null)) }] : []),
      "separator",
      ...(state.harnesses.length ? [{ label: "Edit with agent…", onSelect: () => onEditWith(id) }] : []),
      { label: "Open file", onSelect: () => api.open(id).catch(() => {}) },
    ];
  };
  const folderMenu = (fid: string): MenuEntry[] => [
    { label: openFolder === fid ? "Close" : "Open", onSelect: () => setOpenFolder(openFolder === fid ? null : fid) },
    {
      label: "Rename",
      onSelect: () => {
        setOpenFolder(fid);
        setRenaming(fid);
      },
    },
    { label: "Ungroup", onSelect: () => onLayout(ungroup(layout, fid)) },
  ];

  // ---- tiles ----
  const scriptTile = (id: string, where: "fav" | "items" | string, meta?: string) => {
    const s = byId.get(id);
    if (!s) return null;
    const b = badge(s);
    const inFav = where === "fav";
    const d = drop && drop.ref === id && (inFav ? drop.kind !== "into" : true) ? drop.kind : "";
    return (
      <button
        key={`${where}:${id}`}
        className={`tile ${selected === id ? "sel" : ""} ${d ? `drop-${d}` : ""}`}
        data-tile
        data-id={id}
        draggable
        aria-label={[s.name, b?.text, layout.favourites.includes(id) && !inFav ? "favourite" : ""].filter(Boolean).join(", ")}
        aria-description={s.description}
        aria-current={selected === id ? "true" : undefined}
        onClick={(e) => !arranging && onOpen(id, e.detail === 0)}
        onContextMenu={(e) => {
          e.preventDefault();
          hover(null);
          setMenu({ x: e.clientX, y: e.clientY, id });
        }}
        onKeyDown={(e) => {
          if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) {
            e.preventDefault();
            const r = e.currentTarget.getBoundingClientRect();
            setMenu({ x: r.left + 20, y: r.bottom, id });
          } else tileKeys(e);
        }}
        onMouseEnter={(e) => hover(id, e.currentTarget)}
        onMouseLeave={() => hover(null)}
        onDragStart={(e) => {
          hover(null);
          drag.current = { id, folder: false, fav: inFav };
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", s.name);
        }}
        onDragEnd={() => {
          drag.current = null;
          setDrop(null);
        }}
        onDragOver={(e) => {
          const dd = drag.current;
          if (!dd || dd.id === id || (dd.folder && (inFav || folderOf(layout, id)))) return;
          e.preventDefault();
          const k = zone(e, inFav);
          if (drop?.ref !== id || drop.kind !== k) setDrop({ ref: id, kind: k });
        }}
        onDragLeave={() => drop?.ref === id && setDrop(null)}
        onDrop={(e) => {
          e.preventDefault();
          onTileDrop(id, false, inFav, zone(e, inFav));
        }}
      >
        <span className="tile-icon">
          <ScriptIcon script={s} />
          {b && <span className={`badge ${b.kind}`} aria-hidden>{b.kind === "failed" || b.kind === "error" ? "!" : b.kind === "waiting" ? "?" : ""}</span>}
        </span>
        <span className="tile-name">{s.name}</span>
        {meta && <span className="tile-meta">{meta}</span>}
      </button>
    );
  };

  const folderTile = (f: Folder) => {
    const kids = f.scripts.map((id) => byId.get(id)).filter((x): x is Script => !!x);
    const bs = kids.map(badge).filter(Boolean) as Exclude<Badge, null>[];
    const worst = bs.find((b) => b.kind === "failed" || b.kind === "error") ?? bs.find((b) => b.kind === "waiting") ?? bs.find((b) => b.kind === "running");
    const d = drop?.ref === f.id ? drop.kind : "";
    return (
      <button
        key={f.id}
        className={`tile folder ${openFolder === f.id ? "open" : ""} ${d ? `drop-${d}` : ""}`}
        data-tile
        draggable
        aria-expanded={openFolder === f.id}
        aria-label={`${f.name} folder, ${kids.length} script${kids.length === 1 ? "" : "s"}${worst ? `, ${worst.text.toLowerCase()}` : ""}`}
        onClick={() => setOpenFolder(openFolder === f.id ? null : f.id)}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY, id: f.id, folder: true });
        }}
        onKeyDown={(e) => {
          if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) {
            e.preventDefault();
            const r = e.currentTarget.getBoundingClientRect();
            setMenu({ x: r.left + 20, y: r.bottom, id: f.id, folder: true });
          } else tileKeys(e);
        }}
        onDragStart={(e) => {
          drag.current = { id: f.id, folder: true, fav: false };
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", f.name);
        }}
        onDragEnd={() => {
          drag.current = null;
          setDrop(null);
        }}
        onDragOver={(e) => {
          if (!drag.current || drag.current.id === f.id) return;
          e.preventDefault();
          const k = zone(e, false);
          if (drop?.ref !== f.id || drop.kind !== k) setDrop({ ref: f.id, kind: k });
        }}
        onDragLeave={() => drop?.ref === f.id && setDrop(null)}
        onDrop={(e) => {
          e.preventDefault();
          onTileDrop(f.id, true, false, zone(e, false));
        }}
      >
        <span className="tile-icon">
          <FolderIcon scripts={kids} />
          {worst && <span className={`badge ${worst.kind}`} aria-hidden>{worst.kind === "waiting" ? "?" : worst.kind === "running" ? "" : "!"}</span>}
        </span>
        <span className="tile-name">{f.name}</span>
      </button>
    );
  };

  // Arrow keys move between tiles; Up and Down move a row.
  // Columns come from the catalog's own width, which stays put while folders open and close.
  const root = useRef<HTMLDivElement>(null);
  const [cols, setCols] = useState(6);
  useLayoutEffect(() => {
    const el = root.current!;
    const fit = () => {
      const cs = getComputedStyle(el);
      const w = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      setCols(Math.max(1, Math.floor((w + GAP) / (TILE + GAP))));
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const tileKeys = (e: React.KeyboardEvent) => {
    const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: cols, ArrowUp: -cols }[e.key];
    if (!step) return;
    const scope = (e.currentTarget as HTMLElement).closest("[data-tiles]");
    const all = [...(scope ?? document).querySelectorAll<HTMLElement>("[data-tile]")];
    const i = all.indexOf(e.currentTarget as HTMLElement);
    const next = all[i + step];
    if (next) {
      e.preventDefault();
      next.focus();
    } else if (e.key === "ArrowUp" && !(scope?.previousElementSibling)) {
      e.preventDefault();
      document.querySelector<HTMLElement>(".search input")?.focus();
    }
  };

  // ---- the open folder's drawer, placed after the row that holds the folder ----
  const drawer = (f: Folder) => (
    <div className="drawer" key={`drawer:${f.id}`} style={{ ["--x" as any]: `${(layout.items.findIndex((i) => i.id === f.id) % cols) * (TILE + GAP) + TILE / 2 - 7}px` }} {...dropZoneProps(f.id)}>
      <div className="drawer-head">
        {renaming === f.id ? (
          <input
            className="rename"
            autoFocus
            defaultValue={f.name}
            aria-label="Folder name"
            onFocus={(e) => e.currentTarget.select()}
            onBlur={(e) => {
              onLayout(renameFolder(layout, f.id, e.currentTarget.value));
              setRenaming(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
              if (e.key === "Escape") {
                e.stopPropagation();
                setRenaming(null);
              }
            }}
          />
        ) : (
          <h3>{f.name}</h3>
        )}
        <span className="muted small">{f.scripts.length}</span>
        <span className="grow" />
        {renaming !== f.id && (
          <button className="link small" onClick={() => setRenaming(f.id)}>
            Rename
          </button>
        )}
      </div>
      <div className="tiles" data-tiles>
        {f.scripts.map((id) => scriptTile(id, f.id))}
      </div>
    </div>
  );

  // Tiles flow in a grid; an open folder splits it after its row so its drawer spans the window.
  const itemsGrid = (items: LayoutItem[]) => {
    const openAt = items.findIndex((i) => i.id === openFolder);
    const tile = (it: LayoutItem) => (it.type === "folder" ? folderTile(it) : scriptTile(it.id, "items"));
    if (openAt < 0)
      return (
        <div className="tiles" data-tiles>
          {items.map(tile)}
        </div>
      );
    const cut = Math.min(items.length, Math.floor(openAt / cols) * cols + cols);
    return (
      <>
        <div className="tiles" data-tiles>
          {items.slice(0, cut).map(tile)}
        </div>
        {drawer(items[openAt] as Folder)}
        {cut < items.length && (
          <div className="tiles" data-tiles>
            {items.slice(cut).map(tile)}
          </div>
        )}
      </>
    );
  };

  // ---- views ----
  const noScripts = state.scripts.length === 0;
  const favs = layout.favourites.filter((id) => byId.has(id));
  // In the details view a favourite is listed once, under Favourites.
  const loose = layout.items.filter((i) => i.type === "script" && !favs.includes(i.id)).map((i) => i.id);
  const preview = peek && byId.get(peek.id);

  return (
    <div ref={root} className={`home ${arranging ? "arranging" : ""}`}>
      {noScripts ? (
        <div className="empty">
          <p>No scripts yet.</p>
          <p className="muted small">Use + to write one, or ask your agent: it can add scripts through the MCP server.</p>
        </div>
      ) : words.length ? (
        <section aria-label="Search results">
          <h2 className="sec">
            {results.length} result{results.length === 1 ? "" : "s"}
          </h2>
          {results.length === 0 ? (
            <p className="muted small">Nothing matches “{query}”.</p>
          ) : view === "list" ? (
            <ScriptList ids={results.map((s) => s.id)} {...{ byId, layout, onLayout, selected, onOpen, last, badge, folderName }} />
          ) : (
            <div className="tiles" data-tiles>
              {results.map((s) => scriptTile(s.id, "results", folderName(s.id) ? `in ${folderName(s.id)}` : undefined))}
            </div>
          )}
        </section>
      ) : view === "list" ? (
        <>
          {favs.length > 0 && (
            <section>
              <h2 className="sec">
                <Star size={13} fill="currentColor" className="fav" /> Favourites
              </h2>
              <ScriptList ids={favs} {...{ byId, layout, onLayout, selected, onOpen, last, badge, folderName }} />
            </section>
          )}
          {layout.items
            .filter((i): i is Folder => i.type === "folder")
            .map((f) => ({ f, ids: f.scripts.filter((id) => !favs.includes(id)) }))
            .filter((x) => x.ids.length)
            .map(({ f, ids }) => (
              <section key={f.id}>
                <h2 className="sec">{f.name}</h2>
                <ScriptList ids={ids} {...{ byId, layout, onLayout, selected, onOpen, last, badge, folderName }} />
              </section>
            ))}
          {loose.length > 0 && (
            <section>
              <h2 className="sec">{favs.length || layout.items.some((i) => i.type === "folder") ? "Other scripts" : "Scripts"}</h2>
              <ScriptList ids={loose} {...{ byId, layout, onLayout, selected, onOpen, last, badge, folderName }} />
            </section>
          )}
        </>
      ) : (
        <>
          {(favs.length > 0 || arranging) && (
            <section {...dropZoneProps("fav")}>
              <h2 className="sec">
                <Star size={13} fill="currentColor" className="fav" /> Favourites
              </h2>
              {favs.length ? (
                <div className="tiles" data-tiles>
                  {favs.map((id) => scriptTile(id, "fav"))}
                </div>
              ) : (
                <p className="drop-hint muted small">Drag a script here to make it a favourite.</p>
              )}
            </section>
          )}
          <section {...dropZoneProps("items")}>
            {(favs.length > 0 || arranging) && <h2 className="sec">All scripts</h2>}
            {itemsGrid(layout.items)}
          </section>
        </>
      )}

      {preview && !menu && (
        <Peek
          script={preview}
          rect={peek!.rect}
          last={last(preview.id)}
          every={state.schedules.find((s) => s.script === preview.id && s.enabled)?.every}
          folder={folderName(preview.id)}
        />
      )}
      {menu && (
        <Menu
          x={menu.x}
          y={menu.y}
          label={menu.folder ? "Folder" : "Script"}
          items={menu.folder ? folderMenu(menu.id) : scriptMenu(menu.id)}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}

/** The hover preview: what the script does, what it takes, how it last went. */
function Peek({ script, rect, last, every, folder }: { script: Script; rect: DOMRect; last: RunSummary | null; every?: string; folder?: string }) {
  const params = Object.entries(script.params);
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: rect.left, top: rect.bottom + 6 });
  useLayoutEffect(() => {
    const r = box.current!.getBoundingClientRect();
    let top = rect.bottom + 6;
    if (top + r.height > innerHeight - 8) top = rect.top - r.height - 6;
    setPos({ left: Math.max(8, Math.min(rect.left + rect.width / 2 - r.width / 2, innerWidth - r.width - 8)), top: Math.max(8, top) });
  }, [rect]);
  return (
    <div ref={box} className="peek" role="tooltip" style={pos}>
      <div className="peek-name">{script.name}</div>
      {script.description && <div className="muted small">{script.description}</div>}
      <div className="chips">
        {params.length ? params.map(([k, p]) => <span key={k} className="chip">{labelOf(k, p)}</span>) : <span className="muted small">No inputs</span>}
      </div>
      <div className="peek-foot small">
        {last ? <span className={last.status === "failed" ? "bad-text" : last.status === "waiting" ? "warn-text" : ""}>{lastLabel(last)}</span> : <span className="muted">Never run</span>}
        {every && <span className="muted"> · every {every}</span>}
        {folder && <span className="muted"> · in {folder}</span>}
      </div>
    </div>
  );
}

/** The detailed view: each script with its description, inputs and last result. */
function ScriptList({
  ids,
  byId,
  layout,
  onLayout,
  selected,
  onOpen,
  last,
  badge,
}: {
  ids: string[];
  byId: Map<string, Script>;
  layout: Layout;
  onLayout: (l: Layout) => void;
  selected: string | null;
  onOpen: (id: string, focus: boolean) => void;
  last: (id: string) => RunSummary | null;
  badge: (s: Script) => Badge;
  folderName: (id: string) => string | undefined;
}) {
  return (
    <ul className="rows">
      {ids.map((id) => {
        const s = byId.get(id);
        if (!s) return null;
        const b = badge(s);
        const l = last(id);
        const fav = layout.favourites.includes(id);
        const params = Object.entries(s.params);
        return (
          <li key={id} className={`row-item ${selected === id ? "sel" : ""}`}>
            <button className="row-main" onClick={(e) => onOpen(id, e.detail === 0)} aria-current={selected === id ? "true" : undefined}>
              <span className="tile-icon">
                <ScriptIcon script={s} size={34} />
                {b && <span className={`badge ${b.kind}`} aria-hidden>{b.kind === "waiting" ? "?" : b.kind === "running" ? "" : "!"}</span>}
              </span>
              <span className="row-text">
                <span className="row-name">{s.name}</span>
                {s.description && <span className="row-desc">{s.description}</span>}
              </span>
              <span className="chips">
                {params.length ? params.map(([k, p]) => <span key={k} className="chip">{labelOf(k, p)}</span>) : <span className="muted small">No inputs</span>}
              </span>
              <span className="row-state small">
                {b?.kind === "waiting" ? (
                  <span className="warn-text">Waiting for you</span>
                ) : l ? (
                  <span className={l.status === "failed" ? "bad-text" : ""}>{lastLabel(l)}</span>
                ) : (
                  <span className="muted">Never run</span>
                )}
              </span>
            </button>
            <button
              className={`ib ${fav ? "fav" : ""}`}
              aria-pressed={fav}
              title={fav ? "Remove from favourites" : "Add to favourites"}
              onClick={() => onLayout(toggleFavourite(layout, id))}
            >
              <Star size={15} fill={fav ? "currentColor" : "none"} />
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** Needs-you list for the top bar: questions waiting, schedules failing, scripts running. */
export function attentionOf(state: State, runs: Record<string, RunDetail>) {
  const name = (id: string) => state.scripts.find((s) => s.id === id)?.name ?? id;
  const live = Object.values(runs).filter(isLive);
  const waiting = live.filter((r) => r.status === "waiting").map((r) => ({ id: r.script, run: r.id, name: name(r.script), text: r.pendingAsk?.request.message ?? "Waiting for you", kind: "waiting" as const }));
  const failing = state.schedules
    .filter((s) => s.enabled && state.scripts.some((x) => x.id === s.script))
    .map((s) => ({ s, last: s.last ? (runs[s.last.id] ?? s.last) : null }))
    .filter((x) => x.last?.status === "failed")
    .map((x) => ({ id: x.s.script, run: x.last!.id, name: name(x.s.script), text: `Scheduled run failed · ${lastLabel(x.last!).replace(/^Failed /, "")}`, kind: "failed" as const }));
  const running = live.filter((r) => r.status === "running").map((r) => ({ id: r.script, run: r.id, name: name(r.script), text: "Running", kind: "running" as const }));
  return { needs: [...waiting, ...failing], running };
}

