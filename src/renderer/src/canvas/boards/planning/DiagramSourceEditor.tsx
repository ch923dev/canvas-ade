/**
 * Mermaid source editor (S4b) — CodeMirror 6 with the mermaid Lezer grammar, lazy-loaded so the
 * CodeMirror core + grammar never weigh the Planning chunk (DiagramCard dynamic-imports this on
 * mount; the plain <textarea> serves until the chunk is ready). The grammar is imported DIRECTLY
 * from `codemirror-lang-mermaid` — never via the `@uiw/codemirror-extensions-langs` barrel, whose
 * name-indexed loader defeats tree-shaking (the fileBoardSyntax discipline).
 */
import { useMemo, type ReactElement } from 'react'
import CodeMirror, { EditorView } from '@uiw/react-codemirror'
import { mermaid } from 'codemirror-lang-mermaid'

export interface DiagramSourceEditorProps {
  value: string
  /** Fires per keystroke with the full document (DiagramCard debounces into the tracked commit). */
  onChange: (value: string) => void
}

/** Token-mapped editor chrome — mirrors the card's textarea look (mono 12px on --surface), with
 *  the accent reserved for caret/selection. Deliberately NOT fileBoardSyntax's EDITOR_THEME:
 *  importing that would drag the 1.7 MB grammar chunk into this one. */
const CARD_THEME = EditorView.theme(
  {
    '&': {
      backgroundColor: 'var(--surface)',
      color: 'var(--text)',
      height: '100%',
      fontSize: 'var(--fs-label)'
    },
    '.cm-content': {
      fontFamily: 'var(--term-mono)',
      lineHeight: '1.5',
      padding: '8px',
      caretColor: 'var(--accent)'
    },
    '.cm-cursor': { borderLeftColor: 'var(--accent)' },
    '&.cm-focused': { outline: 'none' },
    '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
      backgroundColor: 'var(--accent-wash)'
    },
    '.cm-activeLine': { backgroundColor: 'transparent' },
    '.cm-scroller': { overflow: 'auto' }
  },
  { dark: true }
)

export default function DiagramSourceEditor({
  value,
  onChange
}: DiagramSourceEditorProps): ReactElement {
  const extensions = useMemo(() => [mermaid(), EditorView.lineWrapping, CARD_THEME], [])
  return (
    <CodeMirror
      value={value}
      autoFocus
      height="100%"
      style={{ height: '100%' }}
      theme="none"
      extensions={extensions}
      basicSetup={{
        lineNumbers: false,
        foldGutter: false,
        highlightActiveLine: false,
        highlightActiveLineGutter: false,
        autocompletion: false,
        searchKeymap: false,
        highlightSelectionMatches: false,
        closeBrackets: true,
        bracketMatching: true
      }}
      onChange={onChange}
    />
  )
}
