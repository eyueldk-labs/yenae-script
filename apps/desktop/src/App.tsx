import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Plus, Settings, X } from "lucide-react";
import { Api, connect, isTauri, type Layout, type RunDetail, type RunEvent, type State } from "./api";
import { defaults, missing } from "./Form";
import { EditWithDialog, NewScriptDialog, SettingsDialog, modalOpen } from "./Dialogs";
import { Home, attentionOf } from "./Home";
import { Panel, type Opening } from "./Panel";
import { fmtEvery, isLive } from "./fmt";
import { toggleFavourite } from "./layoutOps";
import { store } from "./store";
import { setHueIds } from "./icons";

export function App() {
  const [api, setApi] = useState<Api | null>(null);
  const [state, setState] = useState<State | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [online, setOnline] = useState(false);
  const [runs, setRuns] = useState<Record<string, RunDetail>>({});
  const [selected, setSelected] = useState<string | null>(() => store.get("selected", null));
  const [opening, setOpening] = useState<Opening>({ key: 0 });
  const [wide, setWide] = useState(false);
  const [dialog, setDialog] = useState<null | "new" | "settings">(null);
  const [editWith, setEditWith] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [announce, setAnnounce] = useState("");
  const [, setTick] = useState(0);
  const search = useRef<HTMLInputElement>(null);

  useEffect(() => {
    connect()
      .then((c) => setApi(new Api(c)))
      .catch((e) => setError(e.message));
  }, []);

  // Relative times ("4 min ago", "next in 6 min") stay true while the window is left open.
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  const refresh = useCallback(async () => {
    if (!api) return;
    try {
      const s = await api.state();
      setState(s);
      setRuns((prev) => {
        const next = { ...prev };
        // A state fetched while a run was live can arrive after the run's "finished"
        // message; never let it turn a finished run back into a live one.
        // A snapshot can also be older than output already streamed in: keep the longer log.
        for (const r of s.live) {
          const had = prev[r.id];
          if (had && !isLive(had)) continue;
          next[r.id] = had && had.events.length > r.events.length ? { ...r, events: had.events } : r;
        }
        return next;
      });
      setError(null);
    } catch (e: any) {
      setError(e.message);
    }
  }, [api]);

  // Output that arrives before its run's record is kept here until the record does.
  const early = useRef<Record<string, RunEvent[]>>({});

  useEffect(() => {
    if (!api) return;
    refresh();
    // A finished run's stored events are the full truth: replace whatever was streamed.
    const settle = (id: string) =>
      api
        .getRun(id)
        .then((r) => setRuns((p) => ({ ...p, [id]: r })))
        .catch(() => {});
    return api.listen(
      (m) => {
        if (m.type === "state") refresh();
        else if (m.type === "run") {
          setRuns((prev) => {
            const before = prev[m.run.id];
            // A new or finished run changes schedules and last results: fetch them again.
            if (!before || (isLive(before) && !isLive(m.run))) queueMicrotask(refresh);
            if (before && isLive(before) && !isLive(m.run)) queueMicrotask(() => settle(m.run.id));
            const events = before?.events.length ? before.events : (early.current[m.run.id] ?? []);
            delete early.current[m.run.id];
            return { ...prev, [m.run.id]: { ...before, ...m.run, events } as RunDetail };
          });
          if (m.run.status === "waiting" && m.run.pendingAsk) setAnnounce(`Waiting for you: ${m.run.pendingAsk.request.message}`);
        } else if (m.type === "event")
          setRuns((prev) => {
            const r = prev[m.runId];
            if (!r) {
              (early.current[m.runId] ??= []).push(m.event);
              return prev;
            }
            const events = r.events.slice();
            const last = events[events.length - 1];
            // The engine merges consecutive output chunks; mirror that here.
            if (last && (m.event.t === "out" || m.event.t === "err") && last.t === m.event.t && m.event.at - last.at < 1000 && last.text.length < 8000)
              events[events.length - 1] = { ...last, text: last.text + m.event.text };
            else events.push(m.event);
            return { ...prev, [m.runId]: { ...r, events } };
          });
      },
      (up) => {
        setOnline(up);
        if (up) refresh();
      },
    );
  }, [api, refresh]);

  useEffect(() => store.set("selected", selected), [selected]);

  const script = state?.scripts.find((s) => s.id === selected) ?? null;
  if (state) setHueIds(state.scripts.map((s) => s.id));
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [allAlerts, setAllAlerts] = useState(false);
  const attention = useMemo(() => (state ? attentionOf(state, runs) : { needs: [], running: [] }), [state, runs]);

  // The tray says how many things need you while the window is hidden.
  useEffect(() => {
    if (!isTauri()) return;
    import("@tauri-apps/api/core").then(({ invoke }) => invoke("set_attention", { count: attention.needs.length })).catch(() => {});
  }, [attention.needs.length]);

  // The hotkey shows the window: put the cursor in search, launcher-style.
  useEffect(() => {
    if (!isTauri()) return;
    let off: (() => void) | undefined;
    import("@tauri-apps/api/event").then(({ listen }) =>
      listen("shown", () => {
        if (!modalOpen()) {
          search.current?.focus();
          search.current?.select();
        }
      }).then((u) => (off = u)),
    );
    return () => off?.();
  }, []);

  const open = (id: string, at: Omit<Opening, "key"> = {}) => {
    setSelected(id);
    setOpening((o) => ({ ...at, key: o.key + 1 }));
  };
  const close = () => {
    const was = selected;
    setSelected(null);
    setWide(false);
    // Back to the tile the panel came from.
    requestAnimationFrame(() => ((was && document.querySelector<HTMLElement>(`[data-tile][data-id="${CSS.escape(was)}"]`)) || search.current)?.focus());
  };

  const saveLayout = (l: Layout) => {
    if (!api) return;
    setState((s) => (s ? { ...s, layout: l } : s));
    api.saveLayout(l).then((saved) => setState((s) => (s ? { ...s, layout: saved } : s))).catch((e) => setError(e.message));
  };

  // Run from the catalog with the form's last values; a missing value opens the form instead.
  const quickRun = async (id: string) => {
    const s = state?.scripts.find((x) => x.id === id);
    if (!s || !api) return;
    const values = { ...defaults(s.params), ...store.get<Record<string, unknown>>(`values:${id}`, {}) };
    if (missing(s.params, values).length) return open(id, { focus: true });
    const { id: run } = await api.run(id, values).catch((e) => (setError(e.message), { id: "" }));
    if (run) open(id, { run });
  };

  // Ctrl/Cmd+K or "/" focuses search; Escape closes the panel, then clears search.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (modalOpen()) return;
      const t = e.target as HTMLElement;
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName);
      if ((e.key === "k" && (e.ctrlKey || e.metaKey)) || (e.key === "/" && !typing)) {
        e.preventDefault();
        search.current?.focus();
        search.current?.select();
      } else if (e.key === "Escape") {
        if (typing && t !== search.current) t.blur();
        else if (selected) close();
        else if (query) {
          setQuery("");
          search.current?.focus();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (error && !state) {
    return (
      <div className="center">
        <p>{error}</p>
        {!isTauri() && <p className="muted">In a browser, open this page with ?token=… from the engine's data folder.</p>}
        <button onClick={() => location.reload()}>Try again</button>
      </div>
    );
  }
  if (!state || !api) return <div className="center muted">Loading…</div>;

  const alerts = attention.needs.filter((n) => !dismissed.has(n.run) && n.id !== selected);


  return (
    <div className={`app ${script ? "has-panel" : ""} ${wide ? "wide" : ""}`}>
      <div className="catalog">
        {(
          <div className="bar">
            <span className="wordmark">
              <span className="logo" aria-hidden />
              <span className="wordmark-text">Yenae Script</span>
            </span>
            <div className="search">
              <input
                ref={search}
                type="search"
                aria-label="Search scripts"
                placeholder="Search scripts"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    const first = document.querySelector<HTMLElement>(".home [data-tile]:not(.folder)");
                    if (first) {
                      // preventDefault stops this Enter from also landing in the form that gets focus.
                      e.preventDefault();
                      // A click from code has detail 0, like a key press, so the panel focuses its form.
                      first.click();
                    }
                  }
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    document.querySelector<HTMLElement>(".home [data-tile]")?.focus();
                  }
                }}
              />
              {query && (
                <button
                  className="search-clear"
                  aria-label="Clear search"
                  onClick={() => {
                    setQuery("");
                    search.current?.focus();
                  }}
                >
                  <X size={14} aria-hidden />
                </button>
              )}
            </div>
            <span className="grow" />
            {!online && (
              <span className="offline" role="status" title="Lost the connection to the engine. Reconnecting…">
                Reconnecting…
              </span>
            )}
            <button className="new-btn" onClick={() => setDialog("new")} aria-label="New script" title="New script">
              <Plus size={16} aria-hidden />
              <span className="label">New script</span>
            </button>
            <button className="ib" title="Settings" aria-label="Settings" onClick={() => setDialog("settings")}>
              <Settings size={18} />
            </button>
          </div>
        )}
        <main className="catalog-body">
          {!query && alerts.length > 0 && (
            // What needs the user, in sentences, each with the one thing to do about it. An alert
            // for the script already open is hidden (the panel says it), and any can be dismissed.
            <ul className="alerts" aria-label="Needs you">
              {(alerts.length > 2 && !allAlerts ? alerts.slice(0, 1) : alerts).map((n) => (
                <li key={n.run} className={`alert ${n.kind}`}>
                  <span className={`dot ${n.kind}`} aria-hidden />
                  <span className="grow">
                    <b>{n.name}</b> {n.kind === "waiting" ? "needs your answer" : `failed ${n.when}`}
                    {n.every && <span className="muted"> · runs every {fmtEvery(n.every)}</span>}
                  </span>
                  {n.every && (
                    <button
                      onClick={() => {
                        const sc = state.schedules.find((x) => x.script === n.id);
                        if (sc) api.schedule(n.id, sc.every, sc.params, false).catch((e) => setError(e.message));
                      }}
                    >
                      Pause
                    </button>
                  )}
                  <button className={n.kind === "waiting" ? "primary" : ""} onClick={() => open(n.id, { run: n.run })}>
                    {n.kind === "waiting" ? "Answer" : "See why"}
                  </button>
                  <button className="ib" aria-label="Dismiss" title="Dismiss" onClick={() => setDismissed((d) => new Set(d).add(n.run))}>
                    <X size={16} aria-hidden />
                  </button>
                </li>
              ))}
              {alerts.length > 2 && !allAlerts && (
                <li className="alert more-alerts">
                  <span className="grow muted">and {alerts.length - 1} more things need you</span>
                  <button onClick={() => setAllAlerts(true)}>Show all</button>
                </li>
              )}
            </ul>
          )}
          <Home
            api={api}
            state={state}
            runs={runs}
            layout={state.layout}
            onLayout={saveLayout}
            selected={selected}
            onOpen={(id, focus) => open(id, { focus })}
            onRun={quickRun}
            onEditWith={(id) => setEditWith(id)}
            query={query}
          />
        </main>
      </div>

      {script && (
        <Panel
          key={script.id}
          api={api}
          script={script}
          state={state}
          runs={runs}
          setRuns={setRuns}
          opening={opening}
          favourite={state.layout.favourites.includes(script.id)}
          layout={state.layout}
          onLayout={saveLayout}
          wide={wide}
          onFavourite={() => saveLayout(toggleFavourite(state.layout, script.id))}
          onWide={() => setWide((w) => !w)}
          onClose={close}
        />
      )}

      <div className="sr-only" aria-live="polite">
        {announce}
      </div>
      {editWith && (
        <EditWithDialog
          title={`Edit ${state.scripts.find((s) => s.id === editWith)?.name ?? "script"}`}
          harnesses={state.harnesses}
          onClose={() => setEditWith(null)}
          onSubmit={(h, what) => {
            const id = editWith;
            setEditWith(null);
            api.editWith(id, h.id, what).catch((e) => setError(e.message));
          }}
        />
      )}
      {dialog === "new" && (
        <NewScriptDialog
          api={api}
          state={state}
          onClose={() => setDialog(null)}
          onCreated={async (id) => {
            setDialog(null);
            await refresh();
            open(id);
          }}
        />
      )}
      {dialog === "settings" && <SettingsDialog api={api} state={state} onClose={() => setDialog(null)} onSaved={refresh} />}
    </div>
  );
}
