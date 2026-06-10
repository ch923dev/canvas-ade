import type { Terminal } from '@xterm/xterm'

/**
 * Smart paste: if the clipboard holds an image, stage it to a temp file and inject the
 * quoted path; otherwise inject the clipboard text. Uses `term.paste` so multiline
 * content gets bracketed-paste markers when the agent enabled them (no per-line submit).
 * Driven directly by the decision-seam unit test (TerminalBoard.paste.test.ts).
 */
export async function pasteIntoTerminal(
  term: Terminal,
  boardId: string,
  /** Returns true while `term` is still the live terminal. Defaults to always-true
   *  for call sites (e.g. the context-menu) that already guard before calling.
   *  Pass `() => termRef.current === term` to catch disposal during the IPC await.
   */
  isLive: () => boolean = () => true
): Promise<void> {
  // Staging can fail (ENOSPC disk full, EPERM antivirus lock, read-only .canvas/tmp).
  // The IPC handler now returns null on those errors, but guard the await itself too
  // so any unexpected rejection falls through to the text-paste branch rather than
  // propagating to the `void` call site and silently dropping the paste entirely.
  let path: string | null = null
  try {
    path = await window.api.stageClipboardImage(boardId)
  } catch {
    path = null
  }
  if (!isLive()) return // term was disposed/replaced during the await
  if (path) {
    term.paste(`"${path}" `)
    return
  }
  const text = await window.api.clipboard.readText()
  if (isLive() && text) term.paste(text)
}
