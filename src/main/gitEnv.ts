/**
 * Build the environment for a READ-ONLY git sub-process run via `simple-git` in MAIN, by stripping
 * EVERY `GIT_*` variable from a clone of MAIN's environment. Shared by every MAIN git seam
 * (`boardGitDiff`, `file:gitPermalink`, …). Two problems, one sweep:
 *
 *  1. HOST-REPO ESCAPE (the bug this fixes). `GIT_DIR`/`GIT_WORK_TREE` (+ `GIT_INDEX_FILE`,
 *     `GIT_COMMON_DIR`, `GIT_CEILING_DIRECTORIES`, …) override git's directory discovery, so when
 *     present they pin git to THAT repo regardless of the spawn path. Git exports them into the
 *     environment of any process it runs as a HOOK — our `.githooks/pre-push` e2e gate runs with
 *     `GIT_DIR` set to the HOST repo — and `e2e/fixtures.ts` forwards `process.env` verbatim into
 *     the Electron app. Without scrubbing, a git seam keyed on directory A silently resolved repo
 *     B's (the host worktree's) data: `boardGitDiff` returned the host diff (passed in Docker/CI,
 *     run directly with no git-hook env, but false-failed the worktree pre-push gate), and
 *     `file:gitPermalink`'s `--show-toplevel`/HEAD/origin would resolve onto the ambient repo →
 *     a permalink pointing at the wrong repository.
 *
 *  2. simple-git's safety net. The moment we pass an EXPLICIT env object, simple-git inspects it
 *     and REFUSES to spawn if it carries a dangerous git var (GIT_EDITOR, GIT_SSH, GIT_PAGER,
 *     GIT_ASKPASS, GIT_EXTERNAL_DIFF, …) unless the matching `allowUnsafe*` flag is set — and we
 *     will not enable those flags (that would weaken the model).
 *
 * Clearing the whole `GIT_*` prefix is the robust fix for (1) and the simplest way to satisfy (2)
 * without version-coupling to simple-git's block-list. It is also strictly SAFER than the default
 * `env: undefined` path (which let git inherit GIT_SSH/GIT_EDITOR/… unchecked): a read-only git
 * read needs nothing from the GIT_* namespace — the repo comes from the path, config from the
 * normal config files. Stripping (vs. pinning a discovery ceiling) keeps normal discovery intact:
 * a directory that is a SUBDIR of a repo still walks up to the real repo root. This never weakens
 * the MAIN-only / frame-guarded model. `simple-git`'s `.env(obj)` REPLACES the child env (it does
 * NOT merge with process.env), so we clone first, then delete.
 */
export function repoScopedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const key of Object.keys(env)) {
    if (/^GIT_/i.test(key)) delete env[key]
  }
  // Belt-and-suspenders for the now-GIT_*-free env: never block on an interactive credential
  // prompt (these reads are local + read-only, but a misconfigured repo shouldn't pin the call).
  // Not one of simple-git's flagged vars, so it never trips the spawn check.
  env.GIT_TERMINAL_PROMPT = '0'
  return env
}
