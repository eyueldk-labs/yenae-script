import { useState } from "react";
import { isTauri, type Api, type RunSummary, type Schedule, type Script } from "./api";
import { ParamForm, fmtValue, labelOf, missing } from "./Form";
import { STATUS, fmtAgo, fmtEvery, fmtWhen, isLive } from "./fmt";

/**
 * A schedule is saved with its own values, separate from the form, so a one-off run
 * never changes what the schedule does. This tab shows those values, lets you edit
 * them in place, and shows the last result.
 */
export function SchedulePanel({
  api,
  script,
  schedule,
  last,
  values,
  onShowRun,
  onMissing,
  atStartup,
}: {
  api: Api;
  script: Script;
  schedule: Schedule | null;
  /** The schedule's last run, live copy when there is one. */
  last: RunSummary | null;
  /** The Run tab's form values, used when the schedule starts. */
  values: Record<string, unknown>;
  onShowRun: (id: string) => void;
  onMissing: (keys: string[]) => void;
  /** Runs once each time the computer starts. */
  atStartup: boolean;
}) {
  const on = !!schedule?.enabled;
  const [every, setEvery] = useState(schedule?.every ?? script.schedule?.every ?? "1h");
  const [editing, setEditing] = useState<Record<string, unknown> | null>(null);
  const [invalid, setInvalid] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const params = Object.entries(script.params);
  const keys = params.map(([k]) => k);
  const pick = (v: Record<string, unknown>) => JSON.stringify(keys.map((k) => v[k] ?? null));
  // Offer the Run tab's values only when they are different and complete.
  const formDiffers = on && !editing && params.length > 0 && pick(schedule!.params) !== pick(values) && missing(script.params, values).length === 0;
  const everyChanged = on && every.trim() !== schedule!.every;

  const save = async (enabled: boolean, useValues: Record<string, unknown>, interval = every.trim()) => {
    if (enabled) {
      const miss = missing(script.params, useValues);
      if (miss.length) {
        if (editing) setInvalid(miss);
        else onMissing(miss);
        return setErr(`Fill in ${miss.map((k) => labelOf(k, script.params[k]!)).join(", ")}${editing ? "." : " on the Run tab first."}`);
      }
    }
    setBusy(true);
    try {
      await api.schedule(script.id, interval, useValues, enabled);
      setErr(null);
      setEditing(null);
      setInvalid([]);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  const shownValues = on ? schedule!.params : values;
  // Required values the Run tab is still missing: a schedule can't start without them.
  const needs = on ? [] : missing(script.params, values);
  const needsForStartup = missing(script.params, values);

  // Intervals in words; anything else stays possible under "Other…".
  const presets: [string, string][] = [
    ["5m", "5 minutes"], ["10m", "10 minutes"], ["15m", "15 minutes"], ["30m", "30 minutes"], ["1h", "hour"], ["6h", "6 hours"], ["1d", "day"],
  ];
  const isPreset = presets.some(([v]) => v === every.trim());
  const [custom, setCustom] = useState(!isPreset);
  const pickEvery = (v: string) => {
    if (v === "custom") return setCustom(true);
    setCustom(false);
    setEvery(v);
    // Already on: a new interval applies at once, no extra Save.
    if (on) save(true, schedule!.params, v);
  };

  const valueList = (
    <dl className="values">
      {params.map(([k, spec]) => (
        <div key={k}>
          <dt>{labelOf(k, spec)}</dt>
          <dd title={typeof shownValues[k] === "string" ? String(shownValues[k]) : undefined}>{fmtValue(spec, shownValues[k])}</dd>
        </div>
      ))}
    </dl>
  );

  return (
    <div className="sched" role="tabpanel" id="panel-schedule" aria-labelledby="tab-schedule">
      <div className="sched-head">
        <div className="grow">
          <div className="sched-title">{on ? `On, every ${fmtEvery(schedule!.every)}` : "Run this script automatically"}</div>
          <div className="muted small">
            {on
              ? last && isLive(last)
                ? "Running now"
                : schedule!.nextRun
                  ? `Next run ${fmtWhen(schedule!.nextRun)}`
                  : ""
              : "While Yenae Script is open or in the tray"}
          </div>
        </div>
        {on ? (
          <button disabled={busy} onClick={() => save(false, schedule!.params, schedule!.every)}>
            Turn off
          </button>
        ) : (
          <button className="primary" disabled={busy || !!script.error || !every.trim() || needs.length > 0} onClick={() => save(true, values)}>
            Turn on
          </button>
        )}
      </div>

      <div className="field">
        <label htmlFor="sched-every">How often</label>
        <div className="row">
          <select id="sched-every" value={custom ? "custom" : every.trim()} onChange={(e) => pickEvery(e.target.value)}>
            {presets.map(([v, label]) => (
              <option key={v} value={v}>
                Every {label}
              </option>
            ))}
            <option value="custom">Other…</option>
          </select>
          {custom && (
            <form
              className="row"
              onSubmit={(e) => {
                e.preventDefault();
                if (on) save(true, schedule!.params);
              }}
            >
              <input className="every" aria-label="Every" value={every} onChange={(e) => setEvery(e.target.value)} placeholder="e.g. 2h" />
              {on && everyChanged && (
                <button type="submit" disabled={busy || !every.trim()}>
                  Save
                </button>
              )}
            </form>
          )}
        </div>
        {custom && <div className="hint">A number and s, m, h or d: 30s, 10m, 2h, 1d.</div>}
        {!on && (
          <div className={`hint ${needs.length ? "bad" : ""}`}>
            {needs.length
              ? `Fill in ${needs.map((k) => labelOf(k, script.params[k]!)).join(", ")} on the Run tab first.`
              : "Turning it on runs it once now."}
          </div>
        )}
      </div>

      {script.asks && (
        <p className="note warn" role="note">
          This script asks questions, so an automatic run waits until you answer. Runs are skipped while it waits.
        </p>
      )}

      {on && last && (
        <div className="row wrap small">
          <span className="muted">Last run:</span>
          <span className={`dot ${last.status}`} aria-hidden />
          <span className={last.status === "failed" ? "bad-text" : last.status === "waiting" ? "warn-text" : ""}>
            {isLive(last) ? STATUS[last.status] : `${STATUS[last.status]} ${fmtAgo(last.endedAt ?? last.startedAt)}`}
          </span>
          <button className="link" onClick={() => onShowRun(last.id)}>
            See what happened
          </button>
        </div>
      )}

      {params.length > 0 && (
        <section className="sched-values">
          <div className="row">
            <h3>Runs with these values</h3>
            {on && !editing && (
              <button className="link" onClick={() => setEditing({ ...schedule!.params })}>
                Edit
              </button>
            )}
            {!on && <span className="muted small">(from the Run tab)</span>}
          </div>
          {editing ? (
            <>
              <ParamForm
                params={script.params}
                values={editing}
                invalid={invalid}
                idPrefix="sv"
                onChange={setEditing}
                onSubmit={() => save(true, editing, schedule!.every)}
              />
              <div className="row">
                <button className="primary" disabled={busy} onClick={() => save(true, editing, schedule!.every)}>
                  Save
                </button>
                <button
                  className="ghost"
                  onClick={() => {
                    setEditing(null);
                    setInvalid([]);
                    setErr(null);
                  }}
                >
                  Cancel
                </button>
              </div>
            </>
          ) : (
            valueList
          )}
          {formDiffers && (
            <div className="row wrap">
              <span className="muted small">The Run tab has different values.</span>
              <button className="link" disabled={busy} onClick={() => save(true, values, schedule!.every)}>
                Use those instead
              </button>
            </div>
          )}
        </section>
      )}

      <label className="check startup-check">
        <input
          type="checkbox"
          checked={atStartup}
          disabled={busy || (!atStartup && (!!script.error || needsForStartup.length > 0))}
          onChange={async (e) => {
            const turnOn = e.target.checked;
            setBusy(true);
            try {
              await api.setStartup(script.id, turnOn, values);
              // It only runs if the app opens at sign-in, so make sure it does.
              if (turnOn && isTauri()) {
                const a = await import("@tauri-apps/plugin-autostart");
                if (!(await a.isEnabled())) await a.enable();
              }
              setErr(null);
            } catch (err: any) {
              setErr(err.message);
            } finally {
              setBusy(false);
            }
          }}
        />
        <span>
          Run when my computer starts
          <span className="muted small block">{needsForStartup.length && !atStartup ? `Fill in ${needsForStartup.map((k) => labelOf(k, script.params[k]!)).join(", ")} on the Run tab first.` : "Once each time you sign in, with the Run tab's values."}</span>
        </span>
      </label>

      {err && (
        <div className="msg bad" role="alert">
          {err}
        </div>
      )}
    </div>
  );
}
