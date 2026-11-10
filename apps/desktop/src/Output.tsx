import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { isTauri, pickPath, type AskRequest, type RunDetail, type RunEvent, type ShowItem } from "./api";

export function RunOutput({
  run,
  onAnswer,
  footer,
}: {
  run: RunDetail;
  onAnswer: (id: number, value: unknown) => void;
  /** Shown after a finished run, e.g. what to do about a failure. */
  footer?: ReactNode;
}) {
  const end = useRef<HTMLDivElement>(null);
  const live = run.status === "running" || run.status === "waiting";

  // Follow new output, including the results a run shows as it ends, unless the user
  // scrolled up to read. Whether they were following is noted on scroll, before new
  // content grows the page, so a large table or markdown block doesn't break it.
  const following = useRef(true);
  const sawLive = useRef(live);
  if (live) sawLive.current = true;
  useEffect(() => {
    const scroller = end.current?.closest(".panel-body");
    if (!scroller) return;
    const onScroll = () => (following.current = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 120);
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => scroller.removeEventListener("scroll", onScroll);
  }, []);
  useEffect(() => {
    if (!sawLive.current || !following.current || !end.current) return;
    end.current.scrollIntoView({ block: "nearest" });
  }, [run.status, run.events.length, run.events[run.events.length - 1], run.pendingAsk?.id]);

  const pending = run.pendingAsk;
  const answers = useMemo(() => {
    const m = new Map<number, unknown>();
    for (const e of run.events) if (e.t === "answer") m.set(e.id, e.value);
    return m;
  }, [run.events]);

  return (
    <div className="output">
      {run.events.length === 0 && run.status === "running" && <div className="muted">Starting…</div>}
      {run.events.map((e, i) => (
        <Event key={i} e={e} answered={e.t === "ask" ? answers.get(e.id) : undefined} />
      ))}
      {pending && <AskCard key={pending.id} req={pending.request} onAnswer={(v) => onAnswer(pending.id, v)} />}
      {!live && footer}
      <div ref={end} />
    </div>
  );
}

function Event({ e, answered }: { e: RunEvent; answered: unknown }) {
  switch (e.t) {
    case "out":
      return <pre className="log">{e.text}</pre>;
    case "err": {
      // The message reads as a sentence; the stack trace is there for whoever wants it.
      const lines = e.text.replace(/\n$/, "").split("\n");
      const stack = lines.filter((l) => /^\s+at\s/.test(l));
      const message = lines.filter((l) => !/^\s+at\s/.test(l)).map(plainError).join("\n");
      return (
        <>
          {message.trim() && <pre className="log err">{message}</pre>}
          {stack.length > 0 && (
            <details className="tech">
              <summary>Technical details</summary>
              <pre className="log">{stack.join("\n")}</pre>
            </details>
          )}
        </>
      );
    }
    case "sys":
      // "(exit 1)" says nothing to most people; failed is already said.
      return <div className="sys">{e.text.replace(/\s*\(exit -?\d+\)$/, "")}</div>;
    case "show":
      return <Show item={e.item} />;
    case "ask":
      return answered === undefined ? null : (
        <div className="asked">
          {e.request.message} <b>{fmtAnswer(e.request, answered)}</b>
        </div>
      );
    default:
      return null;
  }
}

/** "TypeError: ECONNREFUSED: Unable to connect" -> "Unable to connect". */
export function plainError(line: string) {
  return line.replace(/^(?:\w*Error|Uncaught \w*Error|error):\s*/, "").replace(/^[A-Z_]{4,}:\s*/, "");
}

function fmtAnswer(req: AskRequest, v: unknown) {
  if (req.kind === "confirm") return v ? "Yes" : "No";
  if (req.kind === "select") return req.options.find((o) => o.value === v)?.label ?? String(v);
  if (req.kind === "text" && req.secret) return "••••";
  return String(v);
}

export function Show({ item }: { item: ShowItem }) {
  if (item.kind === "text") return <pre className="result">{item.text}</pre>;
  if (item.kind === "markdown") {
    const html = DOMPurify.sanitize(marked.parse(item.markdown, { async: false }) as string);
    return <div className="result md" dangerouslySetInnerHTML={{ __html: html }} />;
  }
  const rows = item.rows ?? [];
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  if (!rows.length) return <div className="result muted">No rows</div>;
  return (
    <div className="result">
      <table>
        <thead>
          <tr>
            {cols.map((c) => (
              <th key={c}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {cols.map((c) => (
                <td key={c}>{cell(r[c])}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const cell = (v: unknown) => (v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));

function AskCard({ req, onAnswer }: { req: AskRequest; onAnswer: (v: unknown) => void }) {
  const [text, setText] = useState(req.kind === "text" ? (req.default ?? "") : "");
  const input = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  useEffect(() => input.current?.focus(), []);
  const qid = useId();

  if (req.kind === "confirm") {
    return (
      <div className="ask" role="group" aria-labelledby={qid}>
        <div className="ask-q" id={qid}>
          {req.message}
        </div>
        <div className="row">
          <button className={req.default !== false ? "primary" : ""} autoFocus={req.default !== false} onClick={() => onAnswer(true)}>
            Yes
          </button>
          <button className={req.default === false ? "primary" : ""} autoFocus={req.default === false} onClick={() => onAnswer(false)}>
            No
          </button>
        </div>
      </div>
    );
  }
  if (req.kind === "select") {
    return (
      <div className="ask" role="group" aria-labelledby={qid}>
        <div className="ask-q" id={qid}>
          {req.message}
        </div>
        <div className="choices">
          {req.options.map((o, i) => (
            <button key={o.value} autoFocus={i === 0} onClick={() => onAnswer(o.value)}>
              {o.label}
            </button>
          ))}
        </div>
      </div>
    );
  }
  const isPath = req.kind === "file" || req.kind === "folder";
  return (
    <form
      className="ask"
      aria-labelledby={qid}
      onSubmit={(e) => {
        e.preventDefault();
        onAnswer(text);
      }}
    >
      <label className="ask-q" htmlFor="ask-input" id={qid}>
        {req.message}
      </label>
      <div className="row">
        {req.kind === "text" && req.multiline ? (
          <textarea id="ask-input" ref={input} className="grow" rows={3} value={text} onChange={(e) => setText(e.target.value)} />
        ) : (
          <input
            id="ask-input"
            ref={input}
            className="grow"
            type={req.kind === "text" && req.secret ? "password" : "text"}
            placeholder={isPath ? `${req.kind === "file" ? "File" : "Folder"} path` : ""}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        )}
        {isPath && isTauri() && (
          <button
            type="button"
            onClick={async () => {
              const p = await pickPath(req.kind as "file" | "folder", req.message);
              if (p) onAnswer(p);
            }}
          >
            Browse
          </button>
        )}
        <button className="primary" type="submit">
          OK
        </button>
      </div>
    </form>
  );
}
