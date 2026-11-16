import { useState } from "react";
import type { Api, Preset } from "./api";

/**
 * Saved sets of values for a script ("Work laptop", "Big files"): pick one to fill the form,
 * save what's in the form as one, or remove one.
 */
export function PresetBar({
  api,
  script,
  presets,
  values,
  onPick,
}: {
  api: Api;
  script: string;
  presets: Preset[];
  values: Record<string, unknown>;
  onPick: (values: Record<string, unknown>) => void;
}) {
  const same = (p: Preset) => JSON.stringify(Object.keys(values).sort().map((k) => [k, p.values[k] ?? null])) === JSON.stringify(Object.keys(values).sort().map((k) => [k, values[k] ?? null]));
  const current = presets.find(same);
  const [naming, setNaming] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const save = async (list: Preset[]) => {
    try {
      await api.savePresets(script, list);
      setErr(null);
    } catch (e: any) {
      setErr(e.message);
    }
  };

  if (naming !== null)
    return (
      <form
        className="preset-bar"
        onSubmit={(e) => {
          e.preventDefault();
          const name = naming.trim();
          if (!name) return;
          // Saving under an existing name replaces that preset.
          save([...presets.filter((p) => p.name.toLowerCase() !== name.toLowerCase()), { name, values }]).then(() => setNaming(null));
        }}
      >
        <input aria-label="Preset name" placeholder="Name, e.g. Work laptop" value={naming} onChange={(e) => setNaming(e.target.value)} autoFocus />
        <button type="submit" className="small-btn" disabled={!naming.trim()}>
          Save
        </button>
        <button type="button" className="link small" onClick={() => setNaming(null)}>
          Cancel
        </button>
      </form>
    );

  return (
    <div className="preset-bar">
      {presets.length > 0 && (
        <select
          aria-label="Preset"
          value={current?.name ?? ""}
          onChange={(e) => {
            const p = presets.find((x) => x.name === e.target.value);
            if (p) onPick(p.values);
          }}
        >
          {!current && <option value="">Choose a preset…</option>}
          {presets.map((p) => (
            <option key={p.name} value={p.name}>
              {p.name}
            </option>
          ))}
        </select>
      )}
      <button type="button" className="link small" onClick={() => setNaming(current?.name ?? "")}>
        {presets.length ? "Save as preset…" : "Save these values as a preset…"}
      </button>
      {current && (
        <button type="button" className="link small" onClick={() => save(presets.filter((p) => p !== current))}>
          Remove
        </button>
      )}
      {err && <span className="bad-text small">{err}</span>}
    </div>
  );
}
