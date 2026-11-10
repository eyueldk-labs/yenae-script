import { isTauri, pickPath, type ParamSpec } from "./api";

export function labelOf(key: string, spec: ParamSpec) {
  if (spec.label) return spec.label;
  const s = key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[-_]+/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

export function defaults(params: Record<string, ParamSpec>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, p] of Object.entries(params)) {
    out[k] = p.default ?? (p.kind === "boolean" ? false : p.kind === "select" ? p.options?.[0]?.value : "");
  }
  return out;
}

/** Names of required params that are empty. */
export function missing(params: Record<string, ParamSpec>, values: Record<string, unknown>) {
  return Object.entries(params)
    .filter(([k, p]) => !p.optional && p.kind !== "boolean" && (values[k] === "" || values[k] === undefined || values[k] === null))
    .map(([k, p]) => labelOf(k, p));
}

export function ParamForm({
  params,
  values,
  onChange,
  onSubmit,
}: {
  params: Record<string, ParamSpec>;
  values: Record<string, unknown>;
  onChange: (v: Record<string, unknown>) => void;
  onSubmit: () => void;
}) {
  const set = (k: string, v: unknown) => onChange({ ...values, [k]: v });
  return (
    <form
      className="form"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      {Object.entries(params).map(([key, p]) => (
        <Field key={key} id={key} spec={p} value={values[key]} onChange={(v) => set(key, v)} />
      ))}
      <button type="submit" hidden />
    </form>
  );
}

function Field({ id, spec, value, onChange }: { id: string; spec: ParamSpec; value: unknown; onChange: (v: unknown) => void }) {
  const label = labelOf(id, spec);
  const fid = `p-${id}`;
  const hint = spec.description && <div className="hint">{spec.description}</div>;

  if (spec.kind === "boolean") {
    return (
      <div className="field">
        <label className="check">
          <input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} />
          {label}
        </label>
        {hint}
      </div>
    );
  }

  let input;
  switch (spec.kind) {
    case "select":
      input = (
        <select id={fid} value={String(value ?? "")} onChange={(e) => onChange(e.target.value)}>
          {spec.options?.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      );
      break;
    case "number":
      input = (
        <input
          id={fid}
          type="number"
          min={spec.min}
          max={spec.max}
          value={value === undefined || value === null ? "" : String(value)}
          onChange={(e) => onChange(e.target.value === "" ? "" : Number(e.target.value))}
        />
      );
      break;
    case "file":
    case "folder":
      input = (
        <div className="row">
          <input
            id={fid}
            className="grow mono"
            value={String(value ?? "")}
            placeholder={spec.kind === "folder" ? "Folder path" : "File path"}
            onChange={(e) => onChange(e.target.value)}
          />
          {isTauri() && (
            <button
              type="button"
              onClick={async () => {
                const p = await pickPath(spec.kind as "file" | "folder", label);
                if (p) onChange(p);
              }}
            >
              Browse
            </button>
          )}
        </div>
      );
      break;
    default:
      input = spec.multiline ? (
        <textarea id={fid} rows={4} value={String(value ?? "")} placeholder={spec.placeholder} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <input
          id={fid}
          type={spec.secret ? "password" : "text"}
          value={String(value ?? "")}
          placeholder={spec.placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
      );
  }

  return (
    <div className="field">
      <label htmlFor={fid}>
        {label}
        {spec.optional && <span className="muted"> (optional)</span>}
      </label>
      {input}
      {hint}
    </div>
  );
}
