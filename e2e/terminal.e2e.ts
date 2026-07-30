import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { callE2E, evalIn, mainCall, pollCall, seed } from './helpers'

const TERM_SENTINEL = 'CANVAS_E2E_TERM_OK'
const TERM_SENTINEL2 = 'CANVAS_E2E_RESPAWN_OK'
const ADOPT_MARKER = 'CANVAS_E2E_ADOPT_MARKER'

// Typed VALUE reader — the id crosses as a real argument (structured clone), never spliced into
// an eval'd code string (CodeQL js/bad-code-sanitization).
const readTerm = (page: Page, id: string): Promise<string | null> =>
  callE2E<string | null>(page, { m: 'readTerminal', a: [id] })

/** Poll until the framebuffer contains `needle` — the comparison runs HERE in Node. Same boolean
 *  contract as `pollEval`. */
async function pollTermIncludes(
  page: Page,
  id: string,
  needle: string,
  timeoutMs: number
): Promise<boolean> {
  try {
    await expect
      .poll(
        async () => {
          const t = await readTerm(page, id)
          return typeof t === 'string' && t.includes(needle)
        },
        { timeout: timeoutMs }
      )
      .toBe(true)
    return true
  } catch {
    return false
  }
}

test.describe('@terminal terminal (node-pty / ConPTY — real instance)', () => {
  test('spawn → echoes the sentinel into the framebuffer', async ({ page }) => {
    const id = await seed(page, 'terminal', { launchCommand: `echo ${TERM_SENTINEL}` })
    const ok = await pollTermIncludes(page, id, TERM_SENTINEL, 10_000)
    expect(ok, 'sentinel in framebuffer').toBe(true)
  })

  test('full view relocates the live subtree — same pid + scrollback survive', async ({
    page,
    electronApp
  }) => {
    const id = await seed(page, 'terminal', { launchCommand: `echo ${TERM_SENTINEL}` })
    await pollTermIncludes(page, id, TERM_SENTINEL, 10_000)
    const pidBefore = await mainCall<number | null>(electronApp, 'terminalPid', id)
    await callE2E(page, { m: 'setFullView', a: [id] })
    await page.waitForTimeout(400)
    const mounted = await callE2E<boolean>(page, { m: 'terminalMounted', a: [id] })
    const pidDuring = await mainCall<number | null>(electronApp, 'terminalPid', id)
    const text = await readTerm(page, id)
    await evalIn(page, 'window.__canvasE2E.setFullView(null)')
    await page.waitForTimeout(300)
    const pidAfter = await mainCall<number | null>(electronApp, 'terminalPid', id)
    expect(mounted).toBe(true)
    expect(pidBefore).not.toBeNull()
    expect(pidDuring).toBe(pidBefore)
    expect(pidAfter).toBe(pidBefore)
    expect(typeof text === 'string' && text.includes(TERM_SENTINEL)).toBe(true)
  })

  test('survives LOD zoom-out — does not unmount + kill the PTY', async ({ page }) => {
    const id = await seed(page, 'terminal', { launchCommand: `echo ${TERM_SENTINEL}` })
    await pollCall(page, [{ m: 'terminalMounted', a: [id] }], 5000)
    await evalIn(page, 'window.__canvasE2E.setZoom(0.2)') // < LOD_ZOOM (0.4)
    const alive = await pollCall(page, [{ m: 'terminalMounted', a: [id] }], 3000)
    expect(alive, 'mounted across LOD (session alive)').toBe(true)
  })

  test('config respawn — new session echoes a fresh sentinel under the same id', async ({
    page
  }) => {
    const id = await seed(page, 'terminal', { launchCommand: `echo ${TERM_SENTINEL}` })
    await pollTermIncludes(page, id, TERM_SENTINEL, 10_000)
    // Mirror the homegrown probe: ensure zoom is settled so the re-mounted xterm relayouts.
    await evalIn(page, 'window.__canvasE2E.setZoom(1)')
    await callE2E(page, {
      m: 'patchBoard',
      a: [id, { launchCommand: `echo ${TERM_SENTINEL2}` }]
    })
    // The patch tears the old PTY down + spawns a new one under the same id; let that
    // churn settle before polling so a worker-shared prior PTY's onExit can't race the read.
    await page.waitForTimeout(300)
    const ok = await pollTermIncludes(page, id, TERM_SENTINEL2, 15_000)
    expect(ok, 'new session echoed after respawn').toBe(true)
  })

  test('park + adopt on undo — same pid + replayed scrollback', async ({ page, electronApp }) => {
    const id = await seed(page, 'terminal', { launchCommand: `echo ${TERM_SENTINEL}` })
    await pollTermIncludes(page, id, TERM_SENTINEL, 10_000)
    await mainCall(electronApp, 'writeTerminal', id, `echo ${ADOPT_MARKER}\r`)
    const markerSeen = await pollTermIncludes(page, id, ADOPT_MARKER, 8000)
    const pidBefore = await mainCall<number | null>(electronApp, 'terminalPid', id)
    await callE2E(page, { m: 'deleteBoard', a: [id] })
    await page.waitForTimeout(200)
    await evalIn(page, 'window.__canvasE2E.undo()')
    const adopted = await pollTermIncludes(page, id, ADOPT_MARKER, 10_000)
    const pidNow = await mainCall<number | null>(electronApp, 'terminalPid', id)
    expect(markerSeen).toBe(true)
    expect(pidBefore).not.toBeNull()
    expect(pidNow).toBe(pidBefore)
    expect(adopted, 'scrollback replayed after undo').toBe(true)
  })
})
