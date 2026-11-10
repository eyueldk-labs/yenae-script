import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { isTauri, pickPath, type Api, type State } from "./api";

type Harness = { id: string; name: string };

let openDialogs = 0;
/** True while a dialog is open, so page-level shortcuts stand down. */
export const modalOpen = () => openDialogs > 0;
/** Menus and popovers hold the page's shortcuts too; call the result to release. */
export function holdModal() {
  openDialogs++;
  let held = true;
  return () => {
    if (held) openDialogs--;
    held = false;
  };
}

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

function Dialog({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const close = useRef(onClose);
  close.current = onClose;

  // Read during the first render: by the time effects run, autoFocus has already moved focus.
  const [before] = useState(() => document.activeElement as HTMLElement | null);

  useEffect(() => {
    openDialogs++;
    const el = box.current!;
    // React's autoFocus has already run for a field that asked for it; otherwise take the first control.
    if (!el.contains(document.activeElement)) (el.querySelector<HTMLElement>(FOCUSABLE) ?? el).focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      openDialogs--;
      window.removeEventListener("keydown", onKey);
      if (before?.isConnected) before.focus();
    };
  }, []);

  // Keep Tab inside the dialog.
  const trap = (e: React.KeyboardEvent) => {
    if (e.key !== "Tab") return;
    const items = [...box.current!.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((x) => x.offsetParent !== null);
    if (!items.length) return;
    const first = items[0]!;
    const last = items[items.length - 1]!;
    if (e.shiftKey && (document.activeElement === first || document.activeElement === box.current)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={box} className="dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onKeyDown={trap}>
        <h2 id={titleId}>{title}</h2>
        {children}
      </div>
    </div>
  );
}

const store = {
  harness: () => {
    try {
      return localStorage.getItem("harness");
    } catch {
      return null;
    }
  },
  setHarness: (id: string) => {
    try {
      localStorage.setItem("harness", id);
    } catch {}
  },
};

/** The agent to offer first: the last one used, else the first installed. */
export function preferredHarness(harnesses: Harness[]) {
  const last = store.harness();
  return harnesses.find((h) => h.id === last) ?? harnesses[0] ?? null;
}

export function NewScriptDialog({
  api,
  state,
  onClose,
  onCreated,
}: {
  api: Api;
  state: State;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const [project, setProject] = useState(state.projects[0]?.id ?? "");
  const [newProject, setNewProject] = useState(state.projects.length === 0 ? "my-scripts" : "");
  const [file, setFile] = useState("");
  const [what, setWhat] = useState("");
  const [harness, setHarness] = useState(preferredHarness(state.harnesses)?.id ?? "");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const creatingProject = project === "" || state.projects.length === 0;
  const agent = state.harnesses.find((h) => h.id === harness);

  const create = async () => {
    setBusy(true);
    setErr(null);
    try {
      let p = project;
      if (creatingProject) p = (await api.newProject(newProject)).id;
      if (agent) store.setHarness(agent.id);
      const { id } = await api.newScript(p, file, what, agent?.id);
      onCreated(id);
    } catch (e: any) {
      setErr(e.message);
      setBusy(false);
    }
  };

  return (
    <Dialog title="New script" onClose={onClose}>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          create();
        }}
      >
        <div className="field">
          <label htmlFor="ns-project">Project</label>
          <select id="ns-project" value={project} onChange={(e) => setProject(e.target.value)}>
            {state.projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.id}
              </option>
            ))}
            <option value="">New project…</option>
          </select>
          {creatingProject && (
            <input aria-label="New project name" placeholder="Project name" value={newProject} onChange={(e) => setNewProject(e.target.value)} />
          )}
        </div>
        <div className="field">
          <label htmlFor="ns-file">File</label>
          <input id="ns-file" className="mono" placeholder="backups/nightly.ts" value={file} onChange={(e) => setFile(e.target.value)} autoFocus />
          <div className="hint">Inside the project's scripts folder. Use / for sub-folders.</div>
        </div>
        <div className="field">
          <label htmlFor="ns-what">
            What should it do?{!agent && <span className="muted"> (optional)</span>}
          </label>
          <textarea id="ns-what" rows={4} value={what} onChange={(e) => setWhat(e.target.value)} />
        </div>
        {state.harnesses.length > 0 ? (
          <div className="field">
            <label htmlFor="ns-agent">Written by</label>
            <select id="ns-agent" value={harness} onChange={(e) => setHarness(e.target.value)}>
              {state.harnesses.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.name}
                </option>
              ))}
              <option value="">Me (start from a blank script)</option>
            </select>
            {agent && <div className="hint">Opens {agent.name} in a terminal with your description.</div>}
          </div>
        ) : (
          <div className="hint">Install Claude Code, Codex, Gemini CLI or OpenCode to have an agent write scripts for you.</div>
        )}
        {err && (
          <div className="msg bad" role="alert">
            {err}
          </div>
        )}
        <div className="row wrap end">
          <button type="button" className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={busy || !file.trim() || (!!agent && !what.trim())}>
            {agent ? `Write with ${agent.name}` : "Create script"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

export function EditWithDialog({
  title,
  harnesses,
  initial = "",
  onClose,
  onSubmit,
}: {
  title: string;
  harnesses: Harness[];
  initial?: string;
  onClose: () => void;
  onSubmit: (harness: Harness, what: string) => void;
}) {
  const [what, setWhat] = useState(initial);
  const [harness, setHarness] = useState(preferredHarness(harnesses)?.id ?? "");
  const agent = harnesses.find((h) => h.id === harness) ?? harnesses[0]!;
  return (
    <Dialog title={title} onClose={onClose}>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          store.setHarness(agent.id);
          onSubmit(agent, what);
        }}
      >
        <div className="field">
          <label htmlFor="ew-what">What should change?</label>
          <textarea id="ew-what" rows={initial ? 7 : 4} value={what} onChange={(e) => setWhat(e.target.value)} autoFocus />
        </div>
        {harnesses.length > 1 && (
          <div className="field">
            <label htmlFor="ew-agent">Agent</label>
            <select id="ew-agent" value={agent.id} onChange={(e) => setHarness(e.target.value)}>
              {harnesses.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.name}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="hint">Opens {agent.name} in a terminal in your scripts folder.</div>
        <div className="row wrap end">
          <button type="button" className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" type="submit" disabled={!what.trim()}>
            Open {agent.name}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

export function SettingsDialog({ api, state, onClose, onSaved }: { api: Api; state: State; onClose: () => void; onSaved: () => void }) {
  const [workspace, setWorkspace] = useState(state.workspace);
  const [err, setErr] = useState<string | null>(null);
  const [autostart, setAutostart] = useState<boolean | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!isTauri()) return;
    import("@tauri-apps/plugin-autostart").then((a) => a.isEnabled().then(setAutostart)).catch(() => {});
  }, []);

  const cmd = (token: string) =>
    `claude mcp add --transport http yenae-script ${state.mcpUrl} --header "Authorization: Bearer ${token}"`;

  return (
    <Dialog title="Settings" onClose={onClose}>
      <div className="form">
        <div className="field">
          <label htmlFor="st-ws">Scripts folder</label>
          <div className="row">
            <input id="st-ws" className="grow mono" value={workspace} onChange={(e) => setWorkspace(e.target.value)} />
            {isTauri() && (
              <button
                type="button"
                onClick={async () => {
                  const p = await pickPath("folder", "Scripts folder");
                  if (p) setWorkspace(p);
                }}
              >
                Browse
              </button>
            )}
          </div>
          <div className="hint">Each folder in it with a package.json is a project.</div>
        </div>

        {autostart !== null && (
          <label className="check">
            <input
              type="checkbox"
              checked={autostart}
              onChange={async (e) => {
                const a = await import("@tauri-apps/plugin-autostart");
                if (e.target.checked) await a.enable();
                else await a.disable();
                setAutostart(await a.isEnabled());
              }}
            />
            Start with {state.platform === "win32" ? "Windows" : state.platform === "darwin" ? "macOS" : "the system"}, so schedules keep running
          </label>
        )}

        <div className="field">
          <label>MCP server for agents</label>
          <code className="block">{state.mcpUrl}</code>
          <div className="hint">Agents started in the scripts folder pick it up from .mcp.json. Elsewhere, add it with:</div>
          <code className="block">{cmd("•••")}</code>
          <div>
            <button
              type="button"
              className="link"
              onClick={() => {
                navigator.clipboard?.writeText(cmd(api.token)).then(() => setCopied(true));
              }}
            >
              {copied ? "Copied" : "Copy command"}
            </button>
          </div>
        </div>

        {err && (
          <div className="msg bad" role="alert">
            {err}
          </div>
        )}
        <div className="row end">
          <button type="button" className="ghost" onClick={onClose}>
            Close
          </button>
          <button
            type="button"
            className="primary"
            disabled={workspace === state.workspace}
            onClick={async () => {
              try {
                await api.settings(workspace);
                onSaved();
                onClose();
              } catch (e: any) {
                setErr(e.message);
              }
            }}
          >
            Save
          </button>
        </div>
      </div>
    </Dialog>
  );
}
