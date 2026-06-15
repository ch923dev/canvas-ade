import { useEffect, useRef, useState, type ReactElement } from 'react'
import type { OsrDialogEvent } from '../../../../../preload'

/**
 * OS-3 Phase 4 (4B) — board-anchored modal for a previewed page's `alert`/`confirm`/`prompt`.
 *
 * Offscreen, a JS dialog FREEZES the renderer waiting for a native modal it can't show; MAIN
 * intercepts it via CDP and surfaces this instead. The user's choice routes back through
 * `Page.handleJavaScriptDialog`, so the page's `confirm()`/`prompt()` resolves with the real value.
 * Message + default text are UNTRUSTED page strings → rendered as escaped React text (capped in MAIN).
 * Enter = OK, Esc = Cancel; autofocuses the prompt input (or OK) so the keyboard drives it directly.
 */
export function OsrJsDialog({
  dialog,
  onRespond
}: {
  dialog: OsrDialogEvent
  onRespond: (accept: boolean, promptText?: string) => void
}): ReactElement {
  const isPrompt = dialog.dialogType === 'prompt'
  const hasCancel = dialog.dialogType !== 'alert'
  const [text, setText] = useState(dialog.defaultPrompt)
  const inputRef = useRef<HTMLInputElement>(null)
  const okRef = useRef<HTMLButtonElement>(null)

  // Autofocus the natural target so Enter/typing work without a click (and steal focus from the
  // input proxy so its keydowns don't reach the page underneath).
  useEffect(() => {
    if (isPrompt) inputRef.current?.focus()
    else okRef.current?.focus()
  }, [isPrompt])

  const ok = (): void => onRespond(true, isPrompt ? text : undefined)
  const cancel = (): void => onRespond(false)

  const onKeyDown = (e: React.KeyboardEvent): void => {
    // Stop these from reaching the canvas/app shortcuts underneath; the dialog owns the keyboard.
    if (e.key === 'Enter') {
      e.preventDefault()
      e.stopPropagation()
      ok()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      cancel()
    }
  }

  return (
    <div
      className="bb-osr-dialog"
      role="dialog"
      aria-modal="true"
      onKeyDown={onKeyDown}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="bb-osr-origin">This page says</div>
      <div className="bb-osr-msg">{dialog.message || ' '}</div>
      {isPrompt && (
        <input
          ref={inputRef}
          className="bb-osr-input"
          value={text}
          spellCheck={false}
          onChange={(e) => setText(e.target.value)}
        />
      )}
      <div className="bb-osr-btns">
        {hasCancel && (
          <button className="bb-osr-btn" onClick={cancel} onMouseDown={(e) => e.stopPropagation()}>
            Cancel
          </button>
        )}
        <button
          ref={okRef}
          className="bb-osr-btn bb-osr-btn-primary"
          onClick={ok}
          onMouseDown={(e) => e.stopPropagation()}
        >
          OK
        </button>
      </div>
    </div>
  )
}
