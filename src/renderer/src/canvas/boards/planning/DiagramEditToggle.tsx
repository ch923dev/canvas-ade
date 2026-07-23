/**
 * Focus-mode entry toggle (diagram Phase 4) — the header `✎ Edit` / `✓ Done` button on an
 * `engine:'expanse'` diagram card. Extracted from DiagramCard to hold its line ratchet (the kickoff
 * "keep extracting, don't grow the file" discipline). Mermaid cards never render this (the
 * zero-source-edit pin stands).
 */
import type { ReactElement } from 'react'

export function DiagramEditToggle({
  editing,
  onToggle
}: {
  editing: boolean
  onToggle: () => void
}): ReactElement {
  return (
    <button
      type="button"
      title={editing ? 'Done editing' : 'Edit diagram'}
      onPointerDown={(e) => e.stopPropagation()}
      // A press inside the editor's inline <input> would blur→commit first; keep the toggle press
      // from stealing focus so a single click reads the correct state (the </> lesson).
      onMouseDown={(e) => e.preventDefault()}
      onClick={(e) => {
        e.stopPropagation()
        onToggle()
      }}
      style={{
        all: 'unset',
        cursor: 'pointer',
        padding: '1px 6px',
        borderRadius: 4,
        fontFamily: 'var(--ui)',
        fontWeight: 500,
        color: editing ? 'var(--accent)' : 'var(--text-3)'
      }}
    >
      {editing ? '✓ Done' : '✎ Edit'}
    </button>
  )
}
