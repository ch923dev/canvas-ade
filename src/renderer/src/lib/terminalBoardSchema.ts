/**
 * TerminalBoard per-field validation, extracted verbatim from boardSchema's assertBoard
 * terminal case (max-lines ratchet — the kanbanSchema precedent at the board-inspector epic
 * merge). Guards are INJECTED so this leaf module never imports back into boardSchema.
 * Shape checks only: free ids/strings (agentKind, themeId, fontFamilyId, openRouter.model)
 * are preserved verbatim and never rejected for being unknown (forward-compat, ADR 0007).
 */
export function assertTerminalContent(
  b: Record<string, unknown>,
  fail: (msg: string) => never,
  isRecord: (v: unknown) => v is Record<string, unknown>,
  isFiniteNum: (v: unknown) => v is number,
  isPositiveNum: (v: unknown) => v is number
): void {
  if (b.shell !== undefined && typeof b.shell !== 'string') fail('terminal shell is not a string')
  if (b.launchCommand !== undefined && typeof b.launchCommand !== 'string') {
    fail('terminal launchCommand is not a string')
  }
  if (b.cwd !== undefined && typeof b.cwd !== 'string') fail('terminal cwd is not a string')
  if (b.port !== undefined && !isFiniteNum(b.port)) fail('terminal port is not a number')
  if (b.agentSessionId !== undefined && typeof b.agentSessionId !== 'string') {
    fail('terminal agentSessionId is not a string')
  }
  if (b.agentTranscriptPath !== undefined && typeof b.agentTranscriptPath !== 'string') {
    fail('terminal agentTranscriptPath is not a string')
  }
  if (b.fontSize !== undefined && !isPositiveNum(b.fontSize)) {
    fail('terminal fontSize must be a positive number')
  }
  if (b.scrollback !== undefined && (!isFiniteNum(b.scrollback) || b.scrollback < 0)) {
    fail('terminal scrollback must be a non-negative number')
  }
  if (b.agentKind !== undefined && typeof b.agentKind !== 'string') {
    fail('terminal agentKind is not a string')
  }
  if (b.monitorActivity !== undefined && typeof b.monitorActivity !== 'boolean') {
    fail('terminal monitorActivity is not a boolean')
  }
  // v16 theming: type-check ONLY (do NOT reject an unknown id) — a future theme/font id
  // written by a newer build must not fail the whole doc. The id is preserved verbatim
  // and degrades to the default at render (terminalThemes.ts), per ADR 0007 forward-compat.
  if (b.themeId !== undefined && typeof b.themeId !== 'string') {
    fail('terminal themeId is not a string')
  }
  if (b.fontFamilyId !== undefined && typeof b.fontFamilyId !== 'string') {
    fail('terminal fontFamilyId is not a string')
  }
  // v20 openRouter: shape-check only — `enabled` must be a boolean when the object is
  // present; `model` is a free slug string (never an enum — OpenRouter's catalog drifts).
  if (b.openRouter !== undefined) {
    if (!isRecord(b.openRouter)) fail('terminal openRouter is not an object')
    const r = b.openRouter as { enabled?: unknown; model?: unknown }
    if (typeof r.enabled !== 'boolean') fail('terminal openRouter.enabled is not a boolean')
    if (r.model !== undefined && typeof r.model !== 'string') {
      fail('terminal openRouter.model is not a string')
    }
  }
}
