/**
 * FileActions — the File board's title-bar control cluster, extracted verbatim from FileBoard so the
 * host stays under the max-lines ratchet once the Board Inspector wiring (P2) lands. Presentation +
 * the board's exact handlers, threaded as props: Pin (peek) · markdown Preview/Split/Source seg · A-/A+
 * font steppers · dirty dot + Save · read-only tag. `onMouseDown preventDefault` keeps the editor
 * focused (no blur → snapshot flip). The Board Inspector surfaces these same controls as labelled rows.
 */
import { type CSSProperties, type ReactElement } from 'react'
import { useCanvasStore } from '../../../store/canvasStore'

export type FileViewMode = 'preview' | 'split' | 'source'

export interface FileActionsProps {
  boardId: string
  isText: boolean
  isPeek: boolean
  isMarkdown: boolean
  mode: FileViewMode
  onMode: (m: FileViewMode) => void
  fontSize: number
  onAdjustFont: (delta: number) => void
  readOnly: boolean
  dirty: boolean
  saving: boolean
  onSave: () => void
}

const stepBtnStyle: CSSProperties = {
  fontFamily: 'var(--ui)',
  fontWeight: 600,
  lineHeight: 1,
  color: 'var(--text-2)',
  background: 'transparent',
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--r-ctl)',
  width: 22,
  height: 20,
  display: 'grid',
  placeItems: 'center',
  cursor: 'pointer',
  flex: 'none'
}

export function FileActions({
  boardId,
  isText,
  isPeek,
  isMarkdown,
  mode,
  onMode,
  fontSize,
  onAdjustFont,
  readOnly,
  dirty,
  saving,
  onSave
}: FileActionsProps): ReactElement | null {
  // Peek → Pin: the explicit affordance + the visual "this is a preview" cue in the title bar
  // (the canvas analog of VS Code's italic preview tab). Shown for ANY peek board (text or image).
  const pinPill = isPeek ? (
    <button
      className="nodrag"
      title="Pin this board (or double-click it in the tree / start editing)"
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => useCanvasStore.getState().pinBoard(boardId)}
      style={{
        fontFamily: 'var(--ui)',
        fontSize: 11,
        fontWeight: 500,
        color: 'var(--accent)',
        background: 'var(--accent-wash)',
        border: '1px dashed var(--accent)',
        borderRadius: 'var(--r-ctl)',
        padding: '2px 8px',
        cursor: 'pointer',
        flex: 'none'
      }}
    >
      Pin
    </button>
  ) : null

  if (isText) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 'none' }}>
        {pinPill}
        {isMarkdown && (
          <span
            style={{
              display: 'inline-flex',
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--r-ctl)',
              overflow: 'hidden',
              flex: 'none'
            }}
          >
            {(['preview', 'split', 'source'] as const).map((m) => (
              <button
                key={m}
                className="nodrag"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => onMode(m)}
                style={{
                  fontFamily: 'var(--ui)',
                  fontSize: 11,
                  fontWeight: 500,
                  padding: '2px 8px',
                  border: 'none',
                  cursor: 'pointer',
                  background: mode === m ? 'var(--accent-wash)' : 'transparent',
                  color: mode === m ? 'var(--text)' : 'var(--text-3)'
                }}
              >
                {m === 'preview' ? 'Preview' : m === 'split' ? 'Split' : 'Source'}
              </button>
            ))}
          </span>
        )}
        <span
          style={{ display: 'flex', alignItems: 'center', gap: 2, flex: 'none' }}
          title={`Font size ${fontSize}px (Ctrl/Cmd +/-)`}
        >
          <button
            className="nodrag"
            aria-label="Decrease font size"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onAdjustFont(-1)}
            style={{ ...stepBtnStyle, fontSize: 11 }}
          >
            A-
          </button>
          <button
            className="nodrag"
            aria-label="Increase font size"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onAdjustFont(1)}
            style={{ ...stepBtnStyle, fontSize: 13 }}
          >
            A+
          </button>
        </span>
        {!readOnly && mode !== 'preview' && dirty && (
          <span
            title="Unsaved changes"
            aria-label="Unsaved changes"
            style={{
              width: 7,
              height: 7,
              borderRadius: 999,
              background: 'var(--warn)',
              flex: 'none'
            }}
          />
        )}
        {!readOnly && mode !== 'preview' && (
          <button
            className="nodrag"
            title="Save (Cmd/Ctrl+S)"
            disabled={!dirty || saving}
            onMouseDown={(e) => e.preventDefault()}
            onClick={onSave}
            style={{
              fontFamily: 'var(--ui)',
              fontSize: 11,
              fontWeight: 500,
              color: dirty ? 'var(--text)' : 'var(--text-faint)',
              background: dirty ? 'var(--surface-overlay)' : 'transparent',
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--r-ctl)',
              padding: '2px 8px',
              cursor: dirty && !saving ? 'pointer' : 'default'
            }}
          >
            {saving ? 'Saving...' : 'Save'}
          </button>
        )}
        {readOnly && (
          <span
            style={{
              fontFamily: 'var(--mono)',
              fontSize: 11,
              color: 'var(--text-3)',
              flex: 'none'
            }}
          >
            read-only
          </span>
        )}
      </div>
    )
  }

  if (isPeek) {
    return <div style={{ display: 'flex', alignItems: 'center', flex: 'none' }}>{pinPill}</div>
  }

  return null
}
