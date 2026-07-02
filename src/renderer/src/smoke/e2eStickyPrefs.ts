/**
 * e2e reset: sweep the STICKY localStorage UI prefs (persistent userData carries them
 * across specs AND runs — the self-ratchet class; see e2eHooks resetForNextTest).
 * Extracted from e2eHooks.ts (max-lines). Deliberately import-free: the file-font key is
 * a literal because importing it from fileBoardSyntax would drag the lazy ~2.5MB CodeMirror
 * chunk into the eager main bundle; the minimap key is passed in for the same reason.
 * All access guarded — storage unavailable means nothing sticky to clear.
 */
export function clearStickyLocalPrefs(minimapVisibleKey: string): void {
  // D4-C: the minimap island's sticky visibility key.
  try {
    window.localStorage.removeItem(minimapVisibleKey)
  } catch {
    // storage unavailable — nothing sticky to clear
  }
  // S3: the File-board viewer font — the A-/A+ steppers ratchet it across runs until
  // file.e2e's A+ assertion hits FILE_FONT_MAX.
  try {
    window.localStorage.removeItem('canvas-ade:file-font')
  } catch {
    // storage unavailable — nothing sticky to clear
  }
  // P5: inspector section collapse state (one key per section) — a spec that collapsed a
  // section would hide a later spec's inspector control. Sweep the whole prefix.
  try {
    const stale: string[] = []
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i)
      if (key?.startsWith('ca.inspector.collapse.')) stale.push(key)
    }
    for (const key of stale) window.localStorage.removeItem(key)
  } catch {
    // storage unavailable — nothing sticky to clear
  }
}
