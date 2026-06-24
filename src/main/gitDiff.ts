import simpleGit, { type SimpleGit } from 'simple-git'
import { repoScopedEnv } from './gitEnv'

/**
 * 🔒 PR-2: read-only working-tree diff for a board, run via `simple-git` in MAIN.
 *
 * Resolves the board's resolved spawn cwd (injected `getCwd`, wired to pty.ts's
 * `getTerminalCwd` in index.ts) and returns the uncommitted changes there. `simple-git`
 * runs ONLY in MAIN (the locked rule) and this path is strictly READ-ONLY (diff +
 * ls-files + diff --no-index; never `git add`/`add -N`/commit/checkout/reset). The
 * orchestrator owns board-resolution + terminal-check + the downstream output bound
 * (GITDIFF_MAX_BYTES); this returns the raw diff, or '' when the board has no known cwd
 * or its cwd is not a repo.
 *
 * `getCwd` is injected (not imported from pty.ts) so this module stays free of the
 * electron/node-pty import graph and unit-tests against a mocked `simple-git` in isolation.
 *
 * GAP-001: `git diff HEAD` reports TRACKED changes only. A file the agent created but
 * never staged is untracked → invisible. We additionally enumerate untracked, non-ignored
 * files (`git ls-files --others --exclude-standard`) and synthesize a new-file diff for
 * each via the read-only `git diff --no-index /dev/null <file>` (binary files emit a
 * `Binary files … differ` line). These are appended AFTER the tracked diff.
 *
 * GAP-002 / GAP-007: `simple-git` streams stdout into memory with no cap and no timeout,
 * so a large/hostile working tree or a hung git (locked repo, network FS, credential
 * prompt) could spike/OOM MAIN or pin the task forever. We bound the TOTAL bytes read
 * across all sub-commands (GITDIFF_MAX_READ_BYTES) by tapping the live stdout stream and
 * aborting the moment the budget is exhausted, and we cap wall time with the timeout
 * plugin. On hitting the byte bound OR the timeout we return what was read so far
 * (best-effort) — we do NOT throw for size/timeout. A genuine non-HEAD git error
 * (I/O, missing binary, corruption) is still re-thrown.
 */

/**
 * Total bytes `boardGitDiff` will hold in MAIN at once, across the tracked diff plus every
 * synthesized untracked diff. A few× the orchestrator's 100 KB downstream payload cap so a
 * truncation here is invisible to a normal diff but a multi-GB hostile tree can never
 * materialize in the privileged process.
 */
export const GITDIFF_MAX_READ_BYTES = 1_000_000

/** Block-timeout (ms) for any single git sub-process: it is force-killed if it neither
 *  exits nor emits stdout/stderr for this long (hung repo, credential prompt, network FS). */
export const GITDIFF_TIMEOUT_MS = 15_000

/**
 * A single capped byte sink shared across every git sub-command of one `boardGitDiff` call.
 * It taps each child process' live `stdout`, captures up to a GLOBAL budget (across all
 * sub-commands), and the instant that budget is exhausted it signals (`onExhausted`) so the
 * caller can abort the in-flight process — keeping MAIN's resident memory at ~the cap rather
 * than the full (possibly multi-GB) output. Per-command output is recovered by recording a
 * mark before a command and slicing from it afterward.
 */
class CappedSink {
  private chunks: Buffer[] = []
  private used = 0
  exhausted = false

  constructor(
    private readonly max: number,
    private readonly onExhausted: () => void
  ) {}

  /** A mark for {@link sliceFrom}: the byte offset captured so far. */
  mark(): number {
    return this.used
  }

  /** The bytes captured since `from`, decoded as UTF-8 — i.e. one sub-command's output. */
  sliceFrom(from: number): string {
    return Buffer.concat(this.chunks).subarray(from).toString('utf8')
  }

  /** Tap a freshly spawned child's stdout into the sink, dropping anything past the budget. */
  tap(stdout: NodeJS.ReadableStream): void {
    stdout.on('data', (chunk: Buffer) => {
      if (this.exhausted) return
      const remaining = this.max - this.used
      if (remaining <= 0) {
        this.exhausted = true
        this.onExhausted()
        return
      }
      const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk
      this.chunks.push(slice)
      this.used += slice.length
      if (this.used >= this.max) {
        this.exhausted = true
        this.onExhausted()
      }
    })
  }
}

/** True for the `simple-git` plugin errors we induce (byte-budget abort) or that the
 *  timeout plugin raises — both are "stop, return best-effort", never a real failure. */
function isBoundError(err: unknown): boolean {
  const plugin = (err as { plugin?: unknown } | null)?.plugin
  return plugin === 'abort' || plugin === 'timeout'
}

