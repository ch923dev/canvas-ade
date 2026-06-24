/**
 * Shared board-title sanitizer (2b). Used by BOTH the MAIN orchestrator (`mcpLifecycle.spawnBoard` —
 * the trust boundary) AND the renderer's defense-in-depth re-clamp (`useMcpCommands.applyMcpCommand`),
 * so the sanitization rule + the cap cannot drift across the IPC boundary (a forged command that
 * skips MAIN still gets the identical treatment in the renderer).
 *
 * Pure string logic — NO Node / DOM / Electron imports — so it compiles cleanly under tsconfig.node,
 * tsconfig.preload, and tsconfig.web alike (the same constraint the sibling `mcpTypes.ts` carries).
 */

/** Max chars (CODE POINTS) for an agent-supplied board title — a short canvas-chrome label. */
export const BOARD_TITLE_MAX = 80

/**
 * Sanitize an agent-supplied board title into a single-line, control-char-free, code-point-clamped
 * label — or `undefined` when nothing usable remains (the caller then uses the per-type default).
 *
 * Order matters: collapse whitespace runs to single spaces FIRST (a multi-line title would break the
 * board chrome and could push real content off-screen in a dispatch human-confirm body that embeds the
 * title), THEN strip C0/DEL/C1 control chars (an agent must not be able to slip control sequences into
 * a confirm the user is asked to authorize), then trim and clamp by CODE POINT — not UTF-16 code unit,
 * so a multi-code-unit char (emoji / surrogate pair) at the boundary isn't split into a lone surrogate.
 */
export function sanitizeBoardTitle(raw: string | undefined): string | undefined {
  if (typeof raw !== 'string') return undefined
  let out = ''
  for (const ch of raw.replace(/\s+/g, ' ')) {
    const code = ch.codePointAt(0) ?? 0
    // Strip C0 controls (incl. NUL/ESC; the whitespace collapse already turned tab/newline into a kept
    // 0x20 space), DEL (0x7F), and the C1 range (0x80-0x9F — the 8-bit CSI/OSC/NEL escape openers).
    if (code <= 0x1f || code === 0x7f || (code >= 0x80 && code <= 0x9f)) continue
    out += ch
  }
  out = [...out.trim()].slice(0, BOARD_TITLE_MAX).join('')
  return out.length > 0 ? out : undefined
}
