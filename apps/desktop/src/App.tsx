import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { Plus, Search, Settings, X } from "lucide-react";
import { Api, EngineError, connect, isTauri, type EngineStatus, type Layout, type RunDetail, type RunEvent, type State } from "./api";
import { defaults, missing } from "./Form";
import { ConfirmDeleteDialog, EditScriptDialog, NewScriptDialog, SettingsDialog, modalOpen } from "./Dialogs";
import { Home, attentionOf } from "./Home";
import { Panel, type Opening } from "./Panel";
import { isLive } from "./fmt";
import { toggleFavourite } from "./layoutOps";
import { store } from "./store";
import { setHueIds } from "./icons";
import { applyUpdate, dismissWhatsNew, noteLines, reportUiReady, useUpdateStatus } from "./updates";

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
  const [editing, setEditing] = useState<{ id: string; tab?: "ask" | "code"; text?: string } | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  // After deleting: "Deleted X · Undo", until dismissed or replaced.
  const [undo, setUndo] = useState<{ trash: string; name: string } | null>(null);
  useEffect(() => {
    if (!undo) return;
    const t = setTimeout(() => setUndo(null), 12_000);
    return () => clearTimeout(t);
  }, [undo]);
  const [query, setQuery] = useState("");
  const [announce, setAnnounce] = useState("");
  const [tick, setTick] = useState(0);
  const search = useRef<HTMLInputElement>(null);

  // Set when the background engine couldn't start: why, its last words, and the log file.
  const [engineFail, setEngineFail] = useState<EngineStatus | null>(null);
  const [connectKey, setConnectKey] = useState(0);
  useEffect(() => {
    connect()
      .then((c) => setApi(new Api(c)))
      .catch((e) => (e instanceof EngineError ? setEngineFail(e.status) : setError(e.message)));
  }, [connectKey]);

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
  const [allAlerts, setAllAlerts] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  // Once the engine answered and the window drew, this version is known to work.
  useEffect(() => {
    if (state) reportUiReady();
  }, [!!state]);
  // Updates download by themselves; this only shows what is ready or just happened.
  const upd = useUpdateStatus();
  const [laterFor, setLaterFor] = useState<string | null>(null);
  const [notesOpen, setNotesOpen] = useState(false);

  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const attention = useMemo(() => (state ? attentionOf(state, runs) : { needs: [], running: [] }), [state, runs, tick]);

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

  // Opening or closing a panel changes how many columns fit. Where the browser can, the
  // cards glide to their new places, and the chosen card is brought back into view.
  const glide = (update: () => void, focusId?: string | null) => {
    const vt = (document as any).startViewTransition as undefined | ((cb: () => void) => unknown);
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    // Once the new layout is in place, the chosen card is scrolled back into view.
    const reveal = () =>
      focusId &&
      requestAnimationFrame(() =>
        document.querySelector<HTMLElement>(`.home [data-tile][data-id="${CSS.escape(focusId)}"]`)?.scrollIntoView({ block: "nearest" }),
      );
    if (vt && !reduce) {
      // A transition that gets skipped (another one started) is fine: the update still happens.
      const t = vt.call(document, () => flushSync(update)) as { ready?: Promise<void>; finished?: Promise<void>; updateCallbackDone?: Promise<void> };
      for (const p of [t?.ready, t?.finished]) p?.catch(() => {});
      (t?.updateCallbackDone ?? Promise.resolve()).then(reveal, reveal);
    } else {
      update();
      reveal();
    }
  };
  // Whether the last input was a key press: focus goes back to a card only for keyboard users.
  const viaKeyboard = useRef(false);
  const openedByKeyboard = useRef(false);
  useEffect(() => {
    const key = () => (viaKeyboard.current = true);
    const pointer = () => (viaKeyboard.current = false);
    window.addEventListener("keydown", key, true);
    window.addEventListener("pointerdown", pointer, true);
    return () => {
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("pointerdown", pointer, true);
    };
  }, []);
  // The animated close applies a frame later; a second Escape meanwhile must not close again.
  const closing = useRef(false);
  const open = (id: string, at: Omit<Opening, "key"> = {}) => {
    closing.current = false;
    openedByKeyboard.current = viaKeyboard.current;
    const change = () => {
      setSelected(id);
      setOpening((o) => ({ ...at, key: o.key + 1 }));
    };
    if (selected) change();
    else glide(change, id);
  };
  const close = () => {
    if (closing.current) return;
    closing.current = true;
    const was = selected;
    glide(() => {
      setSelected(null);
      closing.current = false;
    }, was);
    setWide(false);
    // Keyboard users go back to the card the panel came from.
    if (openedByKeyboard.current)
      requestAnimationFrame(() => ((was && document.querySelector<HTMLElement>(`[data-tile][data-id="${CSS.escape(was)}"]`)) || search.current)?.focus({ preventScroll: true }));
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
        else if (selected && !closing.current) close();
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
  if (engineFail) {
    return (
      <div className="center">
        <p>
          <b>{engineFail.failed}</b>
        </p>
        <p className="muted small">Yenae Script {engineFail.version}</p>
        <div className="row">
          <button
            className="primary"
            onClick={async () => {
              setEngineFail(null);
              const { invoke } = await import("@tauri-apps/api/core");
              await invoke("restart_engine").catch(() => {});
              setConnectKey((k) => k + 1);
            }}
          >
            Try again
          </button>
          <button onClick={() => navigator.clipboard?.writeText([engineFail.failed, `Version ${engineFail.version}`, ...engineFail.log].join("\n"))}>Copy details</button>
        </div>
        {engineFail.log.length > 0 && (
          <details className="tech engine-log">
            <summary>Technical details</summary>
            <pre className="log">{engineFail.log.join("\n")}</pre>
            <p className="muted small">Full log: {engineFail.logFile}</p>
          </details>
        )}
      </div>
    );
  }
  if (!state || !api) return <div className="center muted">Starting Yenae Script…</div>;

  // The script whose panel is open keeps its row (marked as open) so nothing jumps.
  const alerts = attention.needs.filter((n) => !dismissed.has(n.run));


  return (
    <div className={`app ${script ? "has-panel" : ""} ${wide ? "wide" : ""}`}>
      <div className="catalog">
        {(
          <div className={`bar ${scrolled ? "scrolled" : ""}`}>
            <span className="wordmark">
              <svg className="logo" viewBox="0 0 24 24" aria-hidden>
                <rect width="24" height="24" rx="7" fill="currentColor" />
                <path d="M9.5 7.6v8.8a.6.6 0 0 0 .92.5l6.6-4.4a.6.6 0 0 0 0-1l-6.6-4.4a.6.6 0 0 0-.92.5Z" fill="var(--bg)" />
                <rect x="5.5" y="7" width="2" height="10" rx="1" fill="var(--bg)" opacity=".55" />
              </svg>
              <span className="wordmark-text">Yenae Script</span>
            </span>
            <div className="search">
              <Search size={16} className="search-icon" aria-hidden />
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
              <span className="label-short">New</span>
            </button>
            <button className="ib" title="Settings" aria-label="Settings" onClick={() => setDialog("settings")}>
              <Settings size={18} />
            </button>
          </div>
        )}
        <main className="catalog-body" onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 2)}>
          {!query && upd && (upd.applying || upd.error || (upd.ready && laterFor !== upd.ready) || upd.whatsNew) && (
            <div className={`update-bar ${upd.error ? "bad" : ""} ${notesOpen ? "open" : ""}`} role="status">
              <span className={`dot ${upd.error ? "failed" : "ok"}`} aria-hidden />
              <span className="grow">
                {upd.applying ? (
                  "Updating…"
                ) : upd.error ? (
                  upd.error
                ) : upd.ready ? (
                  upd.waiting ? (
                    <>Version {upd.ready} installs as soon as your running scripts finish.</>
                  ) : (
                    <>Version {upd.ready} is ready.</>
                  )
                ) : (
                  <>
                    <b>Updated to {upd.whatsNew!.version}.</b>
                    {noteLines(upd.whatsNew!.notes).length > 0 && (
                      <>
                        {" "}
                        <button className="link" aria-expanded={notesOpen} onClick={() => setNotesOpen(!notesOpen)}>
                          What's new
                        </button>
                      </>
                    )}
                    {notesOpen && (
                      <ul className="whats-new">
                        {noteLines(upd.whatsNew!.notes).map((l, i) => (
                          <li key={i}>{l}</li>
                        ))}
                      </ul>
                    )}
                  </>
                )}
              </span>
              {upd.ready && !upd.applying && !upd.waiting && !upd.error && (
                <button className="primary small-btn" onClick={() => applyUpdate().catch(() => {})}>
                  Restart to update
                </button>
              )}
              {!upd.applying && (
                <button
                  className="ib"
                  aria-label={upd.ready && !upd.error ? "Later" : "Dismiss"}
                  title={upd.ready && !upd.error ? "Later" : "Dismiss"}
                  onClick={() => (upd.ready && !upd.error ? setLaterFor(upd.ready) : dismissWhatsNew())}
                >
                  <X size={16} aria-hidden />
                </button>
              )}
            </div>
          )}
          {!query && alerts.length > 0 && (
            // What needs the user: one row each, each with the one thing to do about it. Two at most
            // until "more" is pressed. An alert for the script already open is hidden (the panel says it).
            <ul className="alerts" aria-label="Needs you">
              {(allAlerts || alerts.length <= 2 ? alerts : alerts.slice(0, 1)).map((n) => (
                <li key={n.run} className={`alert ${n.kind} ${n.id === selected ? "current" : ""}`} aria-current={n.id === selected || undefined}>
                  <span className={`dot ${n.kind}`} aria-hidden />
                  <span className="grow alert-text">
                    <b>{n.name}</b> {n.kind === "waiting" ? "is waiting for your answer" : `failed ${n.when}`}
                  </span>
                  {n.id === selected ? null : (
                    <button className={n.kind === "waiting" ? "primary small-btn" : "small-btn"} onClick={() => open(n.id, { run: n.run })}>
                      {n.kind === "waiting" ? "Answer" : "See why"}
                    </button>
                  )}
                  <button className="ib" aria-label={`Dismiss ${n.name}`} title="Dismiss" onClick={() => setDismissed((d) => new Set(d).add(n.run))}>
                    <X size={16} aria-hidden />
                  </button>
                </li>
              ))}
              {alerts.length > 2 && !allAlerts && (
                <li className="alert more-alerts">
                  <button className="link" onClick={() => setAllAlerts(true)}>
                    +{alerts.length - 1} more
                  </button>
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
            onEdit={(id) => setEditing({ id })}
            onDelete={(id) => setDeleting(id)}
            query={query}
            onClearSearch={() => {
              setQuery("");
              search.current?.focus();
            }}
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
          onEdit={(tab, text) => setEditing({ id: script.id, tab, text })}
          onDelete={() => setDeleting(script.id)}
        />
      )}

      {(undo || error) && (
        <div className="toasts">
          {undo && (
            <div className="update-bar note-bar" role="status">
              <span className="grow">Deleted {undo.name}</span>
              <button
                onClick={async () => {
                  const u = undo;
                  setUndo(null);
                  try {
                    await api.restoreScript(u.trash);
                    refresh();
                  } catch (e: any) {
                    setError(e.message);
                  }
                }}
              >
                Undo
              </button>
              <button className="ib" aria-label="Dismiss" title="Dismiss" onClick={() => setUndo(null)}>
                <X size={16} />
              </button>
            </div>
          )}
          {error && (
            <div className="update-bar bad" role="alert">
              <span className="grow">{error}</span>
              <button className="ib" aria-label="Dismiss" title="Dismiss" onClick={() => setError(null)}>
                <X size={16} />
              </button>
            </div>
          )}
        </div>
      )}
      <div className="sr-only" aria-live="polite">
        {announce}
      </div>
      {editing && (
        <EditScriptDialog
          api={api}
          script={{ id: editing.id, name: state.scripts.find((s) => s.id === editing.id)?.name ?? "script" }}
          harnesses={state.harnesses}
          tab={editing.tab}
          initial={editing.text}
          onClose={() => setEditing(null)}
          onStarted={() => {
            const id = editing.id;
            setEditing(null);
            open(id);
          }}
          onSaved={refresh}
        />
      )}
      {deleting && (
        <ConfirmDeleteDialog
          name={state.scripts.find((s) => s.id === deleting)?.name ?? "this script"}
          onClose={() => setDeleting(null)}
          onDelete={async () => {
            const id = deleting;
            const name = state.scripts.find((s) => s.id === id)?.name ?? "Script";
            setDeleting(null);
            if (selected === id) close();
            try {
              const { trash } = await api.deleteScript(id);
              setUndo({ trash, name });
              refresh();
            } catch (e: any) {
              setError(e.message);
            }
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