export async function boardGitDiff(
  id: string,
  getCwd: (id: string) => string | undefined
): Promise<string> {
  const cwd = getCwd(id)
  if (!cwd) return ''

  // One AbortController + one shared byte budget for the whole call. The sink aborts the
  // in-flight git child the moment the global budget is spent; the timeout plugin kills any
  // child that stalls. Both surface as `isBoundError` rejections we swallow (best-effort).
  const controller = new AbortController()
  const sink = new CappedSink(GITDIFF_MAX_READ_BYTES, () => controller.abort())
  // `.env(repoScopedEnv())` pins resolution to `cwd` by stripping inherited GIT_DIR/GIT_WORK_TREE/…
  // (see ./gitEnv) — without it, a gitDiff run under a git hook (pre-push) or any shell that
  // exported those vars escapes into the host repo instead of the board's repo.
  const git: SimpleGit = simpleGit(cwd, {
    abort: controller.signal,
    timeout: { block: GITDIFF_TIMEOUT_MS }
  }).env(repoScopedEnv())

  if (!(await git.checkIsRepo())) return ''

  // Run one git sub-command with its stdout tapped into the shared sink for the byte bound.
  //
  // On a clean resolve we return simple-git's parsed string: a resolve only happens when the
  // process finished WITHOUT being aborted, i.e. when its output stayed within the global
  // budget — so the resolved string and the captured bytes are equivalent (both ≤ the cap),
  // and the downstream orchestrator clamp catches any final-chunk overshoot.
  //
  // On a rejection we fall back to the bytes captured so far when it is a bound error
  // (budget/timeout — best-effort, never throw) or a `tolerateExit` command. `tolerateExit`
  // is for `git diff --no-index`, which exits non-zero whenever the files differ (always, vs
  // /dev/null) — there the captured stdout *is* the diff. Any OTHER rejection propagates, so
  // a genuine I/O / missing-binary / corruption error is never masked.
  const run = async (
    exec: (g: SimpleGit) => Promise<unknown>,
    { tolerateExit = false }: { tolerateExit?: boolean } = {}
  ): Promise<string> => {
    const from = sink.mark()
    git.outputHandler((_cmd, stdout) => sink.tap(stdout))
    try {
      const resolved = await exec(git)
      return typeof resolved === 'string' ? resolved : sink.sliceFrom(from)
    } catch (err) {
      if (isBoundError(err) || tolerateExit) return sink.sliceFrom(from)
      throw err
    } finally {
      git.outputHandler(undefined)
    }
  }

  // --- Tracked changes vs HEAD (staged + unstaged), with the no-commits-yet fallback. ---
  let tracked: string
  try {
    tracked = await run((g) => g.diff(['HEAD']))
  } catch (err) {
    // Only the "no commits yet" case (HEAD is unresolvable) should fall back to the
    // unstaged-only diff. Any other failure (I/O, missing git binary, repo corruption) must
    // surface, not be masked by a second `diff()` that then throws an unrelated error.
    const msg = err instanceof Error ? err.message : String(err)
    if (/bad revision|unknown revision|ambiguous argument .?HEAD/i.test(msg)) {
      tracked = await run((g) => g.diff())
    } else {
      throw err
    }
  }

  // Budget already spent on the tracked diff → return it; don't start untracked work that
  // would immediately abort. (controller is aborted, so further spawns would reject anyway.)
  if (sink.exhausted || controller.signal.aborted) return tracked

  // --- Untracked, non-ignored files: synthesize a new-file diff per file (GAP-001). ---
  // `git diff HEAD` never reports these (and an unstaged rename shows only its deletion half).
  // ls-files lists them; `diff --no-index /dev/null <file>` renders each as an addition — a
  // strictly read-only mechanism (NEVER `git add`/`add -N`, which would mutate the index).
  let untrackedList = ''
  try {
    untrackedList = await run((g) => g.raw(['ls-files', '--others', '--exclude-standard', '-z']))
  } catch {
    // ls-files is informational only — a failure (or an unexpected non-bound error) must not
    // mask the tracked diff we already hold, so degrade gracefully to tracked-only.
    untrackedList = ''
  }

  // `-z` → NUL-separated, no quoting/escaping of unusual paths (spaces, newlines, unicode).
  const untrackedFiles = untrackedList.split('\0').filter((p) => p.length > 0)
  const parts: string[] = []
  for (const file of untrackedFiles) {
    if (sink.exhausted || controller.signal.aborted) break
    try {
      // `--no-index` against the null device renders the file as a brand-new addition
      // (`new file mode`), and a binary file as `Binary files /dev/null and b/<file> differ`.
      // It exits non-zero whenever the files differ (always here) → tolerateExit.
      const part = await run((g) => g.raw(['diff', '--no-index', '--', '/dev/null', file]), {
        tolerateExit: true
      })
      if (part) parts.push(part)
    } catch (err) {
      // A bound error stops the loop on the next iteration's guard; any other unexpected
      // failure for a single file is skipped rather than failing the whole diff.
      if (isBoundError(err)) break
    }
  }

  // Concatenate untracked diffs AFTER the tracked diff. The orchestrator applies the
  // downstream byte clamp; the global read budget is what actually protects MAIN memory.
  return tracked + parts.join('')
}
