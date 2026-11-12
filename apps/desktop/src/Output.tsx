import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { MessageCircleQuestion } from "lucide-react";
import { isTauri, pickPath, type AskRequest, type RunDetail, type RunEvent, type ShowItem } from "./api";

export function RunOutput({
  run,
  onAnswer,
  footer,
  tech = [],
}: {
  run: RunDetail;
  onAnswer: (id: number, value: unknown) => void;
  /** Shown after a finished run, e.g. what to do about a failure. */
  footer?: ReactNode;
  /** Extra lines for Technical details, e.g. the values a failed run had. */
  tech?: string[];
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

  // A failed run leads with what went wrong, in plain words. Everything only a developer
  // needs (the log, timing, values, raw error and stack) waits in one fold. Results it
  // showed before failing stay visible.
  if (run.status === "failed") {
    const errText = run.events.filter((e) => e.t === "err").map((e) => (e as { text: string }).text).join("");
    const first = errText.split("\n").find((l) => l.trim() && !/^\s+at\s/.test(l)) ?? run.error ?? "";
    const message = first ? (friendlyError(first) ?? plainError(first)) : "Something went wrong while it ran.";
    const details = [
      ...run.events.flatMap((e) => (e.t === "out" || e.t === "err" || e.t === "sys" ? [e.text.replace(/\n$/, "")] : [])),
      ...tech,
    ];
    return (
      <div className="output">
        <p className="fail-msg">{message}</p>
        {run.events.map((e, i) => (e.t === "show" ? <Show key={i} item={e.item} /> : null))}
        <TechDetails lines={details} />
        {footer}
        <div ref={end} />
      </div>
    );
  }

  // Stack traces fold away; the message above them reads as a sentence. Once a run ends, the
  // status line ("Done in 17 ms") folds away too: the header above already says how it went.
  const stack = run.events.flatMap((e) => (e.t === "err" ? e.text.split("\n").filter((l) => /^\s+at\s/.test(l)) : []));
  const endIdx = live ? -1 : run.events.map((e) => e.t).lastIndexOf("sys");
  const endLine = endIdx >= 0 ? [(run.events[endIdx] as { text: string }).text] : [];
  // A finished run that showed results leads with them; its printed log is one click away.
  const hasShow = !live && run.events.some((e) => e.t === "show");
  if (hasShow) {
    const log = run.events.flatMap((e) => (e.t === "out" || e.t === "err" || e.t === "sys" ? [e.text.replace(/\n$/, "")] : []));
    return (
      <div className="output">
        {run.events.map((e, i) => (e.t === "show" || e.t === "ask" ? <Event key={i} e={e} answered={e.t === "ask" ? answers.get(e.id) : undefined} /> : null))}
        <details className="tech">
          <summary>{run.source === "agent" ? "Show what it did" : "Show output"}</summary>
          <pre className="log">{[...log, ...tech].join("\n")}</pre>
        </details>
        {footer}
        <div ref={end} />
      </div>
    );
  }

  return (
    <div className={`output ${live ? "live" : ""}`}>
      {run.events.length === 0 && run.status === "running" && <div className="muted">Starting…</div>}
      {run.events.map((e, i) => (i === endIdx ? null : <Event key={i} e={e} answered={e.t === "ask" ? answers.get(e.id) : undefined} />))}
      {pending && <AskCard key={pending.id} req={pending.request} onAnswer={(v) => onAnswer(pending.id, v)} />}
      {!live && (stack.length > 0 || tech.length > 0 || endLine.length > 0) && (
        <TechDetails lines={[...endLine, ...tech, ...stack]} />
      )}
      {!live && footer}
      <div ref={end} />
    </div>
  );
}

/**
 * The fold with everything only a developer needs. The app's own internals are left out
 * and paths shortened to file names; "Copy details" copies the full text for a bug report.
 */
function TechDetails({ lines }: { lines: string[] }) {
  const [copied, setCopied] = useState(false);
  const shown = lines
    .flatMap((l) => l.split("\n"))
    .filter((l) => !/[\\/](?:engine[\\/](?:main|runner)\.js|packages[\\/]engine[\\/])|node:internal|native:/.test(l))
    .map((l) => l.replace(/(?:[A-Za-z]:)?(?:[\\/][^\s\\/():]+)+[\\/]([^\s\\/():]+)/g, "$1"));
  return (
    <details className="tech">
      <summary>Technical details</summary>
      <pre className="log">{shown.join("\n")}</pre>
      <button
        className="link small"
        onClick={() => navigator.clipboard?.writeText(lines.join("\n")).then(() => setCopied(true))}
      >
        {copied ? "Copied" : "Copy details"}
      </button>
    </details>
  );
}

function Event({ e, answered }: { e: RunEvent; answered: unknown }) {
  switch (e.t) {
    case "out": {
      // A change an agent made: "- old" and "+ new" lines, coloured.
      const lines = e.text.replace(/\n$/, "").split("\n");
      if (lines.length && lines.every((l) => l === "…" || l.startsWith("- ") || l.startsWith("+ ")))
        return (
          <pre className="log diff">
            {lines.map((l, i) => (
              <div key={i} className={l.startsWith("+ ") ? "add" : l.startsWith("- ") ? "del" : ""}>
                {l}
              </div>
            ))}
          </pre>
        );
      return <pre className="log">{e.text}</pre>;
    }
    case "err": {
      // The message reads as a sentence; the stack trace is in Technical details.
      const message = e.text
        .replace(/\n$/, "")
        .split("\n")
        .filter((l) => !/^\s+at\s/.test(l))
        .map((l) => friendlyError(l) ?? plainError(l))
        .join("\n");
      return message.trim() ? <pre className="log err">{message}</pre> : null;
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

/** Common failures, said the way a person would say them. */
const FRIENDLY: [RegExp, string][] = [
  [/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|Unable to connect|fetch failed|getaddrinfo/i, "Couldn't connect. Check the web address and your internet connection."],
  [/ENOENT|no such file or directory/i, "A file or folder it needs isn't there."],
  [/EACCES|EPERM|permission denied/i, "It isn't allowed to open a file or folder it needs."],
  [/ENOSPC|no space left/i, "The disk is full."],
];
export function friendlyError(line: string) {
  return FRIENDLY.find(([re]) => re.test(line))?.[1] ?? null;
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
          <MessageCircleQuestion size={18} className="ask-icon" aria-hidden />
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
          <MessageCircleQuestion size={18} className="ask-icon" aria-hidden />
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
        <MessageCircleQuestion size={18} className="ask-icon" aria-hidden />
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
