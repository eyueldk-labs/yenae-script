import { useEffect, useRef } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, defaultHighlightStyle, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { javascript } from "@codemirror/lang-javascript";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";

/** A TypeScript editor for a script's code (loaded only when someone opens it). */
export default function CodeEditor({ value, onChange, onSave }: { value: string; onChange: (v: string) => void; onSave: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const save = useRef(onSave);
  save.current = onSave;
  useEffect(() => {
    const view = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          history(),
          drawSelection(),
          indentOnInput(),
          bracketMatching(),
          closeBrackets(),
          highlightActiveLine(),
          highlightSelectionMatches(),
          syntaxHighlighting(defaultHighlightStyle),
          javascript({ typescript: true }),
          keymap.of([
            { key: "Mod-s", preventDefault: true, run: () => (save.current(), true) },
            indentWithTab,
            ...closeBracketsKeymap,
            ...defaultKeymap,
            ...historyKeymap,
            ...searchKeymap,
          ]),
          EditorView.updateListener.of((u) => u.docChanged && onChange(u.state.doc.toString())),
          EditorView.contentAttributes.of({ "aria-label": "Script code" }),
        ],
      }),
    });
    view.focus();
    return () => view.destroy();
  }, []);
  return <div ref={host} className="code-editor" />;
}
