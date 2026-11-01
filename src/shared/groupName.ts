/**
 * Shared Named-Group name sanitizer (spatial-awareness C7, G11). ONE rule for every place a group
 * name crosses a trust boundary: MAIN's `group_boards` / `edit_groups` / `spawn_group` handlers (the
 * agent-supplied names) and C3's `deriveContexts` (a suggested name built from board titles and cwd
 * basenames). It lives in `src/shared` because a shared module cannot import from `src/main`.
 *
 * Pure string logic: no Node / DOM / Electron imports, so it compiles under tsconfig.node and
 * tsconfig.web alike (the `boardTitle.ts` constraint).
 */
import { isInvisibleCodePoint, ZWJ } from './invisibleChars'

/**
 * Max length of a group name, in UTF-16 code units: the unit the package's zod `.max()` and the host
 * re-validators count, so a clamped name always passes them. Equals the host's
 * `SPAWN_GROUP_MAX_NAME` and the package's `GROUP_NAME_MAX`.
 */
export const GROUP_NAME_MAX = 80

/** C0 controls, DEL and the C1 range (0x80-0x9F, the 8-bit CSI/OSC/NEL escape openers). */
function isControl(code: number): boolean {
  return code <= 0x1f || code === 0x7f || (code >= 0x80 && code <= 0x9f)
}

/**
 * Separators that read as a break between words: JS `\s` (tab, newline, NBSP, LS/PS, …) plus the
 * two it misses, NEL U+0085 and the information separators U+001C-U+001F.
 */
function isSpaceLike(ch: string, code: number): boolean {
  return /\s/.test(ch) || code === 0x85 || (code >= 0x1c && code <= 0x1f)
}

/** A code point a reader can see: a letter, number, punctuation or symbol (emoji are symbols). */
const VISIBLE = /[\p{L}\p{N}\p{P}\p{S}]/u
/** May sit BEFORE a kept ZWJ: a pictograph, or the skin-tone modifier that follows one. */
const ZWJ_LEFT = /^[\p{Extended_Pictographic}\p{Emoji_Modifier}]$/u
/** May sit AFTER a kept ZWJ. */
const ZWJ_RIGHT = /^\p{Extended_Pictographic}$/u

/**
 * Reduce a raw group name to a single-line, control-free, invisible-free label of at most
 * {@link GROUP_NAME_MAX} code units. Returns `''` when nothing usable remains — no letter, number,
 * punctuation or symbol survives — so a name that would render as blank (`"️"`, a lone
 * combining mark) never reaches a confirm row; callers pick their own fallback (MAIN rejects the
 * row, `deriveContexts` falls through to its next name source).
 *
 * Per code point: invisible code points (`invisibleChars.ts`: bidi, zero-width, variation selectors,
 * tag characters, soft hyphen, …) are dropped; any separator (tab, newline, NBSP, LS/PS, NEL,
 * U+001C-U+001F) becomes a space, so `"a\nb"` reads `"a b"` and not `"ab"`; other controls are
 * dropped; a lone surrogate is dropped. Space runs then collapse to one, the result is trimmed, and
 * it is clamped by whole code points, so a surrogate pair is never split.
 *
 * The one invisible kept is a ZWJ BETWEEN two emoji (`👨‍💻`), where it only joins two visible
 * pictographs into one glyph and can hide nothing. Elsewhere it is dropped. The strip is lossy for
 * emoji that need a dropped selector: `❤️` loses its U+FE0F (it may render as text-style `❤`), and
 * a subdivision flag (`🏴` + tag characters) degrades to a plain `🏴`.
 */
export function sanitizeGroupName(raw: string): string {
  if (typeof raw !== 'string') return ''
  const kept: string[] = []
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 0
    if (ch !== ZWJ && isInvisibleCodePoint(ch)) continue
    if (isSpaceLike(ch, code)) {
      kept.push(' ')
      continue
    }
    if (isControl(code)) continue
    // `for…of` yields a lone surrogate as its own one-unit string; a well-formed pair arrives whole.
    if (code >= 0xd800 && code <= 0xdfff) continue
    kept.push(ch)
  }
  const joined = kept
    .filter(
      (ch, i) =>
        ch !== ZWJ || (ZWJ_LEFT.test(kept[i - 1] ?? '') && ZWJ_RIGHT.test(kept[i + 1] ?? ''))
    )
    .join('')
  const out = clampCodePoints(joined.replace(/ {2,}/g, ' ').trim(), GROUP_NAME_MAX)
  return VISIBLE.test(out) ? out : ''
}

/**
 * Clamp to `max` UTF-16 code units by taking WHOLE code points, so a surrogate pair is never split.
 * A ZWJ the cut leaves dangling at the end (its right-hand emoji fell off) is dropped too.
 */
function clampCodePoints(s: string, max: number): string {
  if (s.length <= max) return s
  let out = ''
  for (const ch of s) {
    if (out.length + ch.length > max) break
    out += ch
  }
  return out.replace(/‍+$/u, '').trimEnd()
}
