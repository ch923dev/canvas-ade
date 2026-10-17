/**
 * Shared Named-Group name sanitizer (spatial-awareness C7, G11). ONE rule for every place a group
 * name crosses a trust boundary: MAIN's `group_boards` / `edit_groups` / `spawn_group` handlers (the
 * agent-supplied names) and C3's `deriveContexts` (a suggested name built from board titles and cwd
 * basenames). It lives in `src/shared` because a shared module cannot import from `src/main`.
 *
 * Pure string logic: no Node / DOM / Electron imports, so it compiles under tsconfig.node and
 * tsconfig.web alike (the `boardTitle.ts` constraint).
 */

/**
 * Max length of a group name, in UTF-16 code units: the unit the package's zod `.max()` and the host
 * re-validators count, so a clamped name always passes them. Equals the host's
 * `SPAWN_GROUP_MAX_NAME` and the package's `GROUP_NAME_MAX`.
 */
export const GROUP_NAME_MAX = 80

/**
 * Invisible format characters that would let a name render differently from its logical text in a
 * confirm row (the Trojan Source class, same ranges as `dispatchSanitize.ts`): bidi embeddings and
 * overrides U+202A-U+202E, isolates U+2066-U+2069, LRM/RLM U+200E/U+200F, ALM U+061C, and the
 * zero-width characters U+200B-U+200D, U+2060 and U+FEFF.
 */
function isInvisibleFormat(code: number): boolean {
  return (
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069) ||
    code === 0x061c ||
    code === 0x2060 ||
    code === 0xfeff
  )
}

/** C0 controls, DEL and the C1 range (0x80-0x9F, the 8-bit CSI/OSC/NEL escape openers). */
function isControl(code: number): boolean {
  return code <= 0x1f || code === 0x7f || (code >= 0x80 && code <= 0x9f)
}

/**
 * Reduce a raw group name to a single-line, control-free, bidi-free label of at most
 * {@link GROUP_NAME_MAX} code units. Returns `''` when nothing usable remains; callers pick their own
 * fallback (MAIN rejects the row, `deriveContexts` falls through to its next name source).
 *
 * Per code point: invisible format characters are dropped; any whitespace (tab, newline, NBSP, LS/PS)
 * becomes a space, so `"a\nb"` reads `"a b"` and not `"ab"`; other controls are dropped; a lone
 * surrogate is dropped. Space runs then collapse to one, the result is trimmed, and it is clamped
 * without ever ending on half of a surrogate pair.
 */
export function sanitizeGroupName(raw: string): string {
  if (typeof raw !== 'string') return ''
  let out = ''
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 0
    if (isInvisibleFormat(code)) continue
    if (/\s/.test(ch)) {
      out += ' '
      continue
    }
    if (isControl(code)) continue
    // `for…of` yields a lone surrogate as its own one-unit string; a well-formed pair arrives whole.
    if (code >= 0xd800 && code <= 0xdfff) continue
    out += ch
  }
  return clampCodeUnits(out.replace(/ {2,}/g, ' ').trim(), GROUP_NAME_MAX)
}

/** Clamp to `max` UTF-16 code units, backing off one unit rather than split a surrogate pair. */
function clampCodeUnits(s: string, max: number): string {
  if (s.length <= max) return s
  let end = max
  const last = s.charCodeAt(end - 1)
  if (last >= 0xd800 && last <= 0xdbff) end -= 1
  return s.slice(0, end).trimEnd()
}
