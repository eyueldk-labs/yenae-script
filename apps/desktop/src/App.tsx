import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Api, connect, isTauri, type RunDetail, type RunSummary, type Schedule, type Script, type State } from "./api";
import { ParamForm, defaults, fieldId, labelOf, missing } from "./Form";
import { RunOutput } from "./Output";
import { EditWithDialog, NewScriptDialog, SettingsDialog, modalOpen, preferredHarness } from "./Dialogs";
import { Board, lastLabel, type Open } from "./Board";
import { SchedulePanel } from "./Schedule";
import { MOD, SOURCE, STATUS, fmtDur, fmtParams, fmtTime, isLive } from "./fmt";

const store = {
  get<T>(k: string, fallback: T): T {
    try {
      const v = localStorage.getItem(k);
      return v === null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(k: string, v: unknown) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {}
  },
};

/** "activity" is the board; anything else is a script id. */
const ACTIVITY = ":activity";
type Tab = "output" | "history" | "schedule";
type Opening = { run?: string; tab?: Tab; focus?: boolean };

export function App() {
  const [api, setApi] = useState<Api | null>(null);
  const [state, setState] = useState<State | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [online, setOnline] = useState(false);
  const [runs, setRuns] = useState<Record<string, RunDetail>>({});
  const [selected, setSelected] = useState<string | null>(() => store.get("selected", null));
  const [opening, setOpening] = useState<Opening>({});
  const [dialog, setDialog] = useState<null | "new" | "settings">(null);
  const [query, setQuery] = useState("");
  const [announce, setAnnounce] = useState("");
  const search = useRef<HTMLInputElement>(null);

  useEffect(() => {
    connect()
      .then((c) => setApi(new Api(c)))
      .catch((e) => setError(e.message));
  }, []);

  const refresh = useCallback(async () => {
    if (!api) return;
    try {
      const s = await api.state();
      setState(s);
      setRuns((prev) => {
        const next = { ...prev };
        for (const r of s.live) next[r.id] = r;
        return next;
      });
      setError(null);
    } catch (e: any) {
      setError(e.message);
    }
  }, [api]);

  useEffect(() => {
    if (!api) return;
    refresh();
    return api.listen(
      (m) => {
        if (m.type === "state") refresh();
        else if (m.type === "run") {
          setRuns((prev) => {
            const before = prev[m.run.id];
            // A new or finished run changes schedules and recent runs: fetch them again.
            if (!before || (isLive(before) && !isLive(m.run))) queueMicrotask(refresh);
            return { ...prev, [m.run.id]: { ...(before ?? { events: [] }), ...m.run } as RunDetail };
          });
          if (m.run.status === "waiting" && m.run.pendingAsk) setAnnounce(`Waiting for you: ${m.run.pendingAsk.request.message}`);
        } else if (m.type === "event")
          setRuns((prev) => {
            const r = prev[m.runId];
            if (!r) return prev;
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

  useEffect(() => store.set("selected", selected === ACTIVITY ? null : selected), [selected]);

  const open: Open = (script, at = {}) => {
    setOpening({ ...at, focus: false });
    setSelected(script);
  };
  const pick = (id: string, focus: boolean) => {
    setOpening({ focus });
    setSelected(id);
  };

  // Ctrl/Cmd+K or "/" focuses search, Escape goes back to the list.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (modalOpen()) return;
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target as HTMLElement).tagName);
      if ((e.key === "k" && (e.ctrlKey || e.metaKey)) || (e.key === "/" && !typing)) {
        e.preventDefault();
        search.current?.focus();
        search.current?.select();
      } else if (e.key === "Escape") {
        if (typing) (e.target as HTMLElement).blur();
        else setSelected(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const scripts = state?.scripts ?? [];
  const filtered = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return scripts.filter((s) => words.every((w) => `${s.name} ${s.description ?? ""} ${s.id}`.toLowerCase().includes(w)));
  }, [scripts, query]);

  const script = scripts.find((s) => s.id === selected) ?? null;
  const liveByScript = useMemo(() => {
    const m = new Map<string, RunDetail>();
    for (const r of Object.values(runs)) if (isLive(r)) m.set(r.script, r);
    return m;
  }, [runs]);

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

  // Needs-you count for the Activity entry: questions waiting and schedules whose last run failed.
  const attention =
    [...liveByScript.values()].filter((r) => r.status === "waiting").length +
    state.schedules.filter((s) => s.enabled && (runs[s.last?.id ?? ""] ?? s.last)?.status === "failed").length;
  const showBoard = !script;

  return (
    <div className={`app ${selected ? "has-selection" : ""}`}>
      <aside className="sidebar">
        <div className="search">
          <input
            ref={search}
            autoFocus
            type="search"
            aria-label="Search scripts"
            placeholder={`Search scripts  ${MOD}+K`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && filtered[0]) {
                // Without this the same Enter lands on the field that just got focus and submits the form.
                e.preventDefault();
                pick(filtered[0].id, true);
              }
              if (e.key === "ArrowDown") {
                e.preventDefault();
                (document.querySelector(".list .item:not(.home)") as HTMLElement | null)?.focus();
              }
            }}
          />
        </div>
        <nav className="list" aria-label="Scripts">
          {!query && (
            <button className={`item home ${showBoard ? "active" : ""}`} aria-current={showBoard ? "page" : undefined} onClick={() => setSelected(ACTIVITY)}>
              <span className="item-name">
                Activity
                {attention > 0 && (
                  <span className="tag warn" aria-label={`${attention} need${attention === 1 ? "s" : ""} you`}>
                    {attention}
                  </span>
                )}
              </span>
            </button>
          )}
          <ScriptList
            scripts={filtered}
            schedules={state.schedules}
            runs={runs}
            live={liveByScript}
            selected={selected}
            onSelect={pick}
            empty={scripts.length === 0}
          />
        </nav>
        <div className="sidebar-foot">
          <button onClick={() => setDialog("new")}>New script</button>
          <button className="ghost" onClick={() => setDialog("settings")}>
            Settings
          </button>
          {!online && (
            <span className="offline" role="status" title="Lost the connection to the engine. Reconnecting…">
              Offline
            </span>
          )}
        </div>
      </aside>
      <main className="main">
        {script ? (
          <ScriptView
            key={script.id}
            api={api}
            script={script}
            state={state}
            runs={runs}
            setRuns={setRuns}
            opening={opening}
            onBack={() => setSelected(null)}
          />
        ) : (
          <Board state={state} runs={runs} onOpen={open} onBack={() => setSelected(null)} />
        )}
      </main>
      <div className="sr-only" aria-live="polite">
        {announce}
      </div>
      {dialog === "new" && (
        <NewScriptDialog
          api={api}
          state={state}
          onClose={() => setDialog(null)}
          onCreated={async (id) => {
            setDialog(null);
            await refresh();
            pick(id, false);
          }}
        />
      )}
      {dialog === "settings" && <SettingsDialog api={api} state={state} onClose={() => setDialog(null)} onSaved={refresh} />}
    </div>
  );
}

function ScriptList({
  scripts,
  schedules,
  runs,
  live,
  selected,
  onSelect,
  empty,
}: {
  scripts: Script[];
  schedules: Schedule[];
  runs: Record<string, RunDetail>;
  live: Map<string, RunDetail>;
  selected: string | null;
  onSelect: (id: string, focus: boolean) => void;
  empty: boolean;
}) {
  const groups = useMemo(() => {
    const m = new Map<string, Script[]>();
    for (const s of scripts) {
      const g = s.folder ? `${s.project} / ${s.folder}` : s.project;
      m.set(g, [...(m.get(g) ?? []), s]);
    }
    return [...m.entries()];
  }, [scripts]);

  if (!scripts.length) return <div className="muted pad">{empty ? "No scripts yet. Use New script to add one." : "No matches."}</div>;

  return (
    <>
      {groups.map(([group, items]) => (
        <div key={group}>
          <div className="group">{group}</div>
          {items.map((s) => {
            const sched = schedules.find((x) => x.script === s.id && x.enabled);
            const last = sched?.last ? (runs[sched.last.id] ?? sched.last) : null;
            const run = live.get(s.id);
            return (
              <button
                key={s.id}
                className={`item ${s.id === selected ? "active" : ""}`}
                aria-current={s.id === selected ? "page" : undefined}
                // detail is 0 when a key pressed the button: then move on into the form.
                onClick={(e) => onSelect(s.id, e.detail === 0)}
                onKeyDown={(e) => {
                  const all = [...document.querySelectorAll<HTMLElement>(".list .item")];
                  const i = all.indexOf(e.currentTarget);
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    all[i + 1]?.focus();
                  }
                  if (e.key === "ArrowUp") {
                    e.preventDefault();
                    (all[i - 1] ?? document.querySelector<HTMLElement>(".search input"))?.focus();
                  }
                }}
              >
                <span className="item-name">
                  <span className="grow">{s.name}</span>
                  {run?.status === "running" && <span className="dot running" title="Running" aria-label="Running" />}
                  {run?.status === "waiting" ? (
                    <span className="tag warn">waiting</span>
                  ) : last?.status === "failed" ? (
                    <span className="tag bad" title={`Last scheduled run: ${lastLabel(last)}`}>
                      failed
                    </span>
                  ) : (
                    sched && <span className="tag">every {sched.every}</span>
                  )}
                  {s.error && <span className="tag bad">error</span>}
                </span>
                {s.description && <span className="item-desc">{s.description}</span>}
              </button>
            );
          })}
        </div>
      ))}
    </>
  );
}

type Msg = { text: string; tone: "bad" | "note"; undo?: () => void };

function ScriptView({
  api,
  script,
  state,
  runs,
  setRuns,
  opening,
  onBack,
}: {
  api: Api;
  script: Script;
  state: State;
  runs: Record<string, RunDetail>;
  setRuns: React.Dispatch<React.SetStateAction<Record<string, RunDetail>>>;
  opening: Opening;
  onBack: () => void;
}) {
  const schedule = state.schedules.find((s) => s.script === script.id) ?? null;
  const [values, setValues] = useState<Record<string, unknown>>(() => ({
    ...defaults(script.params),
    ...store.get(`values:${script.id}`, {}),
  }));
  const [invalid, setInvalid] = useState<string[]>([]);
  const [history, setHistory] = useState<RunSummary[]>([]);
  const [shownRun, setShownRun] = useState<string | null>(opening.run ?? null);
  const [tab, setTab] = useState<Tab>(opening.tab ?? "output");
  const [msg, setMsg] = useState<Msg | null>(null);
  const [editWith, setEditWith] = useState<{ title: string; text: string } | null>(null);
  const view = useRef<HTMLDivElement>(null);
  const runButton = useRef<HTMLButtonElement>(null);

  useEffect(() => store.set(`values:${script.id}`, values), [script.id, values]);

  // Opened from the board (a run or tab) or picked with the keyboard (focus the form).
  useEffect(() => {
    if (opening.run) setShownRun(opening.run);
    if (opening.tab || opening.run) setTab(opening.tab ?? "output");
    if (!opening.focus) return;
    const first = view.current?.querySelector<HTMLElement>(".form input, .form select, .form textarea");
    (first ?? runButton.current)?.focus();
  }, [opening]);

  const loadHistory = useCallback(() => api.runs(script.id).then(setHistory).catch(() => {}), [api, script.id]);
  useEffect(() => {
    loadHistory();
  }, [loadHistory]);

  // A run for this script that the UI knows about, newest first.
  const known = Object.values(runs)
    .filter((r) => r.script === script.id)
    .sort((a, b) => b.startedAt - a.startedAt);
  const live = known.find(isLive);
  const runId = shownRun ?? live?.id ?? known[0]?.id ?? history[0]?.id ?? null;
  const run = runId ? runs[runId] : null;

  // Refresh history when a run of this script ends.
  const liveId = live?.id;
  useEffect(() => {
    if (!liveId) loadHistory();
  }, [liveId, loadHistory]);

  // Load a finished run's output when it's shown but not in memory.
  useEffect(() => {
    if (runId && (!runs[runId] || (runs[runId]!.events.length === 0 && runs[runId]!.status !== "running"))) {
      api.getRun(runId).then((r) => setRuns((p) => ({ ...p, [r.id]: r }))).catch(() => {});
    }
  }, [runId]);

  const start = async (params = values) => {
    const miss = missing(script.params, params);
    if (miss.length) {
      setInvalid(miss);
      setMsg({ text: `Fill in ${miss.map((k) => labelOf(k, script.params[k]!)).join(", ")}.`, tone: "bad" });
      document.getElementById(fieldId(miss[0]!))?.focus();
      return;
    }
    setInvalid([]);
    setMsg(null);
    try {
      const { id } = await api.run(script.id, params);
      setRuns((p) => ({
        ...p,
        [id]: p[id] ?? { id, script: script.id, params, source: "manual", status: "running", exitCode: null, error: null, startedAt: Date.now(), endedAt: null, events: [] },
      }));
      setShownRun(null);
      setTab("output");
    } catch (e: any) {
      setMsg({ text: e.message, tone: "bad" });
    }
  };

  // Ctrl/Cmd+Enter runs from anywhere in the window, not only from inside the form.
  const startRef = useRef(start);
  startRef.current = start;
  const liveRef = useRef(live);
  liveRef.current = live;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter" || !(e.ctrlKey || e.metaKey) || modalOpen()) return;
      e.preventDefault();
      if (!liveRef.current && !script.error) startRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const hasParams = Object.keys(script.params).length > 0;
  const agent = preferredHarness(state.harnesses);
  const editLabel = state.harnesses.length === 1 ? `Edit with ${agent!.name}` : "Edit with agent";
  const scheduleOn = !!schedule?.enabled;
  const schedLast = schedule?.last ? (runs[schedule.last.id] ?? schedule.last) : null;

  const fixFailure = (r: RunDetail) => {
    const err = r.events
      .filter((e) => e.t === "err")
      .map((e) => (e as { text: string }).text)
      .join("")
      .trim()
      .split("\n")
      .slice(-12)
      .join("\n");
    setEditWith({
      title: "Fix this script",
      text: `This run failed${r.exitCode ? ` with exit code ${r.exitCode}` : ""}.\n${err || r.error || ""}\n\nFind the cause and fix it.`,
    });
  };

  return (
    <div className="view" ref={view}>
      <header className="view-head">
        <button className="ghost back" onClick={onBack} aria-label="Back to list">
          ‹ Scripts
        </button>
        <h1>{script.name}</h1>
        {script.description && <p className="desc">{script.description}</p>}
        <div className="row wrap small">
          <code className="path">{script.id}</code>
          <button className="link" onClick={() => api.open(script.id).catch((e) => setMsg({ text: e.message, tone: "bad" }))}>
            Open file
          </button>
          {agent && (
            <button className="link" onClick={() => setEditWith({ title: editLabel, text: "" })}>
              {editLabel}
            </button>
          )}
        </div>
      </header>

      {editWith && (
        <EditWithDialog
          title={editWith.title}
          harnesses={state.harnesses}
          initial={editWith.text}
          onClose={() => setEditWith(null)}
          onSubmit={(h, what) => {
            setEditWith(null);
            api
              .editWith(script.id, h.id, what)
              .then(() => setMsg({ text: `Opened ${h.name} in a terminal.`, tone: "note" }))
              .catch((e) => setMsg({ text: e.message, tone: "bad" }));
          }}
        />
      )}

      {script.error && (
        <div className="error-wrap">
          <pre className="error-box">{script.error}</pre>
          {agent && (
            <button
              className="link"
              onClick={() => setEditWith({ title: "Fix this script", text: `This script doesn't load:\n${script.error}\n\nFind the cause and fix it.` })}
            >
              Fix with {state.harnesses.length === 1 ? agent.name : "agent"}
            </button>
          )}
        </div>
      )}

      {hasParams && (
        <ParamForm
          params={script.params}
          values={values}
          invalid={invalid}
          onChange={(v) => {
            setValues(v);
            if (invalid.length) setInvalid(missing(script.params, v).filter((k) => invalid.includes(k)));
          }}
          onSubmit={() => !live && start()}
        />
      )}

      <div className="actions">
        {live ? (
          <button className="danger run-btn" onClick={() => api.stop(live.id).catch((e) => setMsg({ text: e.message, tone: "bad" }))}>
            Stop
          </button>
        ) : (
          <button ref={runButton} className="primary run-btn" onClick={() => start()} disabled={!!script.error} aria-keyshortcuts="Control+Enter">
            Run
          </button>
        )}
        <span className="kbd-hint muted small" aria-hidden>
          {MOD}+Enter
        </span>
      </div>
      {msg && (
        <div className={`msg ${msg.tone}`} role={msg.tone === "bad" ? "alert" : "status"}>
          {msg.text}
          {msg.undo && (
            <>
              {" "}
              <button
                className="link"
                onClick={() => {
                  msg.undo!();
                  setMsg(null);
                }}
              >
                Undo
              </button>
            </>
          )}
        </div>
      )}

      <div className="tabs">
        <div role="tablist" aria-label="Script" className="tablist">
        {(
          [
            ["output", "Output"],
            ["history", `History${history.length ? ` (${history.length})` : ""}`],
            ["schedule", scheduleOn ? `Every ${schedule!.every}` : "Schedule"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            id={`tab-${id}`}
            role="tab"
            aria-selected={tab === id}
            aria-controls={`panel-${id}`}
            tabIndex={tab === id ? 0 : -1}
            className={tab === id ? "on" : ""}
            onClick={() => setTab(id)}
            onKeyDown={(e) => {
              const order: Tab[] = ["output", "history", "schedule"];
              const d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
              if (!d) return;
              const next = order[(order.indexOf(id) + d + order.length) % order.length]!;
              setTab(next);
              document.getElementById(`tab-${next}`)?.focus();
            }}
          >
            {label}
            {id === "schedule" && scheduleOn && schedLast && (schedLast.status === "failed" || schedLast.status === "waiting") && (
              <span className={`dot ${schedLast.status}`} aria-label={STATUS[schedLast.status]} />
            )}
          </button>
        ))}
        </div>
        {run && tab === "output" && <RunStatusLine run={run} />}
      </div>

      {tab === "output" && (
        <div role="tabpanel" id="panel-output" aria-labelledby="tab-output" className="panel">
          {run ? (
            <RunOutput
              key={run.id}
              run={run}
              onAnswer={(id, v) => api.answer(run.id, id, v).catch((e) => setMsg({ text: e.message, tone: "bad" }))}
              footer={
                run.status === "failed" && (
                  <div className="row wrap after-run">
                    {!live && (
                      <button onClick={() => start({ ...values, ...run.params })} disabled={!!script.error}>
                        Run again
                      </button>
                    )}
                    {agent && <button onClick={() => fixFailure(run)}>Fix with {state.harnesses.length === 1 ? agent.name : "agent"}</button>}
                  </div>
                )
              }
            />
          ) : (
            <div className="output muted">No runs yet. {hasParams ? "Fill in the form and press Run." : "Press Run to start it."}</div>
          )}
        </div>
      )}

      {tab === "history" && (
        <div className="history" role="tabpanel" id="panel-history" aria-labelledby="tab-history">
          {history.length === 0 && <div className="muted pad">No runs yet.</div>}
          {history.map((h) => (
            <div key={h.id} className={`hist ${h.id === runId ? "active" : ""}`}>
              <button
                className="hist-main"
                onClick={() => {
                  setShownRun(h.id);
                  setTab("output");
                }}
              >
                <span className={`dot ${h.status}`} aria-hidden />
                <span className={`hist-status ${h.status === "failed" ? "bad-text" : ""}`}>{STATUS[h.status]}</span>
                <span>{fmtTime(h.startedAt)}</span>
                {SOURCE[h.source] && <span className="muted">{SOURCE[h.source]}</span>}
                <span className="muted">{h.endedAt ? fmtDur(h.endedAt - h.startedAt) : ""}</span>
                {Object.keys(h.params).length > 0 && <span className="muted params">{fmtParams(h.params)}</span>}
              </button>
              {hasParams && (
                <button
                  className="link"
                  title="Fill the form with this run's values"
                  onClick={() => {
                    const before = values;
                    setValues({ ...values, ...h.params });
                    setMsg({ text: `Filled the form from the run at ${fmtTime(h.startedAt)}.`, tone: "note", undo: () => setValues(before) });
                  }}
                >
                  Use values
                </button>
              )}
              <button className="link" disabled={!!live || !!script.error} onClick={() => start({ ...values, ...h.params })}>
                Run again
              </button>
            </div>
          ))}
        </div>
      )}

      {tab === "schedule" && (
        <SchedulePanel
          key={`${schedule?.enabled}:${schedule?.every}`}
          api={api}
          script={script}
          schedule={schedule}
          last={schedLast}
          values={values}
          onMissing={(keys) => {
            setInvalid(keys);
            document.getElementById(fieldId(keys[0]!))?.focus();
          }}
          onShowRun={(id) => {
            setShownRun(id);
            setTab("output");
          }}
        />
      )}
    </div>
  );
}

function RunStatusLine({ run }: { run: RunDetail }) {
  return (
    <span className={`status ${run.status}`} role="status">
      <span className={`dot ${run.status}`} aria-hidden />
      {STATUS[run.status]}
      {run.status === "failed" && run.exitCode !== null && run.exitCode !== 0 && ` (exit ${run.exitCode})`}
      <span className="muted"> · {fmtTime(run.startedAt)}</span>
    </span>
  );
}
