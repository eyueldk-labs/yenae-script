import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { holdModal } from "./Dialogs";

export type MenuEntry =
  | { label: string; onSelect: () => void; hint?: string; checked?: boolean; disabled?: boolean }
  | { heading: string }
  | "separator";

/** A small context menu at a point: arrow keys move, Enter picks, Esc or a click outside closes. */
export function Menu({ x, y, items, onClose, label }: { x: number; y: number; items: MenuEntry[]; onClose: () => void; label: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  const close = useRef(onClose);
  close.current = onClose;

  // Keep the menu on screen.
  useLayoutEffect(() => {
    const r = box.current!.getBoundingClientRect();
    setPos({ left: Math.max(8, Math.min(x, innerWidth - r.width - 8)), top: Math.max(8, Math.min(y, innerHeight - r.height - 8)) });
  }, [x, y]);

  useEffect(() => {
    const release = holdModal();
    const before = document.activeElement as HTMLElement | null;
    box.current?.querySelector<HTMLElement>("[role=menuitem]:not([disabled])")?.focus();
    const away = (e: MouseEvent) => !box.current?.contains(e.target as Node) && close.current();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close.current();
      }
    };
    window.addEventListener("mousedown", away, true);
    window.addEventListener("keydown", key);
    window.addEventListener("blur", close.current);
    return () => {
      release();
      window.removeEventListener("mousedown", away, true);
      window.removeEventListener("keydown", key);
      window.removeEventListener("blur", close.current);
      if (before?.isConnected) before.focus();
    };
  }, []);

  const move = (e: React.KeyboardEvent) => {
    const all = [...box.current!.querySelectorAll<HTMLElement>("[role=menuitem]:not([disabled])")];
    const i = all.indexOf(document.activeElement as HTMLElement);
    const d = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0;
    if (d) {
      e.preventDefault();
      all[(i + d + all.length) % all.length]?.focus();
    } else if (e.key === "Tab") {
      e.preventDefault();
      close.current();
    }
  };

  return (
    <div ref={box} className="menu" role="menu" aria-label={label} style={pos} onKeyDown={move}>
      {items.map((it, i) =>
        it === "separator" ? (
          <div key={i} className="menu-sep" role="separator" />
        ) : "heading" in it ? (
          <div key={i} className="menu-head">
            {it.heading}
          </div>
        ) : (
          <button
            key={i}
            role="menuitem"
            disabled={it.disabled}
            onClick={() => {
              close.current();
              it.onSelect();
            }}
          >
            <span className="grow">{it.label}</span>
            {it.checked && <span aria-hidden>✓</span>}
            {it.hint && <span className="muted small">{it.hint}</span>}
          </button>
        ),
      )}
    </div>
  );
}
