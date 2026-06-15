import simpleGit from 'simple-git'

/**
 * 🔒 PR-2: read-only working-tree diff for a board, run via `simple-git` in MAIN.
 *
 * Resolves the board's resolved spawn cwd (injected `getCwd`, wired to pty.ts's
 * `getTerminalCwd` in index.ts) and returns the uncommitted changes there. `simple-git`
 * runs ONLY in MAIN (the locked rule) and this path is strictly READ-ONLY (diff). The
 * orchestrator owns board-resolution + terminal-check + the output bound (GITDIFF_MAX_BYTES);
 * this returns the raw diff, or '' when the board has no known cwd or its cwd is not a repo.
 *
 * `getCwd` is injected (not imported from pty.ts) so this module stays free of the
 * electron/node-pty import graph and unit-tests against a mocked `simple-git` in isolation.
 */
export async function boardGitDiff(
  id: string,
  getCwd: (id: string) => string | undefined
): Promise<string> {
  const cwd = getCwd(id)
  if (!cwd) return ''
  const git = simpleGit(cwd)
  if (!(await git.checkIsRepo())) return ''
  // Working tree vs HEAD captures staged + unstaged; fall back to the unstaged-only
  // diff when the repo has no commits yet (a `diff HEAD` would throw on a missing HEAD).
  try {
    return await git.diff(['HEAD'])
  } catch (err) {
    // Only the "no commits yet" case (HEAD is unresolvable) should fall back to the
    // unstaged-only diff. Any other failure (I/O, missing git binary, repo corruption) must
    // surface, not be masked by a second `diff()` that then throws an unrelated error.
    const msg = err instanceof Error ? err.message : String(err)
    if (/bad revision|unknown revision|ambiguous argument .?HEAD/i.test(msg)) {
      return await git.diff()
    }
    throw err
  }
}
