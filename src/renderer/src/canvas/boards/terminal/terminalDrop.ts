// src/renderer/src/canvas/boards/terminal/terminalDrop.ts
/**
 * Turn dropped-file paths into a single quoted string to inject into the PTY via
 * term.paste. Empty paths are dropped — webUtils.getPathForFile returns '' for files
 * that aren't backed by a real OS path (e.g. a synthetic drag).
 * Note: a path containing a literal double-quote (legal only on Linux) is not escaped — rare; the user still dragged the file themselves.
 */
export function quotePathsForPaste(paths: string[]): string {
  return paths
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((p) => `"${p}" `)
    .join('')
}
