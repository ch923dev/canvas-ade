/**
 * Pure async logic for the TerminalBoard "Preview" (globe) button.
 *
 * Extracted so the unit-test suite can import the real implementation instead
 * of maintaining a separate replica.  TerminalBoard.tsx wires this into the
 * `onPreview` callback, injecting its IPC and state-setter collaborators.
 */

export type DetectedUrl = { url: string; host: string; port: number }
export type Gesture = 'tap' | 'hold'

/**
 * Core detect-ports logic for the globe button.
 *
 * @param detectPorts    Calls the IPC channel (caller binds board.id).
 * @param setPreviewNote Updates the transient status note in the board.
 * @param routeUrl       Routes a resolved URL according to the gesture.
 * @param setPortChoices Shows the multi-server disambiguator picker.
 * @param gesture        Whether the button was tapped or long-pressed.
 */
export async function runDetectPorts(
  detectPorts: () => Promise<DetectedUrl[]>,
  setPreviewNote: (msg: string | null) => void,
  routeUrl: (url: string, gesture: Gesture) => void,
  setPortChoices: (v: { urls: DetectedUrl[]; gesture: Gesture } | null) => void,
  gesture: Gesture
): Promise<void> {
  setPreviewNote(null)
  let urls: DetectedUrl[]
  try {
    urls = await detectPorts()
  } catch {
    setPreviewNote("Couldn't detect a server — check the terminal, then try again.")
    return
  }
  if (urls.length === 0) {
    setPreviewNote('No dev server detected yet — start it, then try again.')
    return
  }
  if (urls.length === 1) {
    routeUrl(urls[0].url, gesture)
    return
  }
  setPortChoices({ urls, gesture }) // disambiguate the server first, then route by gesture
}
