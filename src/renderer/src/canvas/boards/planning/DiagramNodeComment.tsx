/**
 * Node-comment composer (diagram Phase 4, T3) — a floating panel in the focus-mode editor that asks
 * the owning agent about a node. Pick a live Terminal board (last target remembered per diagram for
 * the session) and Send routes the comment + node context as a prompt over the terminal-input relay
 * (diagramCommentRelay). It is an ACTION — nothing is written to the diagram spec.
 */
import { useMemo, useState, type ReactElement } from 'react'
import type { SpecNode } from '../../../lib/diagramSpec'
import { useCanvasStore } from '../../../store/canvasStore'
import { useTerminalRuntimeStore } from '../../../store/terminalRuntimeStore'
import { composeNodeComment, sendNodeComment } from './diagramCommentRelay'

/** Last-used terminal target per diagram element id — session memory (never persisted). */
const lastTarget = new Map<string, string>()

export function DiagramNodeComment({
  node,
  diagramId,
  onClose
}: {
  node: SpecNode
  diagramId: string
  onClose: () => void
}): ReactElement {
  const terminals = useCanvasStore((s) =>
    s.boards.filter((b) => b.type === 'terminal').map((b) => ({ id: b.id, title: b.title }))
  )
  const running = useTerminalRuntimeStore((s) => s.running)
  const runningTerminals = useMemo(
    () => terminals.filter((t) => running[t.id]),
    [terminals, running]
  )

  const remembered = lastTarget.get(diagramId)
  const initialTarget =
    remembered && running[remembered] ? remembered : (runningTerminals[0]?.id ?? '')
  const [target, setTarget] = useState(initialTarget)
  const [comment, setComment] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)

  const canSend = target !== '' && !!running[target] && comment.trim().length > 0 && !sending

  const send = async (): Promise<void> => {
    if (!canSend) return
    setSending(true)
    setError(null)
    const ok = await sendNodeComment(target, composeNodeComment(node, comment))
    setSending(false)
    if (ok) {
      lastTarget.set(diagramId, target)
      onClose()
    } else {
      setError('That terminal is no longer running — pick another.')
    }
  }

  return (
    <div
      className="pl-editor-comment nodrag nowheel nopan"
      onPointerDown={(e) => e.stopPropagation()}
      style={{
        position: 'absolute',
        right: 10,
        bottom: 10,
        zIndex: 5,
        width: 268,
        padding: 10,
        background: 'var(--surface-overlay)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--r-board)',
        boxShadow: 'var(--shadow-pop)',
        display: 'flex',
        flexDirection: 'column',
        gap: 8
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ font: '500 11px/16px var(--ui)', color: 'var(--text-2)' }}>
          💬 Comment on
        </span>
        <span
          style={{
            font: '450 10px/16px var(--mono)',
            color: 'var(--accent)',
            background: 'var(--accent-wash)',
            borderRadius: 4,
            padding: '0 5px'
          }}
        >
          {node.label}
        </span>
      </div>

      <textarea
        autoFocus
        value={comment}
        placeholder="Ask the agent about this node…"
        onChange={(e) => setComment(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Escape') onClose()
          else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void send()
        }}
        style={{
          minHeight: 52,
          resize: 'none',
          border: '1px solid var(--border)',
          borderRadius: 'var(--r-inner)',
          outline: 'none',
          background: 'var(--inset)',
          color: 'var(--text)',
          font: '400 12px/17px var(--ui)',
          padding: '7px 8px'
        }}
      />

      <label
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          font: '450 11px/16px var(--mono)',
          color: 'var(--text-3)'
        }}
      >
        route to
        <select
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          onKeyDown={(e) => e.stopPropagation()}
          style={{
            flex: 1,
            background: 'var(--surface-raised)',
            color: 'var(--text-2)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--r-ctl)',
            padding: '3px 6px',
            font: '500 11px var(--ui)'
          }}
        >
          {runningTerminals.length === 0 && <option value="">no running terminal</option>}
          {runningTerminals.map((t) => (
            <option key={t.id} value={t.id}>
              {t.title}
            </option>
          ))}
        </select>
      </label>

      {error && <span style={{ font: '400 11px var(--ui)', color: 'var(--err)' }}>{error}</span>}

      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ flex: 1, font: '400 10px/14px var(--ui)', color: 'var(--text-faint)' }}>
          Sends as a prompt (⌘/Ctrl+Enter). Nothing is written to the diagram.
        </span>
        <button
          type="button"
          onClick={onClose}
          style={{
            all: 'unset',
            cursor: 'pointer',
            font: '500 11px var(--ui)',
            color: 'var(--text-3)',
            padding: '3px 6px'
          }}
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={!canSend}
          onClick={() => void send()}
          style={{
            all: 'unset',
            cursor: canSend ? 'pointer' : 'default',
            font: '600 11px var(--ui)',
            color: canSend ? 'var(--void)' : 'var(--text-faint)',
            background: canSend ? 'var(--accent)' : 'var(--surface-raised)',
            borderRadius: 'var(--r-ctl)',
            padding: '4px 11px'
          }}
        >
          Send
        </button>
      </div>
    </div>
  )
}
