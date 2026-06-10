/**
 * First-run launchCommand hint pill (design-audit D2-B, 🎨 artifact signed off
 * 2026-06-11): one dismissible line bottom-left of a bare-shell terminal well —
 * "Set a launch command (e.g. `claude`) ⚙ ×". The text is the action (opens the
 * config popover); × dismisses app-wide forever (see terminalHint.ts). The parent
 * renders this only while `board.launchCommand` is empty, so setting a command
 * hides it without any state here. Styling: `.ca-term-hint` block in index.css
 * (raised surface, subtle border, accent gear — calm, no glow).
 */
import { useSyncExternalStore, type ReactElement } from 'react'
import { dismissHint, isHintDismissed, subscribeHint } from './hintDismissal'

export function TerminalHint({ onConfigure }: { onConfigure: () => void }): ReactElement | null {
  const dismissed = useSyncExternalStore(subscribeHint, isHintDismissed)
  if (dismissed) return null
  return (
    <div
      className="ca-term-hint nodrag"
      data-test="terminal-hint"
      // The well's mousedown focuses xterm + RF treats presses as drags — keep both away.
      onPointerDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <button type="button" className="ca-term-hint-action" onClick={onConfigure}>
        Set a launch command (e.g. <code>claude</code>){' '}
        <span className="ca-term-hint-gear" aria-hidden="true">
          ⚙
        </span>
      </button>
      <button
        type="button"
        className="ca-term-hint-dismiss"
        aria-label="Dismiss hint"
        data-test="terminal-hint-dismiss"
        onClick={dismissHint}
      >
        ×
      </button>
    </div>
  )
}
