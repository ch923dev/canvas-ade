import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { callE2E, mainCall, seed } from './helpers'

// A persistent child process the shell spawns under itself, cross-shell (pwsh / bash):
// `node -e` runs node as a child of the spawned shell. It prints its OWN pid (so the
// test can target the EXACT orphan, not walk the fragile OS process tree) then idles
// on an interval to stay alive until the terminal's tree is reaped. node is on PATH on
// every runner (setup-node) and locally. Single-quoted JS body so pwsh/cmd/bash all
// pass it through to node unchanged. The runtime output `PID=<n>` matches the regex;
// the echoed command (`PID='+process.pid`) does not, so parsing can't grab the echo.
const MARKER = 'CANVAS_E2E_CHILD'
const CHILD = `node -e "console.log('${MARKER}_PID='+process.pid);setInterval(()=>{},1000000)"`
const PID_RE = new RegExp(`${MARKER}_PID=(\\d+)`)

// Typed VALUE reader — the id crosses as a real argument (structured clone), never spliced into
// an eval'd code string (CodeQL js/bad-code-sanitization).
const readTerm = (page: Page, id: string): Promise<string | null> =>
  callE2E<string | null>(page, { m: 'readTerminal', a: [id] })

/** Poll a predicate over the framebuffer — the comparison runs HERE in Node. Same boolean
 *  contract as `pollEval` (never throws; the caller asserts on the parsed pid below). */
async function pollTerm(
  page: Page,
  id: string,
  pred: (t: string | null) => boolean,
  timeoutMs: number
): Promise<boolean> {
  try {
    await expect.poll(async () => pred(await readTerm(page, id)), { timeout: timeoutMs }).toBe(true)
    return true
  } catch {
    return false
  }
}

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
    await pollTerm(page, id, (t) => typeof t === 'string' && PID_RE.test(t), 15_000)
    const fb = await readTerm(page, id)
    const childPid = Number(fb?.match(PID_RE)?.[1])
    expect(Number.isFinite(childPid) && childPid > 0, 'captured child pid from framebuffer').toBe(
      true
    )

    // Sanity: the child is actually alive before we kill anything.
    expect(await mainCall<number[]>(electronApp, 'pidsAlive', [childPid])).toEqual([childPid])

    // Delete the board (parks the session) then drive the real MAIN teardown that
    // reaps live + parked trees — taskkill /T /F on Windows, negative-pgid on POSIX.
    await callE2E(page, { m: 'deleteBoard', a: [id] })
    await mainCall(electronApp, 'disposeAllPtys')

    // The orphan assertion: the child the terminal spawned must be dead. Targets the
    // captured child pid directly — no OS-tree walk, robust against root-pid reuse.
    await expect
      .poll(() => mainCall<number[]>(electronApp, 'pidsAlive', [childPid]), { timeout: 15_000 })
      .toEqual([])
    expect(await mainCall<number | null>(electronApp, 'terminalPid', id)).toBeNull()
  })
})
