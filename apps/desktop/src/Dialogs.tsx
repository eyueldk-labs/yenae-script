import { Suspense, lazy, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import { isTauri, type Api, type State } from "./api";
import { PathField } from "./PathField";
import { applyUpdate, checkUpdates, useUpdateStatus } from "./updates";
import { AiConnect } from "./AiConnect";
import { MOD } from "./fmt";

import type { Harness } from "./api";

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

export function Dialog({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
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
      <div ref={box} className={`dialog ${wide ? "wide" : ""}`} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onKeyDown={trap}>
        <div className="dialog-head">
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="ib" aria-label="Close" title="Close (Esc)" onClick={() => close.current()}>
            <X size={17} aria-hidden />
          </button>
        </div>
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
  const [name, setName] = useState("");
  const [what, setWhat] = useState("");
  const [project, setProject] = useState(state.projects[0]?.id ?? "");
  const [newProject, setNewProject] = useState(state.projects.length === 0 ? "my-scripts" : "");
  const [file, setFile] = useState("");
  const [harness, setHarness] = useState(preferredHarness(state.harnesses)?.id ?? "");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const creatingProject = project === "" || state.projects.length === 0;
  const agent = state.harnesses.find((h) => h.id === harness);
  // The file name follows the name unless the user typed one under "More options".
  const fileName = file.trim() || name.trim();

  const create = async () => {
    setBusy(true);
    setErr(null);
    try {
      let p = project;
      if (creatingProject) p = (await api.newProject(newProject || "my-scripts")).id;
      if (agent) store.setHarness(agent.id);
      const { id } = await api.newScript(p, fileName, what, agent?.id);
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
          <label htmlFor="ns-name">Name</label>
          <input id="ns-name" placeholder="e.g. Back up my notes" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </div>
        <div className="field">
          <label htmlFor="ns-what">What should it do?</label>
          <textarea
            id="ns-what"
            rows={4}
            placeholder="e.g. Copy my Notes folder to the backup drive and keep the last 10 copies."
            value={what}
            onChange={(e) => setWhat(e.target.value)}
          />
          {agent ? (
            <div className="hint">{agent.short} writes it for you, right here. It takes a minute or two, and you can watch it work.</div>
          ) : (
            state.harnesses.length === 0 && (
              <div className="hint">This makes an empty script. Install Claude Code, Codex, Gemini CLI or OpenCode to have one written for you.</div>
            )
          )}
        </div>
        <details className="more">
          <summary>More options</summary>
          <div className="form">
            {state.harnesses.length > 0 && (
              <div className="field">
                <label htmlFor="ns-agent">Written by</label>
                <select id="ns-agent" value={harness} onChange={(e) => setHarness(e.target.value)}>
                  {state.harnesses.map((h) => (
                    <option key={h.id} value={h.id}>
                      {h.name}
                    </option>
                  ))}
                  <option value="">Nobody (I'll write it myself)</option>
                </select>
              </div>
            )}
            <div className="field">
              <label htmlFor="ns-project">Group</label>
              <select id="ns-project" value={project} onChange={(e) => setProject(e.target.value)}>
                {state.projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.id}
                  </option>
                ))}
                <option value="">New group…</option>
              </select>
              {creatingProject && (
                <input aria-label="New group name" placeholder="Group name" value={newProject} onChange={(e) => setNewProject(e.target.value)} />
              )}
              <div className="hint">Where the script is kept, inside your scripts folder.</div>
            </div>
            <div className="field">
              <label htmlFor="ns-file">File name</label>
              <input id="ns-file" placeholder={name ? `${name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-")}.ts` : "Made from the name"} value={file} onChange={(e) => setFile(e.target.value)} />
            </div>
          </div>
        </details>
        {err && (
          <div className="msg bad" role="alert">
            {err}
          </div>
        )}
        <div className="row wrap end dialog-actions">
          {!busy && (!fileName || (!!agent && !what.trim())) && (
            <span className="muted small grow">{!fileName ? "Add a name to continue." : "Say what it should do to continue."}</span>
          )}
          <button type="button" className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={busy || !fileName || (!!agent && !what.trim())}>
            {busy ? "Creating…" : "Create script"}
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
            <label htmlFor="ew-agent">Done by</label>
            <select id="ew-agent" value={agent.id} onChange={(e) => setHarness(e.target.value)}>
              {harnesses.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.name}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="hint">{agent.short} makes the change right here; you can watch it work.</div>
        <div className="row wrap end dialog-actions">
          <button type="button" className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" type="submit" disabled={!what.trim()}>
            Start
          </button>
        </div>
      </form>
    </Dialog>
  );
}

const CodeEditor = lazy(() => import("./CodeEditor"));

/**
 * Edit a script, two ways: describe a change for an AI agent to make (in the background,
 * shown in the script's panel), or change the code yourself in the built-in editor.
 */
export function EditScriptDialog({
  api,
  script,
  harnesses,
  tab: startTab,
  initial = "",
  onClose,
  onStarted,
  onSaved,
}: {
  api: Api;
  script: { id: string; name: string };
  harnesses: Harness[];
  tab?: "ask" | "code";
  initial?: string;
  onClose: () => void;
  /** An agent started on it (its run id). */
  onStarted: (run: string) => void;
  onSaved?: () => void;
}) {
  const [tab, setTab] = useState<"ask" | "code">(startTab ?? (harnesses.length ? "ask" : "code"));
  const [what, setWhat] = useState(initial);
  const [harness, setHarness] = useState(preferredHarness(harnesses)?.id ?? "");
  const agent = harnesses.find((h) => h.id === harness) ?? harnesses[0];
  const [code, setCode] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; bad: boolean } | null>(null);
  const [askDiscard, setAskDiscard] = useState(false);
  const dirty = code !== null && code !== saved;

  useEffect(() => {
    if (tab !== "code" || code !== null) return;
    api
      .readSource(script.id)
      .then((r) => {
        setCode(r.text);
        setSaved(r.text);
      })
      .catch((e) => setMsg({ text: e.message, bad: true }));
  }, [tab]);

  const save = async () => {
    if (code === null || busy) return;
    setBusy(true);
    try {
      const r = await api.writeSource(script.id, code);
      setSaved(code);
      setMsg(r.error ? { text: `Saved, but it doesn't load: ${r.error}`, bad: true } : { text: "Saved.", bad: false });
      onSaved?.();
    } catch (e: any) {
      setMsg({ text: e.message, bad: true });
    } finally {
      setBusy(false);
    }
  };
  const close = () => (dirty ? setAskDiscard(true) : onClose());

  return (
    <Dialog title={`Edit ${script.name}`} onClose={close} wide={tab === "code"}>
      <div className="tabs dialog-tabs" role="tablist" aria-label="How to edit">
        <button type="button" role="tab" aria-selected={tab === "ask"} className={tab === "ask" ? "on" : ""} onClick={() => setTab("ask")}>
          Describe a change
        </button>
        <button type="button" role="tab" aria-selected={tab === "code"} className={tab === "code" ? "on" : ""} onClick={() => setTab("code")}>
          Edit the code
        </button>
      </div>

      {tab === "ask" &&
        (agent ? (
          <form
            className="form"
            onSubmit={async (e) => {
              e.preventDefault();
              store.setHarness(agent.id);
              setBusy(true);
              try {
                const { run } = await api.editWith(script.id, agent.id, what);
                onStarted(run);
              } catch (err: any) {
                setMsg({ text: err.message, bad: true });
                setBusy(false);
              }
            }}
          >
            <div className="field">
              <label htmlFor="es-what">What should change?</label>
              <textarea id="es-what" rows={initial ? 7 : 4} value={what} onChange={(e) => setWhat(e.target.value)} autoFocus placeholder="e.g. Also skip files smaller than 1 MB." />
            </div>
            {harnesses.length > 1 && (
              <div className="field">
                <label htmlFor="es-agent">Done by</label>
                <select id="es-agent" value={agent.id} onChange={(e) => setHarness(e.target.value)}>
                  {harnesses.map((h) => (
                    <option key={h.id} value={h.id}>
                      {h.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div className="hint">{agent.short} makes the change; you can watch it work in the panel.</div>
            {msg && <div className={`msg ${msg.bad ? "bad" : "note"}`}>{msg.text}</div>}
            <div className="row wrap end dialog-actions">
              <button type="button" className="ghost" onClick={close}>
                Cancel
              </button>
              <button className="primary" type="submit" disabled={!what.trim() || busy}>
                Start
              </button>
            </div>
          </form>
        ) : (
          <div className="form">
            <p className="muted">
              To have changes made for you, install an AI coding agent such as Claude Code, Codex or Gemini CLI, then open this again. Or edit the code yourself.
            </p>
          </div>
        ))}

      {tab === "code" && (
        <div className="form">
          {code === null ? (
            <p className="muted small">{msg?.text ?? "Loading…"}</p>
          ) : (
            <Suspense fallback={<p className="muted small">Loading the editor…</p>}>
              <CodeEditor value={code} onChange={(v) => setCode(v)} onSave={save} />
            </Suspense>
          )}
          {msg && code !== null && <div className={`msg ${msg.bad ? "bad" : "note"}`} role="status">{msg.text}</div>}
          {askDiscard ? (
            <div className="row wrap end dialog-actions">
              <span className="grow">You have changes that aren't saved.</span>
              <button type="button" className="ghost" onClick={onClose}>
                Discard
              </button>
              <button type="button" className="primary" onClick={() => setAskDiscard(false)}>
                Keep editing
              </button>
            </div>
          ) : (
            <div className="row wrap end dialog-actions">
              <span className="muted small grow">{MOD}+S saves</span>
              <button type="button" className="ghost" onClick={close}>
                {dirty ? "Cancel" : "Close"}
              </button>
              <button type="button" className="primary" disabled={!dirty || busy} onClick={save}>
                {busy ? "Saving…" : "Save"}
              </button>
            </div>
          )}
        </div>
      )}
    </Dialog>
  );
}

/** "Delete Week number?" before a script goes to the trash. */
export function ConfirmDeleteDialog({ name, onClose, onDelete }: { name: string; onClose: () => void; onDelete: () => void }) {
  return (
    <Dialog title={`Delete ${name}?`} onClose={onClose}>
      <p className="muted" style={{ marginTop: 0 }}>
        Its schedule stops. You can undo this right after, and the file is kept in the scripts folder's trash for 30 days.
      </p>
      <div className="row wrap end dialog-actions">
        <button type="button" className="ghost" onClick={onClose} autoFocus>
          Cancel
        </button>
        <button type="button" className="danger" onClick={onDelete}>
          Delete
        </button>
      </div>
    </Dialog>
  );
}

/** "Version 0.1.0 · Check for updates", and a restart button when one is ready. */
function VersionRow() {
  const upd = useUpdateStatus();
  const [asked, setAsked] = useState(false);
  if (!upd) return null;
  const note = upd.applying
    ? "Updating…"
    : upd.ready
      ? upd.waiting
        ? `Version ${upd.ready} installs as soon as your running scripts finish.`
        : `Version ${upd.ready} is ready.`
      : upd.checking
        ? "Checking…"
        : asked
          ? upd.checkError
            ? "Couldn't check. Are you online?"
            : "You have the latest version."
          : "Updates download by themselves.";
  return (
    <div className="field">
      <label>App</label>
      <div className="row wrap">
        <span>Version {upd.version}</span>
        {upd.ready && !upd.waiting && !upd.applying ? (
          <button type="button" className="primary small-btn" onClick={() => applyUpdate().catch(() => {})}>
            Restart to update
          </button>
        ) : (
          <button
            type="button"
            className="small-btn"
            disabled={upd.checking || upd.applying}
            onClick={() => {
              setAsked(true);
              checkUpdates().catch(() => {});
            }}
          >
            Check for updates
          </button>
        )}
      </div>
      <div className="hint" role="status">
        {note}
      </div>
    </div>
  );
}

export function SettingsDialog({ api, state, onClose, onSaved }: { api: Api; state: State; onClose: () => void; onSaved: () => void }) {
  const [workspace, setWorkspace] = useState(state.workspace);
  const [err, setErr] = useState<string | null>(null);
  const [autostart, setAutostart] = useState<boolean | null>(null);

  useEffect(() => {
    if (!isTauri()) return;
    import("@tauri-apps/plugin-autostart").then((a) => a.isEnabled().then(setAutostart)).catch(() => {});
  }, []);

  return (
    <Dialog title="Settings" onClose={onClose}>
      <div className="form">
        <div className="field">
          <label htmlFor="st-ws">Scripts folder</label>
          <PathField id="st-ws" kind="folder" title="Scripts folder" value={workspace} onChange={setWorkspace} describedBy="st-ws-hint" />
          <div className="hint" id="st-ws-hint">
            Where your scripts live. Each folder inside it is a group of scripts.
          </div>
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
            Open Yenae Script when you sign in, so scheduled scripts keep running
          </label>
        )}

        <VersionRow />

        <AiConnect api={api} mcpUrl={state.mcpUrl} />

        {err && (
          <div className="msg bad" role="alert">
            {err}
          </div>
        )}
        <div className="row end dialog-actions">
          {workspace === state.workspace ? (
            // Nothing to save (autostart applies at once): one way out.
            <button type="button" className="primary" onClick={onClose}>
              Done
            </button>
          ) : (
            <>
              <button type="button" className="ghost" onClick={onClose}>
                Cancel
              </button>
              <button
                type="button"
                className="primary"
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
            </>
          )}
        </div>
      </div>
    </Dialog>
  );
}

/** Make a folder: name it and tick the scripts that go in it. */
export function NewFolderDialog({
  scripts,
  onClose,
  onCreate,
}: {
  scripts: { id: string; name: string }[];
  onClose: () => void;
  onCreate: (name: string, ids: string[]) => void;
}) {
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  return (
    <Dialog title="New folder" onClose={onClose}>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          if (picked.length) onCreate(name.trim() || "New folder", picked);
        }}
      >
        <div className="field">
          <label htmlFor="nf-name">Name</label>
          <input id="nf-name" placeholder="e.g. Photos" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </div>
        <fieldset className="pick-list">
          <legend>Put these scripts in it</legend>
          {scripts.map((s) => (
            <label key={s.id} className="check">
              <input
                type="checkbox"
                checked={picked.includes(s.id)}
                onChange={(e) => setPicked((p) => (e.target.checked ? [...p, s.id] : p.filter((x) => x !== s.id)))}
              />
              {s.name}
            </label>
          ))}
        </fieldset>
        <div className="row end dialog-actions">
          <button type="button" className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={!picked.length}>
            Make folder
          </button>
        </div>
      </form>
    </Dialog>
  );
}
