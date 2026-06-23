import type { Board, BoardType } from '../lib/boardSchema'

/**
 * Patch keys a board of each type may accept — id/type are never patchable, and an
 * off-type field (e.g. `url`) must never land on a board it doesn't belong to (that
 * would forge a cross-type hybrid the discriminated union forbids). The common,
 * geometry/title keys are mergeable on every type.
 *
 * SCENE/SESSION CONTRACT: never add an ephemeral key here (selected tool/element,
 * in-flight draft/erase, hover). Those stay in component/Zustand session state and
 * are never serialized — see boardSchema.toObject.
 */
const COMMON_KEYS = ['x', 'y', 'w', 'h', 'title', 'z'] as const
const PATCHABLE_KEYS: Record<BoardType, readonly string[]> = {
  // `agentSessionId`/`agentTranscriptPath` are terminal-only app-learned fields the
  // recap hook (`recap:learned`) patches onto a board so its recap survives reload —
  // they round-trip through toObject like any other terminal prop, so they belong here.
  terminal: [
    ...COMMON_KEYS,
    'shell',
    'launchCommand',
    'cwd',
    'port',
    'agentSessionId',
    'agentTranscriptPath',
    'fontSize',
    'scrollback',
    // v10 (New Terminal presets): the chosen agent identity + whether the board joins
    // activity monitoring (MCP attention/swarm). Both terminal-scoped + serialized.
    'agentKind',
    'monitorActivity'
  ],
  browser: [...COMMON_KEYS, 'url', 'viewport', 'previewSourceId'],
  planning: [...COMMON_KEYS, 'elements'],
  // The Command board persists no per-type fields (its task queue is ephemeral commandStore
  // state) — only the common geometry/title keys are patchable (e.g. the collapse height swap).
  command: [...COMMON_KEYS],
  // v13 file board (file-tree S1): bound relative path + read-only flag; content never persisted.
  file: [...COMMON_KEYS, 'path', 'readOnly'],
  // v14 dataflow board (JD-4): only the Browser-board binding is persisted — the inferred model is
  // ephemeral dataFlowStore state, never serialized (ADR 0010).
  dataflow: [...COMMON_KEYS, 'sourceBoardId']
}

/**
 * Apply a type-filtered shallow patch to one board. Returns the new boards array, or
 * null when nothing actually changed (unknown id, only off-type keys, or identical
 * values) so callers can no-op without minting a new ref. Shared by `updateBoard`
 * (tracked-edit semantics) and `patchBoardUntracked` (history-neutral machine writes).
 */
export function applyBoardPatch(
  boards: Board[],
  id: string,
  patch: Partial<Board>
): Board[] | null {
  const src = patch as Record<string, unknown>
  let changed = false
  const next = boards.map((b) => {
    if (b.id !== id) return b
    const allowed = PATCHABLE_KEYS[b.type]
    const safe: Record<string, unknown> = {}
    let diff = false
    for (const key of allowed) {
      if (key in src) {
        safe[key] = src[key]
        // Reference/value compare: a patch re-applying identical values must NOT
        // mint a new boards ref or clear the redo branch (STATE-2). New-array refs
        // (e.g. elements) on a real edit still differ, so genuine edits register.
        if ((b as unknown as Record<string, unknown>)[key] !== src[key]) diff = true
      }
    }
    if (!diff) return b
    changed = true
    return { ...b, ...safe } as Board
  })
  return changed ? next : null
}
