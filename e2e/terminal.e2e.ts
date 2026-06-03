import { test, expect } from './fixtures'
import { evalIn, mainCall, pollEval, seed } from './helpers'

const TERM_SENTINEL = 'CANVAS_E2E_TERM_OK'
const TERM_SENTINEL2 = 'CANVAS_E2E_RESPAWN_OK'
const ADOPT_MARKER = 'CANVAS_E2E_ADOPT_MARKER'

const readTerm = (id: string) => `window.__canvasE2E.readTerminal(${JSON.stringify(id)})`

test.describe('terminal (node-pty / ConPTY — real instance)', () => {
  test('spawn → echoes the sentinel into the framebuffer', async ({ page }) => {
    const id = await seed(page, 'terminal', { launchCommand: `echo ${TERM_SENTINEL}` })
    const ok = await pollEval(
      page,
      `(() => { const t = ${readTerm(id)}; return typeof t === 'string' && t.includes(${JSON.stringify(TERM_SENTINEL)}); })()`,
      10_000
    )
    expect(ok, 'sentinel in framebuffer').toBe(true)
  })

  test('full view relocates the live subtree — same pid + scrollback survive', async ({ page, electronApp }) => {
    const id = await seed(page, 'terminal', { launchCommand: `echo ${TERM_SENTINEL}` })
    await pollEval(page, `(() => { const t=${readTerm(id)}; return typeof t==='string' && t.includes(${JSON.stringify(TERM_SENTINEL)}); })()`, 10_000)
    const pidBefore = await mainCall<number | null>(electronApp, 'terminalPid', id)
    await evalIn(page, `window.__canvasE2E.setFullView(${JSON.stringify(id)})`)
    await page.waitForTimeout(400)
    const mounted = await evalIn<boolean>(page, `window.__canvasE2E.terminalMounted(${JSON.stringify(id)})`)
    const pidDuring = await mainCall<number | null>(electronApp, 'terminalPid', id)
    const text = await evalIn<string | null>(page, readTerm(id))
    await evalIn(page, 'window.__canvasE2E.setFullView(null)')
    await page.waitForTimeout(300)
    const pidAfter = await mainCall<number | null>(electronApp, 'terminalPid', id)
    expect(mounted).toBe(true)
    expect(pidBefore).not.toBeNull()
    expect(pidDuring).toBe(pidBefore)
    expect(pidAfter).toBe(pidBefore)
    expect(typeof text === 'string' && text.includes(TERM_SENTINEL)).toBe(true)
  })

  test('Configure popover carries nowheel (no canvas pan on scroll)', async ({ page }) => {
    const id = await seed(page, 'terminal', { launchCommand: `echo ${TERM_SENTINEL}` })
    await evalIn(page, `window.__canvasE2E.fitView(${JSON.stringify(id)})`)
    await evalIn(page, 'window.__canvasE2E.setZoom(1)')
    await page.waitForTimeout(150)
    const cfgOk = await evalIn<boolean>(
      page,
      `(async () => {
         const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
         const node = document.querySelector('.react-flow__node[data-id="${id}"]');
         const cfgBtn = node && node.querySelector('button[title="Configure terminal"]');
         if (!cfgBtn) return false;
         cfgBtn.click(); await sleep(150);
         const ok = !!document.querySelector('.nowheel select');
         cfgBtn.click();
         return ok;
       })()`
    )
    expect(cfgOk, 'config popover has nowheel').toBe(true)
  })

  test('survives LOD zoom-out — does not unmount + kill the PTY', async ({ page }) => {
    const id = await seed(page, 'terminal', { launchCommand: `echo ${TERM_SENTINEL}` })
    await pollEval(page, `window.__canvasE2E.terminalMounted(${JSON.stringify(id)})`, 5000)
    await evalIn(page, 'window.__canvasE2E.setZoom(0.2)') // < LOD_ZOOM (0.4)
    const alive = await pollEval(page, `window.__canvasE2E.terminalMounted(${JSON.stringify(id)})`, 3000)
    expect(alive, 'mounted across LOD (session alive)').toBe(true)
  })

  test('config respawn — new session echoes a fresh sentinel under the same id', async ({ page }) => {
    const id = await seed(page, 'terminal', { launchCommand: `echo ${TERM_SENTINEL}` })
    await pollEval(page, `(() => { const t=${readTerm(id)}; return typeof t==='string' && t.includes(${JSON.stringify(TERM_SENTINEL)}); })()`, 10_000)
    // Mirror the homegrown probe: ensure zoom is settled so the re-mounted xterm relayouts.
    await evalIn(page, 'window.__canvasE2E.setZoom(1)')
    await evalIn(page, `window.__canvasE2E.patchBoard(${JSON.stringify(id)}, { launchCommand: 'echo ${TERM_SENTINEL2}' })`)
    // The patch tears the old PTY down + spawns a new one under the same id; let that
    // churn settle before polling so a worker-shared prior PTY's onExit can't race the read.
    await page.waitForTimeout(300)
    const ok = await pollEval(page, `(() => { const t=${readTerm(id)}; return typeof t==='string' && t.includes(${JSON.stringify(TERM_SENTINEL2)}); })()`, 15_000)
    expect(ok, 'new session echoed after respawn').toBe(true)
  })

  test('park + adopt on undo — same pid + replayed scrollback', async ({ page, electronApp }) => {
    const id = await seed(page, 'terminal', { launchCommand: `echo ${TERM_SENTINEL}` })
    await pollEval(page, `(() => { const t=${readTerm(id)}; return typeof t==='string' && t.includes(${JSON.stringify(TERM_SENTINEL)}); })()`, 10_000)
    await mainCall(electronApp, 'writeTerminal', id, `echo ${ADOPT_MARKER}\r`)
    const markerSeen = await pollEval(page, `(() => { const t=${readTerm(id)}; return typeof t==='string' && t.includes(${JSON.stringify(ADOPT_MARKER)}); })()`, 8000)
    const pidBefore = await mainCall<number | null>(electronApp, 'terminalPid', id)
    await evalIn(page, `window.__canvasE2E.deleteBoard(${JSON.stringify(id)})`)
    await page.waitForTimeout(200)
    await evalIn(page, 'window.__canvasE2E.undo()')
    const adopted = await pollEval(
      page,
      `(() => { const t=${readTerm(id)}; return typeof t==='string' && t.includes(${JSON.stringify(ADOPT_MARKER)}); })()`,
      10_000
    )
    const pidNow = await mainCall<number | null>(electronApp, 'terminalPid', id)
    expect(markerSeen).toBe(true)
    expect(pidBefore).not.toBeNull()
    expect(pidNow).toBe(pidBefore)
    expect(adopted, 'scrollback replayed after undo').toBe(true)
  })
})
