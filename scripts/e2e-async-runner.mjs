#!/usr/bin/env node
// e2e async runner — the FULL matrix (Windows leg then Linux Docker leg), OFF the
// blocking path ("smoke blocks / matrix async", 2026-07-31; docs/testing/TESTING.md).
//
// MANUAL-ONLY (user decision 2026-07-31): nothing launches this automatically.
// Run it DETACHED via `make e2e-async` or `signal-merge.ps1 -E2E`, or directly
// (`node scripts/e2e-async-runner.mjs`). Node (not pwsh) on purpose: the e2e
// suite's own specs taskkill pwsh shells mid-run, which killed earlier
// pwsh-based instrumentation.
//
// What it does, in order:
//   1. single-instance lock (.worktrees/e2e-async-runner.lock; stale-PID takeover)
//   2. snapshot: checks out the target sha into the dedicated worktree
//      .worktrees/e2e-async-runner (created on first run; node_modules junctioned
//      from MAIN like every coordinated worktree) — so foreground builds in MAIN
//      or feature worktrees can NEVER clobber this run's out/ or test-results/.
//      KNOWN HAZARD (accepted): the junction shares MAIN's node_modules — a
//      `pnpm install` in MAIN mid-run voids the run (shows as RED; rerun).
//   3. Windows leg (E2E_PRECOMMIT=1, E2E_WORKERS=1 — merge-gate semantics), then
//      the Linux Docker leg. SEQUENTIAL — concurrent legs are a documented
//      false-red. Exit codes are read from the child directly, never through a
//      pipe (a `| tail` masked a red leg once; never again).
//   4. verdict → .claude/coordination/e2e-async/last-result.json + a per-run log
//      + one line in history.log + an OS toast (GREEN / RED / INCOMPLETE).
//
// Verdicts: GREEN = both legs exit 0 · RED = any leg failed · INCOMPLETE = the
// Linux leg was skipped (Docker daemon down) — treat INCOMPLETE like RED for the
// merge ritual: the missing leg is exactly the one that catches what Windows hides.
//
// Usage: node scripts/e2e-async-runner.mjs [--sha <sha>] [--skip-linux]
//   --sha defaults to origin/main after a fetch.

import { spawn, spawnSync } from 'node:child_process'
import {
  appendFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))

