import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronLeft, Clock, Ellipsis, FolderOpen, FolderPlus, Pencil, Star } from "lucide-react";
import type { Api, Layout, LayoutItem, ParamSpec, RunDetail, RunSummary, Script, State } from "./api";
import { Glyph, hueOf } from "./icons";
import { preferredHarness } from "./Dialogs";
import { Menu, type MenuEntry } from "./Menu";
import { NewFolderDialog } from "./Dialogs";
import { defaults, fmtValue, labelOf, splitUnit, startValues } from "./Form";
import { fmtAgo, fmtEvery, fmtEveryShort, lastLabel, isLive } from "./fmt";
import { folderOf, folderWith, foldersOf, moveFavourite, moveFolder, moveScript, moveToFolder, renameFolder, toggleFavourite, toggleInFolder, ungroup, type Target } from "./layoutOps";

type Folder = Extract<LayoutItem, { type: "folder" }>;
type Badge = { kind: "failed" | "waiting" | "running" | "error"; text: string } | null;


/** What a tile's corner says, most urgent first. */
export function badgeOf(script: Script, state: State, runs: Record<string, RunDetail>): Badge {
  const live = Object.values(runs).find((r) => r.script === script.id && isLive(r));
  if (live?.status === "waiting") return { kind: "waiting", text: "Needs your answer" };
  if (live) return { kind: "running", text: live.source === "agent" ? `${live.params.agent ?? "AI"} is writing it` : "Running now" };
  const sched = state.schedules.find((s) => s.script === script.id && s.enabled);
  const last = sched?.last ? (runs[sched.last.id] ?? sched.last) : null;
  if (last?.status === "failed") return { kind: "failed", text: `Failed ${fmtAgo(last.endedAt ?? last.startedAt)}` };
  if (script.error) return { kind: "error", text: "Can't be opened" };
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
  onEdit,
  onDelete,
  query,
  onClearSearch,
}: {
  api: Api;
  state: State;
  runs: Record<string, RunDetail>;
  layout: Layout;
  onLayout: (l: Layout) => void;
  selected: string | null;
  onOpen: (id: string, focus: boolean) => void;
  onRun: (id: string) => void;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
  query: string;
  onClearSearch: () => void;
}) {
  const byId = useMemo(() => new Map(state.scripts.map((s) => [s.id, s])), [state.scripts]);
  const [openFolder, setOpenFolder] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; id: string; folder?: boolean } | null>(null);
  const drag = useRef<{ id: string; folder: boolean; fav: boolean; from?: string } | null>(null);
  const [drop, setDrop] = useState<{ ref: string; kind: string } | null>(null);

  // A folder that no longer exists can't stay open.
  useEffect(() => {
    if (openFolder && !layout.items.some((i) => i.id === openFolder)) setOpenFolder(null);
  }, [layout, openFolder]);

  const badge = (s: Script) => badgeOf(s, state, runs);
  const last = (id: string): RunSummary | null => {
    const r = state.lastRuns[id];
    return r ? (runs[r.id] ?? r) : null;
  };
  const folderName = (id: string) => foldersOf(layout, id).map((f) => f.name).join(", ") || undefined;

  // ---- search: every script, flat, folders included ----
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const results = useMemo(() => {
    if (!words.length) return [];
    return state.scripts.filter((s) => {
      const hay = [s.name, s.description ?? "", s.id, folderName(s.id) ?? "", ...Object.entries(s.params).map(([k, p]) => labelOf(k, p))].join(" ").toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  }, [query, state.scripts, layout]);

  // ---- drag and drop ----
  // Left or right edge of a tile: drop beside it. Its middle: drop into it (makes or fills a folder).
  const zone = (e: React.DragEvent, inFav: boolean) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    if (inFav || drag.current?.folder) return x < 0.5 ? "before" : "after";
    return x < 0.28 ? "before" : x > 0.72 ? "after" : "into";
  };
  const onTileDrop = (ref: string, refIsFolder: boolean, inFav: boolean, kind: string, refIn?: string) => {
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
    const { layout: next, created } = moveScript(layout, d.id, { kind, ref, in: refIn === "results" ? undefined : refIn } as Target, d.from);
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
      } else if (!d.folder && !d.fav) onLayout(moveScript(layout, d.id, { kind: "end", container: container === "items" ? "items" : container }, d.from).layout);
    },
  });

  // ---- context menu ----
  const scriptMenu = (id: string): MenuEntry[] => {
    const s = byId.get(id)!;
    const fav = layout.favourites.includes(id);
    const folders = layout.items.filter((i): i is Folder => i.type === "folder");
    return [
      { label: "Open", onSelect: () => onOpen(id, true) },
      { label: state.lastRuns[id] ? "Run again" : "Run", hint: Object.keys(s.params).length ? "same values" : "", onSelect: () => onRun(id), disabled: !!s.error },
      { label: fav ? "Remove from favourites" : "Add to favourites", onSelect: () => onLayout(toggleFavourite(layout, id)) },
      { label: "Edit…", onSelect: () => onEdit(id) },
      "separator",
      { heading: "In folders" },
      ...folders.map((f) => ({ label: f.name, checked: f.scripts.includes(id), onSelect: () => onLayout(toggleInFolder(layout, id, f.id)) })),
      {
        label: "New folder…",
        onSelect: () => {
          const { layout: next, created } = folderWith(layout, id);
          onLayout(next);
          setOpenFolder(created);
          setRenaming(created);
        },
      },
      "separator",
      { label: "Show in folder", onSelect: () => api.reveal(id).catch(() => {}) },
      { heading: "For developers" },
      { label: "Open file", onSelect: () => api.open(id).catch(() => {}) },
      "separator",
      { label: "Delete…", onSelect: () => onDelete(id) },
    ];
  };
  const folderMenu = (fid: string): MenuEntry[] => [
    { label: openFolder === fid ? "Close" : "Open", onSelect: () => toggleFolder(openFolder === fid ? null : fid, fid) },
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
    const fav = layout.favourites.includes(id);
    const sched = state.schedules.find((x) => x.script === id && x.enabled);
    return (
      // The card is a container: one big button opens the script, and a star and a menu
      // button sit in its bottom corner (shown on hover or focus, and on touch screens).
      <div
        key={`${where}:${id}`}
        className={`card ${selected === id ? "sel" : ""} ${b?.kind === "running" ? "is-running" : ""} ${d ? `drop-${d}` : ""}`}
        style={{ viewTransitionName: where === "results" ? undefined : `c-${id.replace(/[^a-zA-Z0-9_-]/g, "_")}` }}
        draggable
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY, id });
        }}
        onDragStart={(e) => {
          drag.current = { id, folder: false, fav: inFav, from: where === "results" ? undefined : where };
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
          onTileDrop(id, false, inFav, zone(e, inFav), where);
        }}
      >
        <button
          className="card-main"
          data-tile
          data-id={id}
          data-where={where}
          aria-label={[s.name, b?.text, fav && !inFav ? "favourite" : "", sched ? `runs every ${fmtEvery(sched.every)}` : ""].filter(Boolean).join(", ")}
          aria-description={s.description}
          aria-current={selected === id ? "true" : undefined}
          onClick={(e) => onOpen(id, e.detail === 0)}
          onKeyDown={(e) => {
            if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) {
              e.preventDefault();
              const r = e.currentTarget.getBoundingClientRect();
              setMenu({ x: r.left + 20, y: r.bottom, id });
            } else if (e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
              e.preventDefault();
              nudge(id, where, e.key === "ArrowLeft" ? -1 : 1);
            } else tileKeys(e);
          }}
        >
          <span className="card-top">
            <span className={`tile-icon hue-${hueOf(s.id)}`}>
              <Glyph script={s} size={19} />
            </span>
          </span>
          <span className="card-name">
            {s.name}
          </span>
          <span className="card-sub">{[meta, s.description ?? asksFor(s)].filter(Boolean).join(" · ")}</span>
          <CardFoot
            script={s}
            // The values it will really run with: the schedule's, or the form's (last run or last typed).
            values={sched ? { ...defaults(s.params), ...sched.params } : startValues(s, state.lastRuns[id]).values}
            last={last(id)}
            every={sched?.every}
            badge={b}
          />
        </button>
        {b?.kind === "running" && <span className="run-bar" aria-hidden />}
        <span className="card-actions">
          <button
            className={`ib star-btn ${fav ? "on-fav" : ""}`}
            aria-pressed={fav}
            title={fav ? "Remove from favourites" : "Add to favourites"}
            aria-label={`${fav ? "Remove" : "Add"} ${s.name} ${fav ? "from" : "to"} favourites`}
            onClick={() => onLayout(toggleFavourite(layout, id))}
          >
            <Star size={15} fill={fav ? "currentColor" : "none"} aria-hidden />
          </button>
          <button
            className="ib"
            title="More"
            aria-label={`More for ${s.name}`}
            aria-haspopup="menu"
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              setMenu({ x: r.right - 200, y: r.bottom + 4, id });
            }}
          >
            <Ellipsis size={16} aria-hidden />
          </button>
        </span>
      </div>
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
        className={`card folder ${openFolder === f.id ? "open" : ""} ${d ? `drop-${d}` : ""}`}
        data-tile
        data-id={f.id}
        draggable
        aria-expanded={openFolder === f.id}
        aria-label={`${f.name} folder, ${kids.length} script${kids.length === 1 ? "" : "s"}${worst ? `, ${worst.text.toLowerCase()}` : ""}`}
        onClick={() => toggleFolder(openFolder === f.id ? null : f.id, f.id)}
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
        <span className="tile-icon folder-icon">
          <FolderOpen size={19} aria-hidden />
        </span>
        <span className="folder-text">
          <span className="card-name">{f.name}</span>
          <span className="card-sub">
            {kids.length} script{kids.length === 1 ? "" : "s"}
            {worst && (
              <span className={`folder-note ${worst.kind}`}>
                {" · "}
                {worst.kind === "waiting" ? "1 needs you" : worst.kind === "running" ? "1 running" : "1 failed"}
              </span>
            )}
          </span>
        </span>
      </button>
    );
  };

  /** Put focus back on a tile after a re-render (the same copy, when a favourite shows twice). */
  const refocus = (id: string, where?: string) =>
    requestAnimationFrame(() =>
      document.querySelector<HTMLElement>(`.home [data-tile][data-id="${CSS.escape(id)}"]${where ? `[data-where="${CSS.escape(where)}"]` : ""}`)?.focus(),
    );
  // Opening a folder moves focus to its back link; closing returns it to the folder's card.
  const toggleFolder = (id: string | null, focusId?: string) => {
    setOpenFolder(id);
    if (id) requestAnimationFrame(() => document.querySelector<HTMLElement>(".home .back-link")?.focus());
    else if (focusId) refocus(focusId);
  };

  // Alt+Left/Right moves a script one place within its row of tiles (favourites, a folder, or the top level).
  const nudge = (id: string, where: string, d: -1 | 1) => {
    let next: Layout = layout;
    if (where === "fav") {
      const i = layout.favourites.indexOf(id);
      const ref = layout.favourites[i + d];
      if (!ref) return;
      next = moveFavourite(layout, id, ref, d < 0 ? "before" : "after");
    } else {
      const f = layout.items.find((i) => i.type === "folder" && i.id === where) as Folder | undefined;
      const list = f ? f.scripts : layout.items.map((i) => i.id);
      const ref = list[list.indexOf(id) + d];
      if (!ref) return;
      next = moveScript(layout, id, { kind: d < 0 ? "before" : "after", ref, in: f ? f.id : "items" } as Target, f ? f.id : "items").layout;
    }
    onLayout(next);
    refocus(id, where);
  };

  // Arrow keys move to the nearest tile in that direction, across sections.
  const root = useRef<HTMLDivElement>(null);
  const tileKeys = (e: React.KeyboardEvent) => {
    const dir = { ArrowRight: [1, 0], ArrowLeft: [-1, 0], ArrowDown: [0, 1], ArrowUp: [0, -1] }[e.key];
    if (!dir) return;
    const from = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const cx = from.left + from.width / 2, cy = from.top + from.height / 2;
    let best: HTMLElement | null = null;
    let bestScore = Infinity;
    for (const t of document.querySelectorAll<HTMLElement>(".home [data-tile]")) {
      if (t === e.currentTarget) continue;
      const r = t.getBoundingClientRect();
      const dx = r.left + r.width / 2 - cx, dy = r.top + r.height / 2 - cy;
      const along = dx * dir[0]! + dy * dir[1]!;
      if (along <= 4) continue;
      const across = Math.abs(dir[0] ? dy : dx);
      // Stay in the row (or column) when there is something there; otherwise the nearest.
      const score = along + across * 3;
      if (score < bestScore) (bestScore = score), (best = t);
    }
    e.preventDefault();
    if (best) best.focus();
    else if (e.key === "ArrowUp") document.querySelector<HTMLElement>(".search input")?.focus();
  };

  const renameBox = (f: Folder) => (
    <input
      className="rename"
      autoFocus
      defaultValue={f.name === "New folder" ? "" : f.name}
      placeholder="Folder name"
      aria-label="Folder name"
      onFocus={(e) => e.currentTarget.select()}
      onBlur={(e) => {
        onLayout(renameFolder(layout, f.id, e.currentTarget.value || f.name));
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
  );

  // A dashed spot at the end of the grid: drop a script on it to start a folder.
  const [newDrop, setNewDrop] = useState(false);
  const [folderDialog, setFolderDialog] = useState(false);
  const newFolderSpot = (
    <button
      className={`new-folder ghost ${newDrop ? "over" : ""}`}
      title="Click, or drop a script here"
      onClick={() => setFolderDialog(true)}
      onDragOver={(e) => {
        if (!drag.current || drag.current.folder) return;
        e.preventDefault();
        e.stopPropagation();
        setNewDrop(true);
      }}
      onDragLeave={() => setNewDrop(false)}
      onDrop={(e) => {
        const d = drag.current;
        drag.current = null;
        setNewDrop(false);
        setDrop(null);
        if (!d || d.folder) return;
        e.preventDefault();
        e.stopPropagation();
        const { layout: next, created } = folderWith(layout, d.id);
        onLayout(next);
        setOpenFolder(created);
        setRenaming(created);
      }}
    >
      <FolderPlus size={16} aria-hidden />
      New folder
    </button>
  );

  // ---- views ----
  // ---- views ----
  const noScripts = state.scripts.length === 0;
  const favs = layout.favourites.filter((id) => byId.has(id));
  // Favourites are shortcuts: the script also stays in its usual place.
  // A favourite moves up to Favourites instead of showing twice (inside a folder it stays too).
  const shown = layout.items.filter((i) => i.type === "folder" || !layout.favourites.includes(i.id));
  const openF = layout.items.find((i): i is Folder => i.type === "folder" && i.id === openFolder) ?? null;

  return (
    <div
      ref={root}
      className="home"
      onKeyDown={(e) => {
        // Escape closes an open folder before anything else.
        if (e.key === "Escape" && openFolder && !renaming) {
          e.stopPropagation();
          toggleFolder(null, openFolder);
        }
      }}
    >
      {noScripts ? (
        <div className="empty">
          <p>No scripts yet.</p>
          <p className="muted small">Press New script and describe what you want; your coding agent writes it.</p>
        </div>
      ) : words.length ? (
        <section aria-label="Search results">
          <h2 className="sec">
            {results.length} result{results.length === 1 ? "" : "s"}
          </h2>
          {results.length === 0 ? (
            <div className="no-results">
              <p>Nothing matches “{query}”.</p>
              <button onClick={onClearSearch}>Clear search</button>
            </div>
          ) : (
            <div className="tiles" data-tiles>
              {results.map((s) => scriptTile(s.id, "results", folderName(s.id) ? `in ${folderName(s.id)}` : undefined))}
            </div>
          )}
        </section>
      ) : (
        <>
          {openF ? (
            <section {...dropZoneProps(openF.id)} aria-label={openF.name}>
              <div className="folder-head">
                <button
                  className="ib back-link"
                  onClick={() => toggleFolder(null, openF.id)}
                  onDragOver={(e) => drag.current && !drag.current.folder && e.preventDefault()}
                  onDrop={(e) => {
                    const d = drag.current;
                    drag.current = null;
                    if (!d || d.folder) return;
                    e.preventDefault();
                    e.stopPropagation();
                    // Out of this folder (it stays in any others).
                    onLayout(layout.items.some((i) => i.id === openF.id && i.type === "folder" && i.scripts.includes(d.id)) ? toggleInFolder(layout, d.id, openF.id) : layout);
                  }}
                >
                  <ChevronLeft size={18} aria-hidden />
                  All scripts
                </button>
              </div>
              <div className="folder-title">
                {renaming === openF.id ? renameBox(openF) : <h2 className="sec">{openF.name}</h2>}
                {renaming !== openF.id && (
                  <button className="ib" title="Rename folder" aria-label="Rename folder" onClick={() => setRenaming(openF.id)}>
                    <Pencil size={16} aria-hidden />
                  </button>
                )}
              </div>
              <div className="tiles" data-tiles>
                {openF.scripts.map((id) => scriptTile(id, openF.id))}
              </div>
            </section>
          ) : (
          <>
          <section {...dropZoneProps("fav")}>
            <h2 className="sec">
              <Star size={13} fill="currentColor" className="fav" /> Favourites
            </h2>
            {favs.length ? (
              <div className="tiles" data-tiles>
                {favs.map((id) => scriptTile(id, "fav"))}
              </div>
            ) : (
              <p className="drop-hint muted small">Star a script to keep it here.</p>
            )}
          </section>
          <section {...dropZoneProps("items")}>
            <h2 className="sec">{favs.length ? "Other scripts" : "Scripts"}</h2>
            {/* Folders first, as a row of chips ending in "New folder", then loose scripts. */}
            {(shown.some((it) => it.type === "folder") || state.scripts.length > 1) && (
              <div className="folders" data-tiles>
                {shown.map((it) => (it.type === "folder" ? folderTile(it) : null))}
                {state.scripts.length > 1 && newFolderSpot}
              </div>
            )}
            <div className="tiles" data-tiles>
              {shown.map((it) => (it.type === "folder" ? null : scriptTile(it.id, "items")))}
            </div>
          </section>
          </>
          )}
        </>
      )}

      {folderDialog && (
        <NewFolderDialog
          scripts={layout.items.filter((i) => i.type === "script").map((i) => byId.get(i.id)!).filter(Boolean)}
          onClose={() => setFolderDialog(false)}
          onCreate={(name, ids) => {
            let { layout: next, created } = folderWith(layout, ids[0]!, name);
            for (const id of ids.slice(1)) next = moveToFolder(next, id, created);
            onLayout(next);
            setFolderDialog(false);
            toggleFolder(created);
          }}
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

/** One input as a chip: its label and the value it will run with ("Times 2", "Folder ext2"), or "not set". */
/** A value in a few characters: a web address reads as the file or site it points at ("missing.zip"). */
function shortValue(spec: ParamSpec, value: unknown) {
  if (value === undefined || value === "" || value === null) return "";
  if (spec.kind === "boolean") return value ? "on" : "off";
  if (typeof value === "string" && /^https?:\/\//.test(value)) {
    try {
      const u = new URL(value);
      return u.pathname.split("/").filter(Boolean).at(-1) ?? u.host;
    } catch {}
  }
  return fmtValue(spec, value);
}

function InputChip({ name, spec, value }: { name: string; spec: ParamSpec; value: unknown }) {
  const empty = value === undefined || value === "" || value === null;
  const url = typeof value === "string" && /^https?:\/\//.test(value);
  // "Older than (days)" with 30 reads "Older than 30 days".
  const { name: key, unit } = splitUnit(labelOf(name, spec));
  const full = shortValue(spec, value) + (unit && !empty ? ` ${unit}` : "");
  const shown = full.length > 14 ? `${full.slice(0, 13)}…` : full;
  return (
    <span className={`chip ${empty ? "unset" : ""}`} title={[url ? String(value) : full, spec.description].filter(Boolean).join(". ")}>
      <span className="chip-key">{key}</span>
      <span className="chip-val">{empty ? (spec.optional ? "optional" : "not set") : shown}</span>
    </span>
  );
}

/** "Asks for Folder and Pattern", for a script with no description. */
function asksFor(s: Script) {
  const names = Object.entries(s.params).map(([k, p]) => labelOf(k, p));
  if (!names.length) return "No inputs needed";
  return `Asks for ${names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`}`;
}

/** The bottom of a card: two inputs (then "+2 more"), then one line every card has: how it is doing, and its schedule. */
function CardFoot({ script, values, last, every, badge }: { script: Script; values: Record<string, unknown>; last: RunSummary | null; every?: string; badge: Badge }) {
  const all = Object.entries(script.params);
  const empty = (k: string) => values[k] === "" || values[k] === undefined || values[k] === null;
  // Inputs that still need a value are said once, in the status line ("Needs setup: File").
  const unset = all.filter(([k, p]) => empty(k) && !p.optional && p.kind !== "boolean");
  const params = all.filter(([k]) => !empty(k));
  const rest = params.slice(2);
  const done = last && !isLive(last) ? last : null;
  // Status is a dot and a few words, the same on every card; the strip at the top is the loud one.
  const status = badge
    ? { kind: badge.kind === "error" ? "failed" : badge.kind, text: badge.kind === "waiting" ? "Waiting for your answer" : badge.text }
    : unset.length
      ? { kind: "waiting", text: `Needs setup: ${unset.map(([k, p]) => splitUnit(labelOf(k, p)).name).join(", ")}` }
      : done
        ? { kind: done.status === "ok" ? "ok" : "idle", text: lastLabel(done) }
        : { kind: "idle", text: "Not run yet" };
  return (
    <>
      {params.length > 0 && (
        <span className="card-foot">
          {/* Two chips on a roomy card, one on a narrow one (the card's own width decides). */}
          {params.slice(0, 2).map(([k, p], i) => (
            <span key={k} className={i === 1 ? "second" : ""}>
              <InputChip name={k} spec={p} value={values[k]} />
            </span>
          ))}
          {rest.length > 0 && (
            <span className="chip more wide-only" title={rest.map(([k, p]) => labelOf(k, p)).join(", ")}>
              +{rest.length} more
            </span>
          )}
          {params.length > 1 && (
            <span className="chip more narrow-only" title={params.slice(1).map(([k, p]) => labelOf(k, p)).join(", ")}>
              +{params.length - 1} more
            </span>
          )}
        </span>
      )}
      {/* At phone width the chips give way to one line of values. */}
      {params.length > 0 && (
        <span className="card-vals">
          {params
            .slice(0, 2)
            .map(([k, p]) => {
              const { name: key, unit } = splitUnit(labelOf(k, p));
              const v = shortValue(p, values[k]);
              return `${key} ${unit ? `${v} ${unit}` : v}`;
            })
            .join(" · ")}
        </span>
      )}
      <span className={`card-last status-${status.kind} ${done && Date.now() - (done.endedAt ?? 0) < 8000 ? "fresh" : ""}`} key={done?.id}>
        <span className={`dot ${status.kind}`} aria-hidden />
        <span className="card-status" title={done ? new Date(done.startedAt).toLocaleString() : undefined}>
          {status.text}
        </span>
        {every && (
          <span className="every-tag" title={`Runs every ${fmtEvery(every)}`}>
            <Clock size={12} aria-hidden />
            <span className="every-text">{fmtEveryShort(every)}</span>
          </span>
        )}
      </span>
    </>
  );
}

/** Needs-you list for the top bar: questions waiting, schedules failing, scripts running. */
export function attentionOf(state: State, runs: Record<string, RunDetail>) {
  const name = (id: string) => state.scripts.find((s) => s.id === id)?.name ?? id;
  const live = Object.values(runs).filter(isLive);
  // One entry per script: its newest waiting run.
  const waitingRuns = live.filter((r) => r.status === "waiting").sort((a, b) => b.startedAt - a.startedAt).filter((r, i, all) => all.findIndex((x) => x.script === r.script) === i);
  const waiting = waitingRuns.map((r) => ({ id: r.script, run: r.id, name: name(r.script), text: r.pendingAsk?.request.message ?? "Waiting for you", when: "", every: undefined as string | undefined, kind: "waiting" as const }));
  const failing = state.schedules
    .filter((s) => s.enabled && state.scripts.some((x) => x.id === s.script))
    .map((s) => ({ s, last: s.last ? (runs[s.last.id] ?? s.last) : null }))
    .filter((x) => x.last?.status === "failed")
    .map((x) => ({ id: x.s.script, run: x.last!.id, name: name(x.s.script), text: "", when: fmtAgo(x.last!.endedAt ?? x.last!.startedAt), every: x.s.every, kind: "failed" as const }));
  const running = live.filter((r) => r.status === "running").map((r) => ({ id: r.script, run: r.id, name: name(r.script), text: "Running", kind: "running" as const }));
  return { needs: [...waiting, ...failing], running };
}

