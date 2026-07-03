/**
 * Voice V4 — the dictation hotkey as data (SPEC §5 `hotkey`). Pure accelerator-string
 * parsing/matching so VoicePill's capture-phase listener can read a CONFIGURED chord
 * instead of the V3 hardcoded Ctrl/Cmd+Shift+M. Matching stays `e.code`-based (survives
 * keyboard layouts); the accelerator grammar is the small Electron-style subset the
 * Settings capture field can produce: modifiers + one key, joined by '+'.
 */

export interface HotkeyChord {
  /** KeyboardEvent.code of the non-modifier key (e.g. 'KeyM', 'Digit1', 'F9', 'Space'). */
  code: string
  ctrl: boolean
  shift: boolean
  alt: boolean
  meta: boolean
}

/** The V3 default, per platform ('Cmd' serializes the mac meta key). */
export function defaultHotkey(isMac: boolean): string {
  return isMac ? 'Cmd+Shift+M' : 'Ctrl+Shift+M'
}

/** Accelerator key token → KeyboardEvent.code (the reversible display subset). */
function tokenToCode(t: string): string | null {
  if (/^[A-Z]$/.test(t)) return `Key${t}`
  if (/^[0-9]$/.test(t)) return `Digit${t}`
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(t)) return t
  if (t === 'SPACE') return 'Space'
  return null
}

/** KeyboardEvent.code → accelerator key token (null = not representable). */
export function codeToToken(code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3)
  if (/^Digit[0-9]$/.test(code)) return code.slice(5)
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code
  if (code === 'Space') return 'SPACE'
  return null
}

/**
 * Parse an accelerator string into a chord. null = unusable (unknown key token, no key,
 * or no non-shift modifier — a bare letter must never hijack typing); callers fall back
 * to the platform default.
 */
export function parseHotkey(accel: string | undefined | null): HotkeyChord | null {
  if (!accel) return null
  const chord: HotkeyChord = { code: '', ctrl: false, shift: false, alt: false, meta: false }
  for (const raw of accel.split('+')) {
    const t = raw.trim().toUpperCase()
    if (t === 'CTRL' || t === 'CONTROL') chord.ctrl = true
    else if (t === 'SHIFT') chord.shift = true
    else if (t === 'ALT' || t === 'OPTION') chord.alt = true
    else if (t === 'CMD' || t === 'META' || t === 'SUPER' || t === 'WIN') chord.meta = true
    else {
      const code = tokenToCode(t)
      if (code === null || chord.code !== '') return null // unknown token / two keys
      chord.code = code
    }
  }
  if (chord.code === '') return null
  if (!chord.ctrl && !chord.alt && !chord.meta) return null
  return chord
}

/** Exact-modifier keydown match against a chord (`code`-based, layout-proof). */
export function matchesHotkey(
  e: Pick<KeyboardEvent, 'code' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey'>,
  chord: HotkeyChord
): boolean {
  return (
    e.code === chord.code &&
    e.ctrlKey === chord.ctrl &&
    e.shiftKey === chord.shift &&
    e.altKey === chord.alt &&
    e.metaKey === chord.meta
  )
}

/** Human label for tooltips ('Ctrl+Shift+M'); normalizes an already-valid accelerator. */
export function hotkeyLabel(chord: HotkeyChord, isMac: boolean): string {
  const parts: string[] = []
  if (chord.ctrl) parts.push('Ctrl')
  if (chord.alt) parts.push(isMac ? 'Option' : 'Alt')
  if (chord.shift) parts.push('Shift')
  if (chord.meta) parts.push(isMac ? 'Cmd' : 'Win')
  const token = codeToToken(chord.code)
  parts.push(token === 'SPACE' ? 'Space' : (token ?? chord.code))
  return parts.join('+')
}