function git(args, opts = {}) {
  const r = spawnSync('git', args, { encoding: 'utf8', ...opts })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed:\n${r.stderr || r.stdout}`)
  return (r.stdout ?? '').trim()
}

// MAIN repo root — resolved from git so this works from MAIN or any worktree and
// survives a folder rename (same pattern as new-worktree.ps1 / signal-merge.ps1).
const mainRoot = dirname(
  git(['-C', scriptDir, 'rev-parse', '--path-format=absolute', '--git-common-dir'])
)

// ---- args -------------------------------------------------------------------
const argv = process.argv.slice(2)
let sha = ''
let skipLinux = false
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--sha') sha = argv[++i] ?? ''
  else if (argv[i] === '--skip-linux') skipLinux = true
}

// ---- single-instance lock (atomic) ------------------------------------------
// Acquisition is a single O_EXCL create (`flag: 'wx'`) — no check-then-act window
// (PR #411 review [warning] + CodeQL js/file-system-race: the old existsSync →
// liveness → writeFileSync sequence let two near-simultaneous launches both pass
// the check and share the worktree). On EEXIST: liveness-check the recorded pid;
// a stale (dead-pid) lock is removed and acquisition retried ONCE — losing that
// re-acquire race means another live runner owns it, which is the SKIPPED case.
// The lock is taken BEFORE sha resolution so the loser exits without doing any
// git work; the sha is stamped into the lock right after it resolves.
const lockPath = join(mainRoot, '.worktrees', 'e2e-async-runner.lock')
mkdirSync(dirname(lockPath), { recursive: true })
function tryAcquireLock() {
  try {
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: process.pid, sha: '', startedAt: new Date().toISOString() }),
      { flag: 'wx' }
    )
    return true
  } catch (e) {
    if (e?.code === 'EEXIST') return false
    throw e
  }
}
if (!tryAcquireLock()) {
  let holder = null
  try {
    holder = JSON.parse(readFileSync(lockPath, 'utf8'))
  } catch {
    holder = null
  }
  let alive = false
  if (holder?.pid) {
    try {
      process.kill(holder.pid, 0)
      alive = true
    } catch {
      alive = false
    }
  }
  if (!alive) {
    try {
      rmSync(lockPath, { force: true }) // stale lock (dead pid) — take over
    } catch {
      /* raced with another taker-over — the retry below decides */
    }
  }
  if (alive || !tryAcquireLock()) {
    // One matrix at a time — rerun by hand (`make e2e-async`) once the active
    // run finishes. Recorded so it isn't silent.
    const line = `${new Date().toISOString()} SKIPPED — runner already active (pid ${holder?.pid ?? '?'}${holder?.sha ? ` on sha=${holder.sha.slice(0, 7)}` : ''})\n`
    appendFileSync(join(resultDir(), 'history.log'), line)
    console.error(line.trim())
    process.exit(2)
  }
}
let lockHeld = true
const releaseLock = () => {
  if (lockHeld) {
    lockHeld = false
    try {
      rmSync(lockPath, { force: true })
    } catch {
      /* best-effort */
    }
  }
}
process.on('exit', releaseLock)
process.on('SIGINT', () => process.exit(130))
process.on('SIGTERM', () => process.exit(143))

// ---- resolve the target sha (lock already held) -----------------------------
if (!sha) {
  spawnSync('git', ['-C', mainRoot, 'fetch', '--quiet', 'origin', 'main']) // best-effort
  sha = git(['-C', mainRoot, 'rev-parse', 'origin/main'])
}
sha = git(['-C', mainRoot, 'rev-parse', sha]) // normalize to the full sha
const sha7 = sha.slice(0, 7)
// We own the lock — stamp the resolved sha into it for the SKIPPED message of
// any later launch.
writeFileSync(
  lockPath,
  JSON.stringify({ pid: process.pid, sha, startedAt: new Date().toISOString() })
)

// ---- result dir / log -------------------------------------------------------
function resultDirOf(root) {
  return join(root, '.claude', 'coordination', 'e2e-async')
}
function resultDir() {
  const d = resultDirOf(mainRoot)
  mkdirSync(d, { recursive: true })
  return d
}
const startedAt = new Date()
const stamp = startedAt.toISOString().replace(/[:.]/g, '-')
const logPath = join(resultDir(), `${stamp}-${sha7}.log`)
const log = createWriteStream(logPath, { flags: 'a' })
const say = (msg) => {
  const line = `[e2e-async ${new Date().toISOString()}] ${msg}`
  log.write(line + '\n')
  console.log(line)
}

// ---- snapshot worktree ------------------------------------------------------
const wt = join(mainRoot, '.worktrees', 'e2e-async-runner')
if (!existsSync(wt)) {
  say(`creating runner worktree at ${wt}`)
  git(['-C', mainRoot, 'worktree', 'add', '--detach', wt, sha])
} else {
  // Machine-managed checkout: --force is deliberate — nothing tracked is ever
  // hand-edited here, and a previous crashed run must not wedge every future run.
  git(['-C', wt, 'checkout', '--force', '--detach', sha])
}
const nm = join(wt, 'node_modules')
if (!existsSync(nm)) {
  say('junctioning MAIN node_modules into the runner worktree')
  const r = spawnSync('cmd', ['/c', 'mklink', '/J', nm, join(mainRoot, 'node_modules')], {
    encoding: 'utf8'
  })
  if (r.status !== 0) throw new Error(`mklink /J failed: ${r.stderr || r.stdout}`)
}
say(`matrix run @ ${sha7} (worktree snapshot; log: ${logPath})`)

// ---- legs -------------------------------------------------------------------
function runLeg(name, command, extraEnv) {
  return new Promise((resolve) => {
    const t0 = Date.now()
    say(`>>> ${name}: ${command}`)
    // shell:true so `pnpm` resolves via pnpm.cmd on Windows. Output streams into
    // the log; the exit code is read from the child object DIRECTLY.
    const child = spawn(command, {
      cwd: wt,
      shell: true,
      env: { ...process.env, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    child.stdout.on('data', (d) => log.write(d))
    child.stderr.on('data', (d) => log.write(d))
    child.on('close', (code) => {
      const durationMs = Date.now() - t0
      say(`<<< ${name}: exit ${code} in ${Math.round(durationMs / 1000)}s`)
      resolve({ exit: code, durationMs })
    })
  })
}

const result = {
  sha,
  startedAt: startedAt.toISOString(),
  finishedAt: null,
  win: null,
  linux: null,
  verdict: null,
  log: logPath
}

// Windows leg: merge-gate semantics — retries:2 (E2E_PRECOMMIT) but workers:1
// (E2E_WORKERS pinned so a caller's =2 can't leak extra retry-reliance in here).
result.win = await runLeg('windows leg', 'pnpm test:e2e', { E2E_PRECOMMIT: '1', E2E_WORKERS: '1' })

// Linux leg — SEQUENTIAL after the Windows leg (concurrent legs = false red).
const dockerUp = spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0
if (skipLinux) {
  result.linux = { skipped: true, reason: '--skip-linux' }
  say('linux leg skipped (--skip-linux)')
} else if (!dockerUp) {
  result.linux = { skipped: true, reason: 'docker daemon down' }
  say('linux leg SKIPPED — Docker daemon is not running')
} else {
  result.linux = await runLeg('linux leg', 'pnpm test:e2e:linux', {})
}

// ---- verdict + reporting ----------------------------------------------------
result.finishedAt = new Date().toISOString()
if ((result.win.exit ?? 1) !== 0 || (!result.linux.skipped && (result.linux.exit ?? 1) !== 0)) {
  result.verdict = 'RED'
} else if (result.linux.skipped) {
  result.verdict = 'INCOMPLETE'
} else {
  result.verdict = 'GREEN'
}
writeFileSync(join(resultDir(), 'last-result.json'), JSON.stringify(result, null, 2))
appendFileSync(
  join(resultDir(), 'history.log'),
  `${result.finishedAt} ${result.verdict} sha=${sha7} win=${result.win.exit} linux=${result.linux.skipped ? 'skipped' : result.linux.exit}\n`
)
say(`VERDICT: ${result.verdict}`)

// OS toast — via Windows PowerShell 5.1 (WinRT projection works there; pwsh 7 lacks
// it). Runs AFTER the suite so the specs' shell sweeps can't kill it. Best-effort.
function toast(title, body) {
  const ps = [
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null;',
    '$x=[Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02);',
    "$t=$x.GetElementsByTagName('text');",
    `$t.Item(0).AppendChild($x.CreateTextNode('${title}'))|Out-Null;`,
    `$t.Item(1).AppendChild($x.CreateTextNode('${body}'))|Out-Null;`,
    '$n=[Windows.UI.Notifications.ToastNotification]::new($x);',
    "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Canvas ADE e2e').Show($n)"
  ].join(' ')
  try {
    spawnSync('powershell.exe', ['-NoProfile', '-Command', ps], { stdio: 'ignore', timeout: 15000 })
  } catch {
    /* toast is best-effort; the json + log are the record */
  }
}
const linuxTxt = result.linux.skipped
  ? `linux SKIPPED (${result.linux.reason})`
  : `linux exit ${result.linux.exit}`
toast(
  `e2e matrix ${result.verdict} @ ${sha7}`,
  `win exit ${result.win.exit} · ${linuxTxt}. ${result.verdict === 'GREEN' ? 'All clear.' : 'Fix-forward or revert before the next merge — see last-result.json.'}`
)

log.end()
process.exit(result.verdict === 'GREEN' ? 0 : 1)
