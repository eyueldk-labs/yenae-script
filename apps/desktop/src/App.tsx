import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Api, connect, isTauri, type RunDetail, type RunSummary, type Schedule, type Script, type State } from "./api";
import { ParamForm, defaults, missing } from "./Form";
import { RunOutput } from "./Output";
import { EditWithDialog, NewScriptDialog, SettingsDialog } from "./Dialogs";

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

export function App() {
  const [api, setApi] = useState<Api | null>(null);
  const [state, setState] = useState<State | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [online, setOnline] = useState(false);
  const [runs, setRuns] = useState<Record<string, RunDetail>>({});
  const [selected, setSelected] = useState<string | null>(() => store.get("selected", null));
  const [dialog, setDialog] = useState<null | "new" | "settings">(null);
  const [query, setQuery] = useState("");
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
        else if (m.type === "run")
          setRuns((prev) => ({ ...prev, [m.run.id]: { ...(prev[m.run.id] ?? { events: [] }), ...m.run } as RunDetail }));
        else if (m.type === "event")
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

  useEffect(() => store.set("selected", selected), [selected]);

  // Ctrl/Cmd+K or "/" focuses search, Escape goes back to the list.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target as HTMLElement).tagName);
      if ((e.key === "k" && (e.ctrlKey || e.metaKey)) || (e.key === "/" && !typing)) {
        e.preventDefault();
        search.current?.focus();
        search.current?.select();
      } else if (e.key === "Escape" && !dialog) {
        if (typing) (e.target as HTMLElement).blur();
        else setSelected(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dialog]);

  const scripts = state?.scripts ?? [];
  const filtered = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return scripts.filter((s) => words.every((w) => `${s.name} ${s.description ?? ""} ${s.id}`.toLowerCase().includes(w)));
  }, [scripts, query]);

  const script = scripts.find((s) => s.id === selected) ?? null;
  const liveByScript = useMemo(() => {
    const m = new Map<string, RunDetail>();
    for (const r of Object.values(runs)) if (r.status === "running" || r.status === "waiting") m.set(r.script, r);
    return m;
  }, [runs]);

  if (error && !state) {
    return (
      <div className="center">
        <p>Can't reach the engine: {error}</p>
        {!isTauri() && <p className="muted">Open with ?token=… from the engine's data folder.</p>}
        <button onClick={() => location.reload()}>Retry</button>
      </div>
    );
  }
  if (!state || !api) return <div className="center muted">Loading…</div>;

  return (
    <div className={`app ${script ? "has-selection" : ""}`}>
      <aside className="sidebar">
        <div className="search">
          <input
            ref={search}
            autoFocus
            placeholder="Search scripts"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && filtered[0]) setSelected(filtered[0].id);
              if (e.key === "ArrowDown") (document.querySelector(".item") as HTMLElement | null)?.focus();
            }}
          />
        </div>
        <ScriptList
          scripts={filtered}
          schedules={state.schedules}
          live={liveByScript}
          selected={selected}
          onSelect={setSelected}
          empty={scripts.length === 0}
        />
        <div className="sidebar-foot">
          <button onClick={() => setDialog("new")}>New script</button>
          <button className="ghost" title="Settings" onClick={() => setDialog("settings")}>
            Settings
          </button>
          {!online && <span className="offline">Offline</span>}
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
            onBack={() => setSelected(null)}
          />
        ) : (
          <div className="center muted">
            {scripts.length ? "Pick a script." : "No scripts yet."}
          </div>
        )}
      </main>
      {dialog === "new" && (
        <NewScriptDialog
          api={api}
          state={state}
          onClose={() => setDialog(null)}
          onCreated={async (id) => {
            setDialog(null);
            await refresh();
            setSelected(id);
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
  live,
  selected,
  onSelect,
  empty,
}: {
  scripts: Script[];
  schedules: Schedule[];
  live: Map<string, RunDetail>;
  selected: string | null;
  onSelect: (id: string) => void;
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

  if (!scripts.length) return <div className="list muted pad">{empty ? "Add a script to get started." : "No matches."}</div>;

  return (
    <nav className="list">
      {groups.map(([group, items]) => (
        <div key={group}>
          <div className="group">{group}</div>
          {items.map((s) => {
            const sched = schedules.find((x) => x.script === s.id && x.enabled);
            const run = live.get(s.id);
            return (
              <button
                key={s.id}
                className={`item ${s.id === selected ? "active" : ""}`}
                onClick={() => onSelect(s.id)}
                onKeyDown={(e) => {
                  const el = e.currentTarget;
                  const all = [...document.querySelectorAll<HTMLElement>(".item")];
                  const i = all.indexOf(el);
                  if (e.key === "ArrowDown") all[i + 1]?.focus();
                  if (e.key === "ArrowUp") (all[i - 1] ?? document.querySelector<HTMLElement>(".search input"))?.focus();
                }}
              >
                <span className="item-name">
                  {s.name}
                  {run && <span className={`dot ${run.status}`} title={run.status === "waiting" ? "Waiting for input" : "Running"} />}
                  {sched && <span className="tag" title={`Runs every ${sched.every}`}>{sched.every}</span>}
                  {s.error && <span className="tag bad">error</span>}
                </span>
                {s.description && <span className="item-desc">{s.description}</span>}
              </button>
            );
          })}
        </div>
      ))}
    </nav>
  );
}

function ScriptView({
  api,
  script,
  state,
  runs,
  setRuns,
  onBack,
}: {
  api: Api;
  script: Script;
  state: State;
  runs: Record<string, RunDetail>;
  setRuns: React.Dispatch<React.SetStateAction<Record<string, RunDetail>>>;
  onBack: () => void;
}) {
  const schedule = state.schedules.find((s) => s.script === script.id) ?? null;
  const [values, setValues] = useState<Record<string, unknown>>(() => ({
    ...defaults(script.params),
    ...(schedule?.params ?? {}),
    ...store.get(`values:${script.id}`, {}),
  }));
  const [history, setHistory] = useState<RunSummary[]>([]);
  const [shownRun, setShownRun] = useState<string | null>(null);
  const [tab, setTab] = useState<"output" | "history">("output");
  const [every, setEvery] = useState(schedule?.every ?? script.schedule?.every ?? "10m");
  const [msg, setMsg] = useState<string | null>(null);
  const [editWith, setEditWith] = useState<{ id: string; name: string } | null>(null);

  useEffect(() => store.set(`values:${script.id}`, values), [script.id, values]);

  const loadHistory = useCallback(() => api.runs(script.id).then(setHistory).catch(() => {}), [api, script.id]);
  useEffect(() => {
    loadHistory();
  }, [loadHistory]);

  // A run for this script that the UI knows about, newest first.
  const known = Object.values(runs)
    .filter((r) => r.script === script.id)
    .sort((a, b) => b.startedAt - a.startedAt);
  const live = known.find((r) => r.status === "running" || r.status === "waiting");
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
    if (miss.length) return setMsg(`Fill in: ${miss.join(", ")}`);
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
      setMsg(e.message);
    }
  };

  const toggleSchedule = async (on: boolean) => {
    if (on) {
      const miss = missing(script.params, values);
      if (miss.length) return setMsg(`Fill in before scheduling: ${miss.join(", ")}`);
    }
    try {
      await api.schedule(script.id, every, values, on);
      setMsg(null);
    } catch (e: any) {
      setMsg(e.message);
    }
  };

  const scheduleDirty = schedule?.enabled && (schedule.every !== every || JSON.stringify(schedule.params) !== JSON.stringify(values));
  const hasParams = Object.keys(script.params).length > 0;

  return (
    <div className="view" onKeyDown={(e) => e.key === "Enter" && (e.ctrlKey || e.metaKey) && !live && start()}>
      <header className="view-head">
        <button className="ghost back" onClick={onBack} aria-label="Back to list">
          ‹ Scripts
        </button>
        <h1>{script.name}</h1>
        {script.description && <p className="desc">{script.description}</p>}
        <div className="row wrap small">
          <code className="path">{script.id}</code>
          <button className="link" onClick={() => api.open(script.id)}>
            Open
          </button>
          {state.harnesses.map((h) => (
            <button
              key={h.id}
              className="link"
              onClick={() => setEditWith(h)}
            >
              Edit with {h.name}
            </button>
          ))}
        </div>
      </header>

      {editWith && (
        <EditWithDialog
          harness={editWith}
          onClose={() => setEditWith(null)}
          onSubmit={(what) => {
            setEditWith(null);
            api
              .editWith(script.id, editWith.id, what)
              .then(() => setMsg(`Opened ${editWith.name} in a terminal.`))
              .catch((e) => setMsg(e.message));
          }}
        />
      )}

      {script.error && <pre className="error-box">{script.error}</pre>}

      {hasParams && <ParamForm params={script.params} values={values} onChange={setValues} onSubmit={() => !live && start()} />}

      <div className="actions">
        {live ? (
          <button className="danger" onClick={() => api.stop(live.id)}>
            Stop
          </button>
        ) : (
          <button className="primary" onClick={() => start()} disabled={!!script.error} title="Ctrl+Enter">
            Run
          </button>
        )}
        <label className="check schedule">
          <input type="checkbox" checked={!!schedule?.enabled} onChange={(e) => toggleSchedule(e.target.checked)} disabled={!!script.error} />
          Every
        </label>
        <input className="every" value={every} onChange={(e) => setEvery(e.target.value)} aria-label="Interval" />
        {scheduleDirty && (
          <button className="link" onClick={() => toggleSchedule(true)}>
            Save schedule
          </button>
        )}
        {schedule?.enabled && schedule.nextRun && !scheduleDirty && <span className="muted small">next {fmtWhen(schedule.nextRun)}</span>}
      </div>
      {msg && <div className="msg">{msg}</div>}

      <div className="tabs">
        <button className={tab === "output" ? "on" : ""} onClick={() => setTab("output")}>
          Output
        </button>
        <button className={tab === "history" ? "on" : ""} onClick={() => setTab("history")}>
          History{history.length ? ` (${history.length})` : ""}
        </button>
        {run && tab === "output" && <RunStatusLine run={run} />}
      </div>

      {tab === "output" &&
        (run ? (
          <RunOutput run={run} onAnswer={(id, v) => api.answer(run.id, id, v).catch((e) => setMsg(e.message))} />
        ) : (
          <div className="output muted">No runs yet.</div>
        ))}

      {tab === "history" && (
        <div className="history">
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
                <span className={`dot ${h.status}`} />
                <span>{fmtTime(h.startedAt)}</span>
                <span className="muted">{h.source === "manual" ? "" : h.source === "mcp" ? "agent" : "scheduled"}</span>
                <span className="muted">{h.endedAt ? fmtDur(h.endedAt - h.startedAt) : ""}</span>
                {Object.keys(h.params).length > 0 && <span className="muted params">{fmtParams(h.params)}</span>}
              </button>
              {hasParams && (
                <button
                  className="link"
                  title="Fill the form with this run's values"
                  onClick={() => {
                    setValues({ ...values, ...h.params });
                    setTab("output");
                  }}
                >
                  Use values
                </button>
              )}
              <button className="link" disabled={!!live} onClick={() => start({ ...values, ...h.params })}>
                Run again
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function RunStatusLine({ run }: { run: RunDetail }) {
  const label = { running: "Running", waiting: "Waiting for you", ok: "Done", failed: "Failed", stopped: "Stopped" }[run.status];
  return (
    <span className={`status ${run.status}`}>
      <span className={`dot ${run.status}`} />
      {label}
      {run.status === "failed" && run.exitCode !== null && run.exitCode !== 0 && ` (exit ${run.exitCode})`}
      <span className="muted"> · {fmtTime(run.startedAt)}</span>
    </span>
  );
}

function fmtTime(t: number) {
  const d = new Date(t);
  const today = new Date().toDateString() === d.toDateString();
  return today ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : d.toLocaleString([], { dateStyle: "short", timeStyle: "short" });
}
function fmtWhen(t: number) {
  const s = Math.round((t - Date.now()) / 1000);
  if (s <= 5) return "now";
  if (s < 60) return `in ${s} s`;
  if (s < 3600) return `in ${Math.round(s / 60)} min`;
  return `at ${new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}
function fmtDur(ms: number) {
  return ms < 1000 ? `${ms} ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 60_000)} min`;
}
function fmtParams(p: Record<string, unknown>) {
  return Object.entries(p)
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join("  ");
}
