import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ElectronApplication } from '@playwright/test'

/** How long `close()` may take to settle on its own once the app process has exited. */
const CLOSE_GRACE_MS = 2_000

/**
 * `app.close()` that cannot hang after the app has already quit.
 *
 * Playwright's `close()` settles only once everything it holds to the app is released: the
 * child's stdio pipes (Node's `close` event) and its DevTools / inspector connections. On
 * Windows the detached ptyHost daemon inherits every inheritable handle of the app that spawns
 * it (libuv calls CreateProcess with bInheritHandles), including those pipes and sockets. So
 * the worker whose app COLD-starts the daemon sees the app exit ~10 ms after `before-quit`, yet
 * `close()` waits out the 60 s fixture timeout ("Fixture electronApp timeout of 60000ms
 * exceeded during teardown"). A warm daemon was spawned by an earlier, already-gone app, so
 * every other worker closes normally — which is why the failure tracked whichever run happened
 * to cold-start the daemon, not any one commit.
 *
 * Once the process has exited and `close()` still has not settled, kill that daemon tree: the
 * app is gone, so its sessions are already orphaned, and the next app simply starts a fresh
 * daemon. That is only safe because the daemon is this worker's alone — each worker slot runs
 * in its own profile (fixtures.ts `workerAppEnv`), so no other app is attached to it. A genuine
 * quit hang (the process never exits) still waits — and still fails the teardown — exactly as
 * before.
 */
export async function closeElectronApp(app: ElectronApplication): Promise<void> {
  const proc = app.process()
  // Ask before quitting: this profile's ptyhost-state.json names the checkout's daemon.
  const userData = await app
    .evaluate(({ app: electronApp }) => electronApp.getPath('userData'))
    .catch(() => null)
  const exited =
    proc.exitCode !== null || proc.signalCode !== null
      ? Promise.resolve()
      : new Promise<void>((resolve) => proc.once('exit', () => resolve()))
  const closing = app.close()
  await exited
  if (await settlesWithin(closing, CLOSE_GRACE_MS)) return
  killPtyHostDaemon(userData)
  await closing
}

async function settlesWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const settled = await Promise.race([
    p.then(
      () => true,
      () => true
    ),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), ms)
    })
  ])
  clearTimeout(timer)
  return settled
}

function killPtyHostDaemon(userData: string | null): void {
  if (!userData) return
  let pid = 0
  try {
    const state = JSON.parse(readFileSync(join(userData, 'ptyhost-state.json'), 'utf8')) as {
      daemonPid?: number
    }
    pid = state.daemonPid ?? 0
  } catch {
    return // no daemon was ever started for this profile
  }
  if (!Number.isInteger(pid) || pid <= 0) return
  // The state file can outlive its daemon, and Windows recycles pids fast: never /T /F a pid
  // unless it is still a ptyHost daemon. The image name alone is not enough — the in-place
  // daemon is a plain electron.exe, same as any dev app the user has open.
  if (!isPtyHostDaemon(pid)) return
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
    } else {
      process.kill(pid, 'SIGKILL')
    }
  } catch {
    /* already gone */
  }
}

/**
 * True only when `pid` is alive and its command line runs `ptyHostDaemon.js` — both the in-place
 * daemon (electron.exe) and the staged one (expanse-ptyhost.exe) do. Any probe failure = false:
 * skipping the kill only costs the pre-#437 hang, killing the wrong process costs far more.
 */
function isPtyHostDaemon(pid: number): boolean {
  try {
    let cmdline: string
    if (process.platform === 'win32') {
      cmdline = execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`
        ],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15_000 }
      )
    } else if (process.platform === 'linux') {
      cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8')
    } else {
      cmdline = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      })
    }
    return cmdline.includes('ptyHostDaemon')
  } catch {
    return false
  }
}
