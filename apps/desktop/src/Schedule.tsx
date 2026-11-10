import { useState } from "react";
import type { Api, RunSummary, Schedule, Script } from "./api";
import { fmtValue, labelOf, missing } from "./Form";
import { STATUS, fmtAgo, fmtWhen, isLive } from "./fmt";

/**
 * A schedule is saved with its own values, separate from the form, so a one-off run
 * never changes what the schedule does. This panel shows those values and the last result.
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
  values: Record<string, unknown>;
  onShowRun: (id: string) => void;
  onMissing: (keys: string[]) => void;
}) {
  const on = !!schedule?.enabled;
  const [every, setEvery] = useState(schedule?.every ?? script.schedule?.every ?? "10m");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const params = Object.entries(script.params);
  const keys = params.map(([k]) => k);
  const pick = (v: Record<string, unknown>) => JSON.stringify(keys.map((k) => v[k] ?? null));
  const formDiffers = on && params.length > 0 && pick(schedule!.params) !== pick(values);
  const everyChanged = on && every.trim() !== schedule!.every;

  const save = async (enabled: boolean, useValues: Record<string, unknown>, interval = every.trim()) => {
    if (enabled) {
      const miss = missing(script.params, useValues);
      if (miss.length) {
        onMissing(miss);
        return setErr(`Fill in ${miss.map((k) => labelOf(k, script.params[k]!)).join(", ")} in the form first.`);
      }
    }
    setBusy(true);
    try {
      await api.schedule(script.id, interval, useValues, enabled);
      setErr(null);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  const shownValues = on ? schedule!.params : values;

  return (
    <div className="sched" role="tabpanel" id="panel-schedule" aria-labelledby="tab-schedule">
      <p className="muted">
        {on ? "Runs while Yenae Script is open or in the tray." : "Run this script on a timer while Yenae Script is open or in the tray."}
      </p>

      {script.asks && (
        <p className="note warn" role="note">
          This script asks questions. A scheduled run waits until you answer, and later runs are skipped until then.
        </p>
      )}

      <dl className="facts">
        {on && (
          <>
            <dt>Next</dt>
            <dd>{last && isLive(last) ? "After the current run" : schedule!.nextRun ? fmtWhen(schedule!.nextRun) : "–"}</dd>
            <dt>Last</dt>
            <dd>
              {last ? (
                <span className="row">
                  <span className={`dot ${last.status}`} aria-hidden />
                  <span className={last.status === "failed" ? "bad-text" : last.status === "waiting" ? "warn-text" : ""}>
                    {isLive(last) ? STATUS[last.status] : `${STATUS[last.status]} ${fmtAgo(last.endedAt ?? last.startedAt)}`}
                  </span>
                  <button className="link" onClick={() => onShowRun(last.id)}>
                    Show
                  </button>
                </span>
              ) : (
                "Not run yet"
              )}
            </dd>
          </>
        )}
        {params.length > 0 && (
          <>
            <dt>{on ? "Values" : "Uses"}</dt>
            <dd>
              {!on && <span className="muted">The form's current values</span>}
              <dl className="values">
                {params.map(([k, spec]) => (
                  <div key={k}>
                    <dt>{labelOf(k, spec)}</dt>
                    <dd className={spec.kind === "file" || spec.kind === "folder" ? "mono" : ""}>{fmtValue(spec, shownValues[k])}</dd>
                  </div>
                ))}
              </dl>
              {formDiffers && (
                <div className="row wrap">
                  <span className="muted small">The form has different values.</span>
                  <button className="link" disabled={busy} onClick={() => save(true, values, schedule!.every)}>
                    Use form values
                  </button>
                </div>
              )}
            </dd>
          </>
        )}
      </dl>

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
            <input
              id="sched-every"
              className="every"
              list="sched-presets"
              value={every}
              onChange={(e) => setEvery(e.target.value)}
              aria-describedby="sched-every-hint"
            />
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
