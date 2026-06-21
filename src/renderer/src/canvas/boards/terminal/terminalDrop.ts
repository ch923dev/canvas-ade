// src/renderer/src/canvas/boards/terminal/terminalDrop.ts
/**
 * Turn dropped-file paths into a single quoted string to inject into the PTY via
 * term.paste. Empty paths are dropped — webUtils.getPathForFile returns '' for files
 * that aren't backed by a real OS path (e.g. a synthetic drag).
 *
 * FIND-007 (injection): a dropped path with an embedded newline/CR would, at a bare
 * (non-bracketed-paste) prompt, be SUBMITTED at the newline by xterm — the text after it then
 * runs as a shell command. An embedded double-quote (legal on Linux) would likewise close our
 * quoting and inject. Neither can be safely represented in a single double-quoted shell token
 * across shells (pwsh/cmd/bash escape quotes differently), so a path containing a CR, LF, or `"`
 * is DROPPED rather than pasted as attacker-controlled input. Normal paths — including the common
 * case of spaces in a path — are unaffected.
 */
const UNSAFE_PASTE_CHARS = /[\r\n"]/

export function quotePathsForPaste(paths: string[]): string {
  return paths
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .filter((p) => !UNSAFE_PASTE_CHARS.test(p))
    .map((p) => `"${p}" `)
    .join('')
}
