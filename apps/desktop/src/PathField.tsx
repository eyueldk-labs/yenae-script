import { useState } from "react";
import { File as FileIcon, Folder } from "lucide-react";
import { isTauri, pickPath } from "./api";

/** "C:\Users\me\Notes" -> "Notes" */
const lastPart = (p: string) => p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p;

/**
 * A file or folder input people pick rather than type: a "Choose folder…" button that
 * opens the system picker, then the chosen name with its full path underneath.
 * Typing a path stays possible ("Type a path"), and is the only way in a plain browser.
 */
export function PathField({
  id,
  kind,
  value,
  title,
  invalid,
  describedBy,
  onChange,
}: {
  id: string;
  kind: "file" | "folder";
  value: string;
  title: string;
  invalid?: boolean;
  describedBy?: string;
  onChange: (v: string) => void;
}) {
  const [typing, setTyping] = useState(false);
  const Icon = kind === "folder" ? Folder : FileIcon;
  const noun = kind === "folder" ? "folder" : "file";

  const choose = async () => {
    if (!isTauri()) return setTyping(true);
    const p = await pickPath(kind, title);
    if (p) onChange(p);
  };

  if (typing) {
    return (
      <div className="row">
        <input
          id={id}
          className="grow"
          autoFocus
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          value={value}
          placeholder={kind === "folder" ? "C:\\Users\\you\\Documents" : "C:\\Users\\you\\file.txt"}
          onChange={(e) => onChange(e.target.value)}
          onBlur={() => value && setTyping(false)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && value) setTyping(false);
          }}
        />
        {isTauri() && (
          <button type="button" onClick={choose}>
            Choose…
          </button>
        )}
      </div>
    );
  }

  return (
    <div className={`path-field ${value ? "set" : ""} ${invalid ? "invalid" : ""}`}>
      <button
        type="button"
        id={id}
        className="path-pick"
        aria-describedby={describedBy}
        aria-invalid={invalid || undefined}
        title={value || undefined}
        onClick={choose}
      >
        <Icon size={17} aria-hidden />
        {value ? (
          <span className="path-text">
            <span className="path-name">{lastPart(value)}</span>
            <span className="path-full">{value}</span>
          </span>
        ) : (
          <span className="path-text">Choose {noun}…</span>
        )}
      </button>
      <button type="button" className="link small" onClick={() => setTyping(true)}>
        {value ? "Change" : "Type a path"}
      </button>
    </div>
  );
}
