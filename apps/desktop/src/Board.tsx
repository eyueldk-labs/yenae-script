import type { ReactNode } from "react";
import type { RunDetail, RunSummary, Schedule, State } from "./api";
import { MOD, SOURCE, STATUS, fmtAgo, fmtDur, fmtTime, fmtWhen, isLive } from "./fmt";

export type Open = (script: string, at?: { run?: string; tab?: "output" | "history" | "schedule" }) => void;

/**
 * What the app is doing: runs waiting for an answer, running scripts, schedules with
 * their last result, and recent runs. Shown when no script is picked.
 */
export function Board({ state, runs, onOpen, onBack }: { state: State; runs: Record<string, RunDetail>; onOpen: Open; onBack: () => void }) {
  const name = (id: string) => state.scripts.find((s) => s.id === id)?.name ?? id;
  // Prefer the live copy of a run: it has the newest status and any open question.
  const fresh = <T extends RunSummary>(r: T): T | RunDetail => runs[r.id] ?? r;

  const live = Object.values(runs)
    .filter(isLive)
    .sort((a, b) => a.startedAt - b.startedAt);
  const waiting = live.filter((r) => r.status === "waiting");
  const running = live.filter((r) => r.status === "running");

  const schedules = state.schedules
    .filter((s) => s.enabled && state.scripts.some((x) => x.id === s.script))
    .map((s) => ({ ...s, last: s.last && fresh(s.last) }))
    .sort((a, b) => health(a) - health(b) || name(a.script).localeCompare(name(b.script)));

  const liveIds = new Set(live.map((r) => r.id));
  const recent = state.recent.map(fresh).filter((r) => !liveIds.has(r.id)).slice(0, 10);

  const nothing = !live.length && !schedules.length && !recent.length;

  return (
    <div className="view board">
      <header className="view-head">
        <button className="ghost back" onClick={onBack} aria-label="Back to list">
          ‹ Scripts
        </button>
        <h1>Activity</h1>
      </header>

      {nothing && (
        <p className="muted">
          Nothing has run yet. Pick a script to fill in its form and run it.
        </p>
      )}

      {waiting.length > 0 && (
        <Section title="Waiting for you">
          {waiting.map((r) => (
            <Row key={r.id} onClick={() => onOpen(r.script, { run: r.id })}>
              <span className="dot waiting" aria-hidden />
              <span className="row-name">{name(r.script)}</span>
              <span className="row-detail">{r.pendingAsk?.request.message ?? STATUS.waiting}</span>
              <span className="row-meta">{SOURCE[r.source] || fmtTime(r.startedAt)}</span>
            </Row>
          ))}
        </Section>
      )}

      {running.length > 0 && (
        <Section title="Running">
          {running.map((r) => (
            <Row key={r.id} onClick={() => onOpen(r.script, { run: r.id })}>
              <span className="dot running" aria-hidden />
              <span className="row-name">{name(r.script)}</span>
              <span className="row-detail">since {fmtTime(r.startedAt)}</span>
              <span className="row-meta">{SOURCE[r.source]}</span>
            </Row>
          ))}
        </Section>
      )}

      {schedules.length > 0 && (
        <Section title="Schedules">
          {schedules.map((s) => (
            <Row key={s.script} onClick={() => onOpen(s.script, { tab: "schedule" })}>
              <span className={`dot ${s.last?.status ?? "idle"}`} aria-hidden />
              <span className="row-name">{name(s.script)}</span>
              <span className="row-detail">
                {s.last ? (
                  <span className={s.last.status === "failed" ? "bad-text" : s.last.status === "waiting" ? "warn-text" : ""}>
                    {lastLabel(s.last)}
                  </span>
                ) : (
                  "Not run yet"
                )}
              </span>
              <span className="row-meta">
                every {s.every}
                {s.nextRun && !(s.last && isLive(s.last)) ? `, next ${fmtWhen(s.nextRun)}` : ""}
              </span>
            </Row>
          ))}
        </Section>
      )}

      {recent.length > 0 && (
        <Section title="Recent runs">
          {recent.map((r) => (
            <Row key={r.id} onClick={() => onOpen(r.script, { run: r.id })}>
              <span className={`dot ${r.status}`} aria-hidden />
              <span className="row-name">{name(r.script)}</span>
              <span className={`row-detail ${r.status === "failed" ? "bad-text" : ""}`}>
                {STATUS[r.status]}
                {r.endedAt ? ` in ${fmtDur(r.endedAt - r.startedAt)}` : ""}
              </span>
              <span className="row-meta">
                {[SOURCE[r.source], fmtAgo(r.startedAt)].filter(Boolean).join(", ")}
              </span>
            </Row>
          ))}
        </Section>
      )}

      <p className="keys muted small">
        {[
          [`${MOD}+K`, "search"],
          ["Enter", "open"],
          [`${MOD}+Enter`, "run"],
          ["Esc", "back"],
        ].map(([k, what]) => (
          <span key={k}>
            <kbd>{k}</kbd> {what}
          </span>
        ))}
      </p>
    </div>
  );
}

/** Failing first, then waiting, then the rest. */
function health(s: Schedule) {
  const st = s.last?.status;
  return st === "failed" ? 0 : st === "waiting" ? 1 : 2;
}

export function lastLabel(r: RunSummary) {
  if (r.status === "waiting") return "Waiting for you";
  if (r.status === "running") return "Running now";
  return `${STATUS[r.status]} ${fmtAgo(r.endedAt ?? r.startedAt)}`;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="section">
      <h2>{title}</h2>
      <ul className="rows">{children}</ul>
    </section>
  );
}

function Row({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <li>
      <button className="board-row" onClick={onClick}>
        {children}
      </button>
    </li>
  );
}
