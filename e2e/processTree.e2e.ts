import { test, expect } from './fixtures'
import { evalIn, mainCall, pollEval, seed } from './helpers'

// A persistent child process the shell spawns under itself, cross-shell (pwsh / bash):
// `node -e` runs node as a child of the spawned shell. It prints its OWN pid (so the
// test can target the EXACT orphan, not walk the fragile OS process tree) then idles
// on an interval to stay alive until the terminal's tree is reaped. node is on PATH on
// every runner (setup-node) and locally. Single-quoted JS body so pwsh/cmd/bash all
// pass it through to node unchanged. The runtime output `PID=<n>` matches the regex;
// the echoed command (`PID='+process.pid`) does not, so parsing can't grab the echo.
const MARKER = 'CANVAS_E2E_CHILD'
const CHILD = `node -e "console.log('${MARKER}_PID='+process.pid);setInterval(()=>{},1000000)"`

const readTerm = (id: string) => `window.__canvasE2E.readTerminal(${JSON.stringify(id)})`

test.describe('@terminal process-tree kill (real child tree — node-pty / OS reap)', () => {
  test('killing a terminal reaps its spawned child process (no orphan)', async ({
    page,
    electronApp
  }) => {
    const id = await seed(page, 'terminal', { launchCommand: CHILD })

    // The PTY spawn is async — wait until the session registers.
    await expect
      .poll(() => mainCall<number | null>(electronApp, 'terminalPid', id), { timeout: 10_000 })
      .not.toBeNull()

    // Wait for the child to print its pid into the framebuffer, then parse the EXACT pid.
    await pollEval(
      page,
      `(() => { const t = ${readTerm(id)}; return typeof t === 'string' && /${MARKER}_PID=\\d+/.test(t); })()`,
      15_000
    )
    const fb = await evalIn<string | null>(page, readTerm(id))
    const childPid = Number(fb?.match(new RegExp(`${MARKER}_PID=(\\d+)`))?.[1])
    expect(Number.isFinite(childPid) && childPid > 0, 'captured child pid from framebuffer').toBe(
      true
    )

    // Sanity: the child is actually alive before we kill anything.
    expect(await mainCall<number[]>(electronApp, 'pidsAlive', [childPid])).toEqual([childPid])

    // Delete the board (parks the session) then drive the real MAIN teardown that
    // reaps live + parked trees — taskkill /T /F on Windows, negative-pgid on POSIX.
    await evalIn(page, `window.__canvasE2E.deleteBoard(${JSON.stringify(id)})`)
    await mainCall(electronApp, 'disposeAllPtys')

    // The orphan assertion: the child the terminal spawned must be dead. Targets the
    // captured child pid directly — no OS-tree walk, robust against root-pid reuse.
    await expect
      .poll(() => mainCall<number[]>(electronApp, 'pidsAlive', [childPid]), { timeout: 15_000 })
      .toEqual([])
    expect(await mainCall<number | null>(electronApp, 'terminalPid', id)).toBeNull()
  })
})
