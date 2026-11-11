import { useEffect, useState } from "react";
import { Check, ChevronDown, ChevronRight } from "lucide-react";
import type { Api } from "./api";

export interface AiClient {
  id: string;
  name: string;
  found: boolean;
  connected: boolean;
  canConnect: boolean;
  steps: { text: string; code?: string }[];
}

/** Hides the key in what's shown; Copy still copies the real thing. */
const mask = (s: string, token: string) => (token ? s.split(token).join("••••••••") : s);

/**
 * "Use with your AI apps": AI apps on this computer (Claude, ChatGPT's Codex, Gemini,
 * Cursor, VS Code…) can run your scripts, read their results and write new ones. Apps
 * found here connect with one click; every app also has steps to do it by hand.
 */
export function AiConnect({ api, mcpUrl }: { api: Api; mcpUrl: string }) {
  const [clients, setClients] = useState<AiClient[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<{ id: string; text: string } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [others, setOthers] = useState(false);

  useEffect(() => {
    api.aiClients().then(setClients).catch(() => setClients([]));
  }, []);

  if (!clients) return null;
  const found = clients.filter((c) => c.found);
  const rest = clients.filter((c) => !c.found);

  const row = (c: AiClient) => (
    <li key={c.id} className="ai-row">
      <div className="ai-head">
        <span className="ai-name">{c.name}</span>
        {c.connected ? (
          <span className="ai-ok">
            <Check size={14} aria-hidden /> Connected
          </span>
        ) : c.found && c.canConnect ? (
          <button
            type="button"
            className="small-btn"
            disabled={busy === c.id}
            onClick={async () => {
              setBusy(c.id);
              setErr(null);
              try {
                setClients(await api.connectAi(c.id));
              } catch (e: any) {
                setErr({ id: c.id, text: e.message });
                setOpen(c.id);
              } finally {
                setBusy(null);
              }
            }}
          >
            {busy === c.id ? "Connecting…" : "Connect"}
          </button>
        ) : null}
        <button
          type="button"
          className="link small ai-how"
          aria-expanded={open === c.id}
          onClick={() => setOpen(open === c.id ? null : c.id)}
        >
          {c.found && c.canConnect && !c.connected ? "By hand" : "How"}
          {open === c.id ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
        </button>
      </div>
      {err?.id === c.id && <div className="hint bad">{err.text}</div>}
      {open === c.id && (
        <div className="ai-steps">
          {c.steps.map((s, i) => (
            <div key={i}>
              <div className="hint">{s.text}</div>
              {s.code && <CodeBox code={s.code} token={api.token} />}
            </div>
          ))}
          {c.connected && <div className="hint">If you just connected it, restart the app so it picks this up.</div>}
        </div>
      )}
    </li>
  );

  return (
    <section className="field ai-connect">
      <label>Use with your AI apps</label>
      <div className="hint">Let AI apps like Claude run your scripts, check the results and write new scripts for you.</div>
      {found.length > 0 ? <ul className="ai-list">{found.map(row)}</ul> : <div className="hint">No AI apps found on this computer. Set one up by hand below.</div>}
      <button type="button" className="link small" aria-expanded={others} onClick={() => setOthers(!others)}>
        {others ? "Hide other apps" : found.length ? "Other apps" : "Show apps"}
      </button>
      {others && (
        <>
          <ul className="ai-list">{rest.map(row)}</ul>
          <div className="ai-steps">
            <div className="hint">Any other app that supports MCP: use this address, with the header below.</div>
            <CodeBox code={mcpUrl} token={api.token} />
            <CodeBox code={`Authorization: Bearer ${api.token}`} token={api.token} />
          </div>
        </>
      )}
    </section>
  );
}

function CodeBox({ code, token }: { code: string; token: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="code-box">
      <code>{mask(code, token)}</code>
      <button
        type="button"
        className="small-btn"
        onClick={() =>
          navigator.clipboard?.writeText(code).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          })
        }
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
