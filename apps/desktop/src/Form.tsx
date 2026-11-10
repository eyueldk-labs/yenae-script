import type { ParamSpec } from "./api";
import { PathField } from "./PathField";

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

/** Keys of required params that are empty. */
export function missing(params: Record<string, ParamSpec>, values: Record<string, unknown>) {
  return Object.entries(params)
    .filter(([k, p]) => !p.optional && p.kind !== "boolean" && (values[k] === "" || values[k] === undefined || values[k] === null))
    .map(([k]) => k);
}

/** Show a param value the way the form would, e.g. for a schedule's saved values. */
export function fmtValue(spec: ParamSpec | undefined, v: unknown) {
  if (v === "" || v === undefined || v === null) return "–";
  if (spec?.secret) return "••••";
  if (spec?.kind === "boolean") return v ? "Yes" : "No";
  if (spec?.kind === "select") return spec.options?.find((o) => o.value === v)?.label ?? String(v);
  return typeof v === "string" ? v : JSON.stringify(v);
}

export const fieldId = (key: string, prefix = "p") => `${prefix}-${key}`;

export function ParamForm({
  params,
  values,
  onChange,
  onSubmit,
  invalid = [],
  idPrefix = "p",
}: {
  params: Record<string, ParamSpec>;
  values: Record<string, unknown>;
  onChange: (v: Record<string, unknown>) => void;
  onSubmit: () => void;
  /** Required params left empty on the last Run. */
  invalid?: string[];
  /** Keeps field ids unique when two forms for one script are on screen. */
  idPrefix?: string;
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
        <Field key={key} id={key} prefix={idPrefix} spec={p} value={values[key]} invalid={invalid.includes(key)} onChange={(v) => set(key, v)} />
      ))}
      <button type="submit" hidden />
    </form>
  );
}

function Field({
  id,
  prefix,
  spec,
  value,
  invalid,
  onChange,
}: {
  id: string;
  prefix: string;
  spec: ParamSpec;
  value: unknown;
  invalid: boolean;
  onChange: (v: unknown) => void;
}) {
  const label = labelOf(id, spec);
  const fid = fieldId(id, prefix);
  const hintId = `${fid}-hint`;
  const hint = (spec.description || invalid) && (
    <div id={hintId} className={invalid ? "hint bad" : "hint"}>
      {[invalid && "Required.", spec.description].filter(Boolean).join(" ")}
    </div>
  );
  // Shared by every text-like control: links the hint and flags an empty required value.
  const a11y = { "aria-invalid": invalid || undefined, "aria-describedby": hint ? hintId : undefined };

  if (spec.kind === "boolean") {
    return (
      <div className="field">
        <label className="check">
          <input id={fid} type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} />
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
        <select id={fid} {...a11y} value={String(value ?? "")} onChange={(e) => onChange(e.target.value)}>
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
          {...a11y}
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
        <PathField
          id={fid}
          kind={spec.kind}
          title={label}
          value={String(value ?? "")}
          invalid={invalid}
          describedBy={hint ? hintId : undefined}
          onChange={onChange}
        />
      );
      break;
    default:
      input = spec.multiline ? (
        <textarea id={fid} {...a11y} rows={4} value={String(value ?? "")} placeholder={spec.placeholder} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <input
          id={fid}
          {...a11y}
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
