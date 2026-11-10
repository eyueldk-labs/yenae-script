import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Star } from "lucide-react";
import type { Api, Layout, LayoutItem, ParamSpec, RunDetail, RunSummary, Script, State } from "./api";
import { Glyph, hueOf } from "./icons";
import { Menu, type MenuEntry } from "./Menu";
import { fmtValue, labelOf } from "./Form";
import { fmtAgo, lastLabel, isLive } from "./fmt";
import { folderOf, folderWith, moveFavourite, moveFolder, moveScript, moveToFolder, renameFolder, toggleFavourite, ungroup, type Target } from "./layoutOps";

type Folder = Extract<LayoutItem, { type: "folder" }>;
type Badge = { kind: "failed" | "waiting" | "running" | "error"; text: string } | null;

/** Cards are at least this wide; the grid fits as many columns as it can. */
const CARD = 220;
const GAP = 8;

/** What a tile's corner says, most urgent first. */
export function badgeOf(script: Script, state: State, runs: Record<string, RunDetail>): Badge {
  const live = Object.values(runs).find((r) => r.script === script.id && isLive(r));
  if (live?.status === "waiting") return { kind: "waiting", text: "Waiting for your answer" };
  if (live) return { kind: "running", text: "Running…" };
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
  onEditWith,
  query,
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
    if (!id || drag.current) return setPeek(null);
    peekTimer.current = window.setTimeout(() => el!.isConnected && setPeek({ id, rect: el!.getBoundingClientRect() }), 450);
  };
  // Keyboard focus shows the same preview, so details aren't mouse-only.
  const focusPeek = (id: string, el: HTMLElement) => {
    if (el.matches(":focus-visible")) hover(id, el);
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
    return (
      <button
        key={`${where}:${id}`}
        className={`tile card packet ${selected === id ? "sel" : ""} ${d ? `drop-${d}` : ""}`}
        data-tile
        data-id={id}
        data-where={where}
        draggable
        aria-label={[s.name, b?.text, layout.favourites.includes(id) && !inFav ? "favourite" : ""].filter(Boolean).join(", ")}
        aria-description={s.description}
        aria-current={selected === id ? "true" : undefined}
        onClick={(e) => {
          hover(null);
          onOpen(id, e.detail === 0);
        }}
        onFocus={(e) => focusPeek(id, e.currentTarget)}
        onBlur={() => hover(null)}
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
          } else if (e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
            e.preventDefault();
            nudge(id, where, e.key === "ArrowLeft" ? -1 : 1);
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
        <span className={`packet-front hue-${hueOf(s.id)}`}>
          <Glyph script={s} size={30} />
          {b && <Sticker badge={b} />}
        </span>
        <span className="packet-label">
          <span className="card-name">{s.name}</span>
          <span className="card-sub">{[meta, s.description ?? asksFor(s)].filter(Boolean).join(" · ")}</span>
        </span>
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
        className={`tile card packet folder ${openFolder === f.id ? "open" : ""} ${d ? `drop-${d}` : ""}`}
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
        <span className="packet-front folder-front">
          {kids.slice(0, 3).map((k, i) => (
            <span key={k.id} className={`mini hue-${hueOf(k.id)}`} style={{ ["--i" as any]: i, ["--n" as any]: Math.min(3, kids.length) }}>
              <Glyph script={k} size={16} />
            </span>
          ))}
          {worst && <Sticker badge={worst} />}
        </span>
        <span className="packet-label">
          <span className="card-name">{f.name}</span>
          <span className="card-sub">
            Folder · {kids.length} script{kids.length === 1 ? "" : "s"}
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
  const toggleFolder = (id: string | null, focusId?: string) => {
    setOpenFolder(id);
    if (focusId) refocus(focusId);
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
      const f = folderOf(layout, id);
      const list = f ? f.scripts : layout.items.map((i) => i.id);
      const ref = list[list.indexOf(id) + d];
      if (!ref) return;
      next = moveScript(layout, id, { kind: d < 0 ? "before" : "after", ref } as Target).layout;
    }
    onLayout(next);
    refocus(id, where);
  };

  // Arrow keys move to the nearest tile in that direction, across sections and folders.
  // Columns come from the catalog's own width, which stays put while folders open and close.
  const root = useRef<HTMLDivElement>(null);
  const [cols, setCols] = useState(3);
  const [colW, setColW] = useState(CARD);
  useLayoutEffect(() => {
    const el = root.current!;
    const fit = () => {
      const cs = getComputedStyle(el);
      const w = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      const n = Math.max(1, Math.floor((w + GAP) / (CARD + GAP)));
      setCols(n);
      setColW((w - GAP * (n - 1)) / n);
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
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

  const shownItems = layout.items.filter((i) => i.type === "folder" || !layout.favourites.includes(i.id));

  // ---- the open folder's drawer, placed after the row that holds the folder ----
  const drawer = (f: Folder) => (
    <div className="drawer" key={`drawer:${f.id}`} style={{ ["--x" as any]: `${(shownItems.findIndex((i) => i.id === f.id) % cols) * (colW + GAP) + 26}px` }} {...dropZoneProps(f.id)}>
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
  const itemsGrid = (all: LayoutItem[]) => {
    // A favourite moves up to Favourites instead of showing twice (inside a folder it stays too).
    const items = all.filter((i) => i.type === "folder" || !layout.favourites.includes(i.id));
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
  // Favourites are shortcuts: the script also stays in its usual place.
  const hasFolders = layout.items.some((i) => i.type === "folder");
  const preview = peek && byId.get(peek.id);

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
            <p className="muted small">Nothing matches “{query}”.</p>
          ) : (
            <div className="tiles" data-tiles>
              {results.map((s) => scriptTile(s.id, "results", folderName(s.id) ? `in ${folderName(s.id)}` : undefined))}
            </div>
          )}
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
            {itemsGrid(layout.items)}
            {!hasFolders && state.scripts.length > 1 && (
              <p className="tip muted small">Tip: drag a script onto another to put them in a folder.</p>
            )}
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

/** One input as a chip: its label, and its default when it has one ("Times 3", "Mood calm"). */
function InputChip({ name, spec }: { name: string; spec: ParamSpec }) {
  const d = spec.default;
  const shown = d === undefined || d === "" || d === null ? "" : spec.kind === "boolean" ? (d ? "on" : "off") : fmtValue(spec, d);
  return (
    <span className="chip" title={[spec.description, spec.optional ? "Optional" : "Required"].filter(Boolean).join(". ")}>
      {labelOf(name, spec)}
      {shown && <span className="chip-val"> {shown}</span>}
      {spec.optional && <span className="chip-val">?</span>}
    </span>
  );
}

/** The round label on a packet's front that says, in a word or two, what needs attention. */
function Sticker({ badge }: { badge: Exclude<Badge, null> }) {
  const word = { failed: "Failed", error: "Broken", waiting: "Needs you", running: "Running" }[badge.kind];
  return (
    <span className={`sticker ${badge.kind}`} title={badge.text}>
      {word}
    </span>
  );
}

/** "Asks for Folder and Pattern", for a script with no description. */
function asksFor(s: Script) {
  const names = Object.entries(s.params).map(([k, p]) => labelOf(k, p));
  if (!names.length) return "No inputs needed";
  return `Asks for ${names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`}`;
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
        {params.length ? params.map(([k, p]) => <InputChip key={k} name={k} spec={p} />) : <span className="muted small">No inputs</span>}
      </div>
      <div className="peek-foot small">
        {last ? <span className={last.status === "failed" ? "bad-text" : last.status === "waiting" ? "warn-text" : ""}>{lastLabel(last)}</span> : <span className="muted">Never run</span>}
        {every && <span className="muted"> · every {every}</span>}
        {folder && <span className="muted"> · in {folder}</span>}
      </div>
    </div>
  );
}

/** Needs-you list for the top bar: questions waiting, schedules failing, scripts running. */
export function attentionOf(state: State, runs: Record<string, RunDetail>) {
  const name = (id: string) => state.scripts.find((s) => s.id === id)?.name ?? id;
  const live = Object.values(runs).filter(isLive);
  const waiting = live.filter((r) => r.status === "waiting").map((r) => ({ id: r.script, run: r.id, name: name(r.script), text: r.pendingAsk?.request.message ?? "Waiting for you", when: "", kind: "waiting" as const }));
  const failing = state.schedules
    .filter((s) => s.enabled && state.scripts.some((x) => x.id === s.script))
    .map((s) => ({ s, last: s.last ? (runs[s.last.id] ?? s.last) : null }))
    .filter((x) => x.last?.status === "failed")
    .map((x) => ({ id: x.s.script, run: x.last!.id, name: name(x.s.script), text: "", when: fmtAgo(x.last!.endedAt ?? x.last!.startedAt), kind: "failed" as const }));
  const running = live.filter((r) => r.status === "running").map((r) => ({ id: r.script, run: r.id, name: name(r.script), text: "Running", kind: "running" as const }));
  return { needs: [...waiting, ...failing], running };
}

