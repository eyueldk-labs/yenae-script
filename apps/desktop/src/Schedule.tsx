import { useState } from "react";
import type { Api, RunSummary, Schedule, Script } from "./api";
import { ParamForm, fmtValue, labelOf, missing } from "./Form";
import { STATUS, fmtAgo, fmtWhen, isLive } from "./fmt";

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
}) {
  const on = !!schedule?.enabled;
  const [every, setEvery] = useState(schedule?.every ?? script.schedule?.every ?? "10m");
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

  return (
    <div className="sched" role="tabpanel" id="panel-schedule" aria-labelledby="tab-schedule">
      <p className="muted small">
        {on ? "Runs while Yenae Script is open or in the tray." : "Run this script on a timer while Yenae Script is open or in the tray."}
      </p>

      {script.asks && (
        <p className="note warn" role="note">
          This script asks questions. A scheduled run waits until you answer, and later runs are skipped until then.
        </p>
      )}

      {on && (
        <dl className="facts">
          <dt>Next</dt>
          <dd>{last && isLive(last) ? "After the current run" : schedule!.nextRun ? fmtWhen(schedule!.nextRun) : "–"}</dd>
          <dt>Last</dt>
          <dd>
            {last ? (
              <span className="row wrap">
                <span className={`dot ${last.status}`} aria-hidden />
                <span className={last.status === "failed" ? "bad-text" : last.status === "waiting" ? "warn-text" : ""}>
                  {isLive(last) ? STATUS[last.status] : `${STATUS[last.status]} ${fmtAgo(last.endedAt ?? last.startedAt)}`}
                </span>
                <button className="link" onClick={() => onShowRun(last.id)}>
                  Show run
                </button>
              </span>
            ) : (
              "Not run yet"
            )}
          </dd>
        </dl>
      )}

      {params.length > 0 && (
        <section className="sched-values">
          <div className="row">
            <h3>{on ? "Runs with" : "Will run with the Run tab's values"}</h3>
            {on && !editing && (
              <button className="link" onClick={() => setEditing({ ...schedule!.params })}>
                Edit
              </button>
            )}
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
                  Save values
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
            <dl className="values">
              {params.map(([k, spec]) => (
                <div key={k}>
                  <dt>{labelOf(k, spec)}</dt>
                  <dd className={spec.kind === "file" || spec.kind === "folder" ? "mono" : ""}>{fmtValue(spec, shownValues[k])}</dd>
                </div>
              ))}
            </dl>
          )}
          {formDiffers && (
            <div className="row wrap">
              <span className="muted small">The Run tab has different values.</span>
              <button className="link" disabled={busy} onClick={() => save(true, values, schedule!.every)}>
                Use those
              </button>
            </div>
          )}
        </section>
      )}

      <form
        className="sched-form"
        onSubmit={(e) => {
          e.preventDefault();
          save(true, on ? schedule!.params : values);
        }}
      >
        <div className="field">
          <label htmlFor="sched-every">Every</label>
          <div className="row">
            <input id="sched-every" className="every" list="sched-presets" value={every} onChange={(e) => setEvery(e.target.value)} aria-describedby="sched-every-hint" />
            <datalist id="sched-presets">
              {["1m", "5m", "10m", "30m", "1h", "6h", "1d"].map((p) => (
                <option key={p} value={p} />
              ))}
            </datalist>
            {on && everyChanged && (
              <button type="submit" disabled={busy || !every.trim()}>
                Save
              </button>
            )}
          </div>
          <div className="hint" id="sched-every-hint">
            For example 30s, 10m, 2h or 1d.{!on && " Starting it runs the script once now."}
          </div>
        </div>
        {err && (
          <div className="msg bad" role="alert">
            {err}
          </div>
        )}
        <div className="row">
          {on ? (
            <button type="button" disabled={busy} onClick={() => save(false, schedule!.params, schedule!.every)}>
              Turn off
            </button>
          ) : (
            <button type="submit" className="primary" disabled={busy || !!script.error || !every.trim()}>
              Start schedule
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
