import type { Board, BoardType, PlanningElement } from '../lib/boardSchema'
import { withSpecRevisions } from '../lib/specRevisions'

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
    'monitorActivity',
    // v16 (terminal theming, Lane B): the xterm colour-theme + font-family ids. Both
    // terminal-scoped + serialized; the dialog Apply patches them via updateBoard.
    'themeId',
    'fontFamilyId',
    // v20 (OpenRouter routing, compile-gated): the dialog Apply patches the whole
    // {enabled, model?} object — MUST be listed or the patch is silently dropped
    // (the PATCHABLE_KEYS-for-additive-field gotcha, see the kanban note below).
    'openRouter'
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
  dataflow: [...COMMON_KEYS, 'sourceBoardId'],
  // v17 kanban board (P4): the persisted plan body — ordered `columns` + the flat `cards` list. Both
  // are patched via updateBoard (human drag/edit in P4.2, MCP move_card/add_card in P3), so both MUST
  // be listed or the patch is silently dropped (the PATCHABLE_KEYS-for-additive-field gotcha). v19
  // adds the column-axis pair (`columnAxis`/`axisLabel`) — set by the board-header toggle. #346's
  // per-card `attachments` is a CARD field (like description/tags/fileRefs) — it rides inside the
  // whole-card `cards` patch, so it needs NO separate board-level key here.
  kanban: [...COMMON_KEYS, 'columns', 'cards', 'columnAxis', 'axisLabel'],
  // v23 swarm board (orchestration S1): no per-type persisted fields — run state is ephemeral
  // swarmStore state (scene/session split), never routed through a board patch.
  swarm: [...COMMON_KEYS]
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
    // v22 (B4): every planning-elements write flows through here — when the patch replaces an
    // expanse diagram's spec, capture the displaced spec onto the element's `revisions` (capped).
    // Undo/redo restores whole snapshots without this path, so replay never double-captures.
    if (b.type === 'planning' && safe.elements !== undefined) {
      safe.elements = withSpecRevisions(b.elements, safe.elements as PlanningElement[], Date.now())
    }
    changed = true
    return { ...b, ...safe } as Board
  })
  return changed ? next : null
}
