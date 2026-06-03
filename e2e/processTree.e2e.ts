import { test, expect } from './fixtures'
import { evalIn, mainCall, seed } from './helpers'

// A persistent child the shell spawns under itself, cross-shell (pwsh / bash):
// `node -e "setInterval(...)"` runs node as a child of the spawned shell, so it
// shows up under childPidsOf(rootPid). node is on PATH on every runner (setup-node)
// and locally. The interval keeps it alive until the tree is reaped.
const CHILD = `node -e "setInterval(()=>{}, 1000000)"`

test.describe('process-tree kill (real child tree — node-pty / OS reap)', () => {
  test('killing a terminal reaps its whole child tree (no orphans)', async ({
    page,
    electronApp
  }) => {
    const id = await seed(page, 'terminal', { launchCommand: CHILD })

    // Root = the spawned shell's pid; the node child re-parents under it. The PTY
    // spawn is async — poll until the session registers before reading the pid.
    await expect
      .poll(() => mainCall<number | null>(electronApp, 'terminalPid', id), { timeout: 10_000 })
      .not.toBeNull()
    const rootPid = await mainCall<number | null>(electronApp, 'terminalPid', id)
    expect(rootPid, 'terminal spawned').not.toBeNull()

    // Wait for the child tree to come up (the node child appears under the shell).
    await expect
      .poll(() => mainCall<number[]>(electronApp, 'childPidsOf', rootPid), { timeout: 15_000 })
      .not.toEqual([])

    // Delete the board (parks the session) then drive the real MAIN teardown that
    // reaps live + parked trees — taskkill /T /F on Windows, negative-pgid on POSIX.
    await evalIn(page, `window.__canvasE2E.deleteBoard(${JSON.stringify(id)})`)
    await mainCall(electronApp, 'disposeAllPtys')

    // The whole descendant tree must be gone — this is the orphan assertion.
    await expect
      .poll(() => mainCall<number[]>(electronApp, 'childPidsOf', rootPid), { timeout: 15_000 })
      .toEqual([])
    expect(await mainCall<number | null>(electronApp, 'terminalPid', id)).toBeNull()
  })
})
