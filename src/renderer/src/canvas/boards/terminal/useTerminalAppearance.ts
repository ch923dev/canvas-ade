/**
 * Live appearance apply for the DOM-renderer terminal (terminal theming, Lane B). A themeId /
 * fontFamilyId change (the Configure dialog's Appearance tab) is reconciled onto the LIVE term with
 * NO respawn — the ids are read via refs in useTerminalSpawn, so they are never spawn deps.
 * Construction sets the INITIAL palette/font; this hook applies SUBSEQUENT changes:
 *  - Theme: `term.options.theme = {…fresh}`. xterm REF-compares the theme object, so a NEW object is
 *    mandatory (mutating in place is a no-op). No fit — colours don't change cell metrics.
 *  - Font family: swap the literal stack, then re-fit (whole-cell, clip-free) — the new glyph width
 *    changes cell metrics, the same reflow path a font-SIZE change takes. Guarded so a no-op write
 *    never triggers a spurious fit.
 * An UNPINNED board (id absent) falls back to the id it was BORN with (the sticky last-used frozen at
 * mount, mirroring bornFont); an unknown id degrades to the default inside the resolvers. Extracted
 * from TerminalBoard to keep the host under the max-lines ratchet.
 */
import { useEffect, useState, type RefObject } from 'react'
import type { Terminal } from '@xterm/xterm'
import {
  terminalThemeColors,
  resolveTerminalFontFamily,
  resolveInitialThemeId,
  resolveInitialFontFamilyId
} from './terminalThemes'

export interface TerminalAppearanceDeps {
  /** The board's persisted theme id (board.themeId) — undefined ⇒ unpinned. */
  themeId: string | undefined
  /** The board's persisted font-family id (board.fontFamilyId) — undefined ⇒ unpinned. */
  fontFamilyId: string | undefined
  termRef: RefObject<Terminal | null>
  fitWhole: () => void
}

export function useTerminalAppearance(deps: TerminalAppearanceDeps): void {
  const { themeId, fontFamilyId, termRef, fitWhole } = deps
  // The ids this board was BORN with (the sticky last-used at mount, then frozen) — the unpinned
  // fallback (mirrors TerminalBoard's bornFont). A KNOWN id, so the resolvers map it directly.
  const [bornThemeId] = useState<string>(() => resolveInitialThemeId(themeId))
  const [bornFontFamilyId] = useState<string>(() => resolveInitialFontFamilyId(fontFamilyId))

  // Live theme apply — repaint the ANSI palette on the same term (no respawn, no fit). Guarded by
  // the background hex (a per-theme discriminator) so the mount-time run — where construction already
  // applied this exact theme — is a no-op: assigning a fresh object would force a full xterm
  // re-render on every terminal mount for nothing. xterm REF-compares, so a real change DOES assign a
  // NEW object (the spread).
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    const next = terminalThemeColors(themeId ?? bornThemeId)
    if (term.options.theme?.background !== next.background) {
      term.options.theme = { ...next }
    }
  }, [themeId, bornThemeId, termRef])

  // Live font-family apply — swap the typeface, then re-fit (cell metrics changed).
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    const family = resolveTerminalFontFamily(fontFamilyId ?? bornFontFamilyId)
    if (term.options.fontFamily !== family) {
      term.options.fontFamily = family
      fitWhole()
    }
  }, [fontFamilyId, bornFontFamilyId, termRef, fitWhole])
}
