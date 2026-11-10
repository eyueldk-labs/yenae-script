import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Ellipsis, Star, X } from "lucide-react";
import type { Api, Layout, LayoutItem, RunDetail, RunSummary, Script, State } from "./api";
import { folderOf, folderWith, moveToFolder } from "./layoutOps";
import { ParamForm, defaults, fieldId, fmtValue, labelOf, missing, startValues } from "./Form";
import { RunOutput, friendlyError, plainError } from "./Output";
import { EditWithDialog, modalOpen, preferredHarness } from "./Dialogs";
import { SchedulePanel } from "./Schedule";
import { Menu, type MenuEntry } from "./Menu";
import { Glyph, hueOf } from "./icons";
import { MOD, SOURCE, STATUS, fmtAgo, fmtDur, fmtParams, isLive, lastLabel } from "./fmt";
import { store } from "./store";

export type Tab = "run" | "history" | "schedule";
export type Opening = { run?: string; tab?: Tab; focus?: boolean; key: number };
type Msg = { text: string; tone: "bad" | "note"; undo?: () => void };

/**
 * One script beside the catalog: its form and Run, the run it is showing, its
 * history and its schedule. While a run is live the form folds into one line, so
 * the output and any question lead.
 */
export function Panel({
  api,
  script,
  state,
  runs,
  setRuns,
  opening,
  favourite,
  layout,
  onLayout,
  wide,
  onFavourite,
  onWide,
  onClose,
}: {
  api: Api;
  script: Script;
  state: State;
  runs: Record<string, RunDetail>;
  setRuns: React.Dispatch<React.SetStateAction<Record<string, RunDetail>>>;
  opening: Opening;
  favourite: boolean;
  layout: Layout;
  onLayout: (l: Layout) => void;
  wide: boolean;
  onFavourite: () => void;
  onWide: () => void;
  onClose: () => void;
}) {
  const schedule = state.schedules.find((s) => s.script === script.id) ?? null;
  // The form starts from whichever is newer: what you last typed, or the values of the last run
  // (which may have been a scheduled or agent run). Either way you rarely retype.
  const [initial] = useState(() => startValues(script, state.lastRuns[script.id]));
  const [values, setValuesRaw] = useState<Record<string, unknown>>(initial.values);
  const [prefilled, setPrefilled] = useState(initial.fromRun && Object.keys(script.params).length > 0);
  const setValues = (v: Record<string, unknown>) => {
    setValuesRaw(v);
    setPrefilled(false);
    store.set(`valuesAt:${script.id}`, Date.now());
  };
  const [invalid, setInvalid] = useState<string[]>([]);
  const [history, setHistory] = useState<RunSummary[]>([]);
  // The run shown under the form: one started or opened here. Older runs are in History.
  // A failed last run is shown straight away, in the same place as any other result.
  const [shownRun, setShownRun] = useState<string | null>(() => {
    const l = state.lastRuns[script.id];
    return opening.run ?? (l?.status === "failed" ? l.id : null);
  });
  const [tab, setTab] = useState<Tab>(opening.tab ?? "run");
  const [msg, setMsg] = useState<Msg | null>(null);
  const [editWith, setEditWith] = useState<{ title: string; text: string } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const root = useRef<HTMLElement>(null);
  const runButton = useRef<HTMLButtonElement>(null);

  useEffect(() => store.set(`values:${script.id}`, values), [script.id, values]);

  useEffect(() => {
    if (opening.run) setShownRun(opening.run);
    if (opening.tab || opening.run) setTab(opening.tab ?? "run");
    if (!opening.focus) return;
    requestAnimationFrame(() => {
      const first = root.current?.querySelector<HTMLElement>(".run-form input, .run-form select, .run-form textarea");
      (first ?? runButton.current)?.focus();
    });
  }, [opening.key]);

  const loadHistory = useCallback(() => api.runs(script.id).then(setHistory).catch(() => {}), [api, script.id]);
  useEffect(() => {
    loadHistory();
  }, [loadHistory]);

  const live = Object.values(runs)
    .filter((r) => r.script === script.id && isLive(r))
    .sort((a, b) => b.startedAt - a.startedAt)[0];
  const runId = live?.id ?? shownRun;
  const run = runId ? runs[runId] : null;
  const last = state.lastRuns[script.id] ? (runs[state.lastRuns[script.id]!.id] ?? state.lastRuns[script.id]!) : null;

  // When a run ends: refresh history and, if focus fell off the page, put it on Run.
  const liveId = live?.id;
  const wasLive = useRef(liveId);
  useEffect(() => {
    if (!liveId) {
      loadHistory();
      if (wasLive.current) {
        setShownRun(wasLive.current);
        requestAnimationFrame(() => {
          if (!document.activeElement || document.activeElement === document.body) runButton.current?.focus();
        });
      }
    }
    wasLive.current = liveId;
  }, [liveId, loadHistory]);

  // Load a finished run's output when it's shown but not in memory.
  useEffect(() => {
    if (runId && (!runs[runId] || (runs[runId]!.events.length === 0 && !isLive(runs[runId]!)))) {
      api
        .getRun(runId)
        .then((r) => setRuns((p) => (p[r.id] && p[r.id]!.events.length > r.events.length ? p : { ...p, [r.id]: r })))
        .catch(() => {});
    }
  }, [runId]);

  const start = async (params = values) => {
    const miss = missing(script.params, params);
    if (miss.length) {
      setTab("run");
      setInvalid(miss);
      setMsg({ text: `Fill in ${miss.map((k) => labelOf(k, script.params[k]!)).join(", ")}.`, tone: "bad" });
      requestAnimationFrame(() => document.getElementById(fieldId(miss[0]!))?.focus());
      return;
    }
    setInvalid([]);
    setMsg(null);
    try {
      const { id } = await api.run(script.id, params);
      // The engine's "run" message usually arrives first; if not, a placeholder holds the
      // spot and the first message fills it in (keeping any output already streamed).
      setRuns((p) => ({
        ...p,
        [id]: p[id] ?? { id, script: script.id, params, source: "manual", status: "running", exitCode: null, error: null, startedAt: Date.now(), endedAt: null, events: [] },
      }));
      setShownRun(id);
      setTab("run");
      // The form is replaced by the live bar: keep focus on something real (Stop).
      requestAnimationFrame(() => root.current?.querySelector<HTMLElement>(".live-bar .stop")?.focus());
    } catch (e: any) {
      setMsg({ text: e.message, tone: "bad" });
    }
  };

  // Ctrl/Cmd+Enter runs from anywhere in the window.
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
  }, [script.error]);

  const params = Object.entries(script.params);
  const agent = preferredHarness(state.harnesses);
  const scheduleOn = !!schedule?.enabled;
  const schedLast = schedule?.last ? (runs[schedule.last.id] ?? schedule.last) : null;
  const errLine = (r: RunSummary | RunDetail) =>
    ("events" in r ? r.events.filter((e) => e.t === "err").map((e) => (e as { text: string }).text).join("") : "")
      .trim()
      .split("\n")
      .find((l) => l.trim() && !/^\s+at\s/.test(l)) ?? r.error ?? "";

  const fixFailure = (r: RunDetail) => {
    const err = r.events
      .filter((e) => e.t === "err")
      .map((e) => (e as { text: string }).text)
      .join("")
      .trim()
      .split("\n")
      .slice(-12)
      .join("\n");
    setEditWith({ title: "Fix this script", text: `This run failed${r.exitCode ? ` with exit code ${r.exitCode}` : ""}.\n${err || r.error || ""}\n\nFind the cause and fix it.` });
  };

  const home = folderOf(layout, script.id);
  const menuItems: MenuEntry[] = [
    ...(agent ? [{ label: "Change what it does…", onSelect: () => setEditWith({ title: "Change this script", text: "" }) }] : []),
    { heading: "Move to folder" },
    ...layout.items
      .filter((i): i is Extract<LayoutItem, { type: "folder" }> => i.type === "folder" && i.id !== home?.id)
      .map((f) => ({ label: f.name, onSelect: () => onLayout(moveToFolder(layout, script.id, f.id)) })),
    ...(home ? [{ label: `Move out of ${home.name}`, onSelect: () => onLayout(moveToFolder(layout, script.id, null)) }] : []),
    { label: "New folder…", onSelect: () => onLayout(folderWith(layout, script.id).layout) },
    "separator",
    { heading: "For developers" },
    { label: "Open file", onSelect: () => api.open(script.id).catch((e) => setMsg({ text: e.message, tone: "bad" })) },
  ];

  const shownIsOld = !!run && !isLive(run) && params.length > 0 && JSON.stringify(run.params) !== JSON.stringify(Object.fromEntries(params.map(([k]) => [k, values[k]])));

  // Opened from "See why": the failure comes first, above the form.
  const failFirst = !!run && !live && run.status === "failed";
  const output = run && (
              <section className={`run-output ${failFirst ? "result-box failed" : ""}`} aria-label="Result">
                {!live && (
                  <div className="run-head small">
                    <span className={`dot ${run.status}`} aria-hidden />
                    <span className={run.status === "failed" ? "bad-text" : ""}>{STATUS[run.status]}</span>
                    <span className="muted">
                      · {fmtAgo(run.endedAt ?? run.startedAt)}
                      {SOURCE[run.source] ? ` · ${SOURCE[run.source]}` : ""}
                    </span>
                    <span className="grow" />
                    <button className="link" onClick={() => setShownRun(null)}>
                      Hide
                    </button>
                  </div>
                )}
                {!live && run.status !== "failed" && Object.keys(run.params).length > 0 && <div className="run-with muted small">With {fmtParams(run.params, script.params)}</div>}
                <RunOutput
                  key={run.id}
                  run={run}
                  onAnswer={(id, v) => api.answer(run.id, id, v).catch((e) => setMsg({ text: e.message, tone: "bad" }))}
                  tech={run.status === "failed" && Object.keys(run.params).length ? [`With ${fmtParams(run.params, script.params)}`] : []}
                  footer={
                    (run.status === "failed" || shownIsOld) && (
                      <div className="row wrap after-run">
                        {shownIsOld && (
                          <button
                            onClick={() => {
                              const before = values;
                              setValues({ ...values, ...run.params });
                              setMsg({ text: "Filled the form with this run's values.", tone: "note", undo: () => setValues(before) });
                            }}
                          >
                            Use these values
                          </button>
                        )}
                        {run.status === "failed" && agent && (
                          <button onClick={() => fixFailure(run)} title={`Asks ${agent.name} to find and fix the problem, in a new window`}>
                            Help me fix this
                          </button>
                        )}
                      </div>
                    )
                  }
                />
              </section>
  );

  return (
    // The panel carries the script's colour on its icon tile.
    <aside ref={root} className={`panel hue-${hueOf(script.id)} ${wide ? "wide" : ""}`} aria-label={script.name}>
      <header className="panel-head">
        <button className="ib back-btn" onClick={onClose} aria-label="Back to scripts">
          <ChevronLeft size={18} />
          Scripts
        </button>
        <div className="panel-title">
          <span className="panel-glyph">
            <Glyph script={script} size={22} />
          </span>
          <h2 className="grow">{script.name}</h2>
          <button className={`ib ${favourite ? "fav" : ""}`} aria-pressed={favourite} title={favourite ? "Remove from favourites" : "Add to favourites"} onClick={onFavourite}>
            <Star size={17} fill={favourite ? "currentColor" : "none"} />
          </button>
          <button
            className="ib"
            title="More"
            aria-label="More"
            aria-haspopup="menu"
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              setMenu({ x: r.right - 200, y: r.bottom + 4 });
            }}
          >
            <Ellipsis size={18} />
          </button>
          <button className="ib close-btn" title="Close (Esc)" aria-label="Close" onClick={onClose}>
            <X size={17} />
          </button>
        </div>
        {script.description && <p className="desc">{script.description}</p>}
        {menu && <Menu x={menu.x} y={menu.y} label="Script" items={menuItems} onClose={() => setMenu(null)} />}
      </header>

      <div className="tabs" role="tablist" aria-label="Script">
        {(
          [
            ["run", "Run", ""],
            ["history", "History", history.length ? String(history.length) : ""],
            ["schedule", "Schedule", ""],
          ] as const
        ).map(([id, label, extra]) => (
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
              const order: Tab[] = ["run", "history", "schedule"];
              const d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
              if (!d) return;
              const next = order[(order.indexOf(id) + d + 3) % 3]!;
              setTab(next);
              document.getElementById(`tab-${next}`)?.focus();
            }}
          >
            {label}
            {extra && <span className="count">{extra}</span>}
            {id === "schedule" && scheduleOn && <span className="count on">On</span>}
          </button>
        ))}
      </div>

      <div className="panel-body">
        {tab === "run" && (
          <div role="tabpanel" id="panel-run" aria-labelledby="tab-run" className="run-tab">
            {failFirst && output}
            {script.error && (
              <div className="result-box failed">
                <b className="result-title bad-text">This script can't be opened. It has a mistake in it.</b>
                <details className="tech">
                  <summary>Technical details</summary>
                  <pre className="log">{script.error}</pre>
                </details>
                {agent && (
                  <div className="row wrap after-run">
                    <button onClick={() => setEditWith({ title: "Fix this script", text: `This script doesn't load:\n${script.error}\n\nFind the cause and fix it.` })} title={`Asks ${agent.name} to fix it, in a new window`}>
                      Help me fix this
                    </button>
                  </div>
                )}
              </div>
            )}

            {live ? (
              <div className="live-bar">
                <span className={`dot ${live.status}`} aria-hidden />
                <div className="grow">
                  <div className="live-status" role="status">
                    {STATUS[live.status]}
                    <span className="muted small"> · started {fmtAgo(live.startedAt)}{SOURCE[live.source] ? ` · ${SOURCE[live.source]}` : ""}</span>
                  </div>
                  {params.length > 0 && (
                    <div className="muted small clip">{params.map(([k, spec]) => `${labelOf(k, spec)} ${fmtValue(spec, live.params[k])}`).join(" · ")}</div>
                  )}
                </div>
                <button className="stop" onClick={() => api.stop(live.id).catch((e) => setMsg({ text: e.message, tone: "bad" }))}>
                  Stop
                </button>
              </div>
            ) : (
              <>
                {prefilled && (
                  <p className="muted small prefill">
                    Filled in from the last run.{" "}
                    <button className="link" onClick={() => setValues(defaults(script.params))}>
                      Clear
                    </button>
                  </p>
                )}
                {params.length > 0 ? (
                  <div className="run-form">
                    <ParamForm
                      params={script.params}
                      values={values}
                      invalid={invalid}
                      onChange={(v) => {
                        setValues(v);
                        if (invalid.length) setInvalid(missing(script.params, v).filter((k) => invalid.includes(k)));
                      }}
                      onSubmit={() => start()}
                    />
                  </div>
                ) : (
                  !script.error && <p className="muted small">Nothing to fill in.</p>
                )}
                <div className="actions">
                  <button ref={runButton} className="primary run-btn" onClick={() => start()} disabled={!!script.error} aria-keyshortcuts="Control+Enter" title={`Run (${MOD}+Enter)`}>
                    Run now
                  </button>
                  {!run && <span className="muted small">{last ? `Last run: ${lastLabel(last).toLowerCase()}` : "Not run yet"}</span>}
                </div>
              </>
            )}

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

            {run && !failFirst && output}
          </div>
        )}

        {tab === "history" && (
          <div role="tabpanel" id="panel-history" aria-labelledby="tab-history">
            {history.length === 0 && <p className="muted small">No runs yet.</p>}
            {groupByDay(history.map((h) => runs[h.id] ?? h)).map(([day, rows]) => (
              <section key={day} className="hist-day">
                <h3>{day}</h3>
                <ul className="hist">
                  {collapseRepeats(rows).map(({ run: h, count, since }, i, all) => {
                    const err = h.status === "failed" && h.error ? (friendlyError(h.error) ?? plainError(h.error)) : "";
                    // Values only where they change from the row above.
                    const vals = fmtParams(h.params, script.params);
                    const prevVals = i > 0 ? fmtParams(all[i - 1]!.run.params, script.params) : null;
                    return (
                      <li key={h.id}>
                        <button
                          className={`hist-row ${h.id === runId ? "on" : ""}`}
                          onClick={() => {
                            setShownRun(h.id);
                            setTab("run");
                          }}
                        >
                          <span className={`dot ${h.status}`} aria-hidden />
                          <span className="hist-main">
                            <span className="hist-line">
                              <span className="hist-status">
                                {STATUS[h.status]}
                                {count > 1 && ` ${count} times`}
                              </span>
                              <span className="hist-meta">
                                {count > 1 && since ? `${clock(since)} – ` : ""}
                                {clock(h.startedAt)}
                                {/* Only durations people care about: a minute or more. */}
                                {count === 1 && h.endedAt && h.endedAt - h.startedAt >= 60_000 ? ` · took ${fmtDur(h.endedAt - h.startedAt)}` : ""}
                                {SOURCE[h.source] ? ` · ${SOURCE[h.source]}` : ""}
                              </span>
                            </span>
                            {(err || (vals && vals !== prevVals)) && <span className="hist-params">{err || vals}</span>}
                          </span>
                          <ChevronRight size={16} className="hist-chev" aria-hidden />
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
          </div>
        )}

        {tab === "schedule" && (
          <SchedulePanel
            key={`${schedule?.enabled}:${schedule?.every}:${JSON.stringify(schedule?.params)}`}
            api={api}
            script={script}
            schedule={schedule}
            last={schedLast}
            values={values}
            onMissing={(keys) => {
              setTab("run");
              setInvalid(keys);
              requestAnimationFrame(() => document.getElementById(fieldId(keys[0]!))?.focus());
            }}
            onShowRun={(id) => {
              setShownRun(id);
              setTab("run");
            }}
          />
        )}
      </div>

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
              .then(() => setMsg({ text: "Opened a new window to make the change.", tone: "note" }))
              .catch((e) => setMsg({ text: e.message, tone: "bad" }));
          }}
        />
      )}
    </aside>
  );
}

/** Runs grouped under "Today", "Yesterday" or the date, newest first. */
function groupByDay<T extends { startedAt: number }>(list: T[]): [string, T[]][] {
  const out: [string, T[]][] = [];
  const today = new Date().setHours(0, 0, 0, 0);
  for (const r of list) {
    const d = new Date(r.startedAt).setHours(0, 0, 0, 0);
    const label = d === today ? "Today" : d === today - 86_400_000 ? "Yesterday" : new Date(r.startedAt).toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" });
    const last = out[out.length - 1];
    if (last && last[0] === label) last[1].push(r);
    else out.push([label, [r]]);
  }
  return out;
}

const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

/** Back-to-back runs that ended the same way, from the same place with the same values, become one row: "Failed 7 times". */
function collapseRepeats<T extends RunSummary>(rows: T[]): { run: T; count: number; since: number | null }[] {
  const out: { run: T; count: number; since: number | null }[] = [];
  for (const r of rows) {
    const prev = out[out.length - 1];
    const same = prev && r.source === prev.run.source && r.status === prev.run.status && JSON.stringify(r.params) === JSON.stringify(prev.run.params);
    if (same && !isLive(r) && !isLive(prev.run)) {
      prev.count++;
      prev.since = r.startedAt;
    } else out.push({ run: r, count: 1, since: null });
  }
  return out;
}
