import { useEffect, useState, type ReactNode } from "react";
import { isTauri, pickPath, type Api, type State } from "./api";

function Dialog({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-label={title}>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
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
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const creatingProject = project === "" || state.projects.length === 0;

  const create = async (harness?: string) => {
    setBusy(true);
    setErr(null);
    try {
      let p = project;
      if (creatingProject) p = (await api.newProject(newProject)).id;
      const { id } = await api.newScript(p, file, what, harness);
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
          create(state.harnesses[0]?.id);
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
          <label htmlFor="ns-what">What should it do?</label>
          <textarea id="ns-what" rows={4} value={what} onChange={(e) => setWhat(e.target.value)} />
        </div>
        {err && <div className="msg">{err}</div>}
        <div className="row wrap end">
          <button type="button" className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="button" disabled={busy || !file} onClick={() => create()}>
            Create
          </button>
          {state.harnesses.map((h, i) => (
            <button key={h.id} type={i === 0 ? "submit" : "button"} className={i === 0 ? "primary" : ""} disabled={busy || !file || !what.trim()} onClick={i === 0 ? undefined : () => create(h.id)}>
              Write with {h.name}
            </button>
          ))}
        </div>
        {state.harnesses.length === 0 && (
          <div className="hint">Install Claude Code, Codex, Gemini CLI or OpenCode to have an agent write scripts for you.</div>
        )}
      </form>
    </Dialog>
  );
}

export function EditWithDialog({
  harness,
  onClose,
  onSubmit,
}: {
  harness: { id: string; name: string };
  onClose: () => void;
  onSubmit: (what: string) => void;
}) {
  const [what, setWhat] = useState("");
  return (
    <Dialog title={`Edit with ${harness.name}`} onClose={onClose}>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit(what);
        }}
      >
        <div className="field">
          <label htmlFor="ew-what">What should change?</label>
          <textarea id="ew-what" rows={4} value={what} onChange={(e) => setWhat(e.target.value)} autoFocus />
          <div className="hint">Opens {harness.name} in a terminal in your scripts folder.</div>
        </div>
        <div className="row end">
          <button type="button" className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" type="submit" disabled={!what.trim()}>
            Open {harness.name}
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
          <div className="hint">
            Agents started in the scripts folder pick it up from .mcp.json. Elsewhere, add it with:
          </div>
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

        {err && <div className="msg">{err}</div>}
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
