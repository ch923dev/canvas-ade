import { test, expect } from './fixtures'
import { evalIn, mainCall, pollEval, seed } from './helpers'

/**
 * Wave-0 corrupt-`canvas.json` recovery (Audit-A data-loss seam). Drives the REAL
 * open cascade end-to-end through `window.__canvasE2E.openProjectFromDisk`:
 *   project:open (MAIN — envelope check) → applyOpenResult (renderer — deep fromObject)
 *   → project:reopenFromBak (MAIN — last-good snapshot) → fromObject(bak) → restore | error
 *
 * Both cases use an envelope-VALID but deep-corrupt primary (a too-new schemaVersion:
 * `isEnvelope` passes in MAIN, so MAIN's own parse/envelope .bak fallback never fires
 * and the renderer's deep-validation `.bak` retry — the actual Wave-0 fix — is what is
 * exercised). The headline invariant: a corrupt project must NEVER leave a black screen.
 */
test.describe('@core corrupt canvas.json recovery (Wave-0 data-loss seam)', () => {
  // envelope-valid (numeric schemaVersion + boards[]) but deep-corrupt: schemaVersion is
  // newer than this build supports → fromObject's migrate() throws "newer than supported".
  const TOO_NEW = '{"schemaVersion":999999,"boards":[]}'

  test('deep-corrupt primary + good .bak → recovers to an open canvas (not a black screen)', async ({
    page,
    electronApp
  }) => {
    const tmp = await mainCall<string>(
      electronApp,
      'createTempProject',
      'recovery-ok-',
      'recovery-ok'
    )
    try {
      // Build a real last-good snapshot: seed one board and serialize the live store as
      // it would have been saved, then write it as the project's canvas.json.bak.
      await seed(page, 'planning')
      const goodDoc = await evalIn<string>(page, 'window.__canvasE2E.serializeDoc()')
      await mainCall(electronApp, 'writeProjectFile', tmp, '.canvas/canvas.json.bak', goodDoc)
      // Corrupt the primary so the renderer must fall back to the .bak (ADR 0009: under .canvas/).
      await mainCall(electronApp, 'writeProjectFile', tmp, '.canvas/canvas.json', TOO_NEW)
      // Empty the live store so a recovered board can ONLY have come from the .bak on disk.
      await evalIn(page, 'window.__canvasE2E.reset()')

      const res = await evalIn<{ status: string; error: string | null; boardCount: number }>(
        page,
        `window.__canvasE2E.openProjectFromDisk(${JSON.stringify(tmp)})`
      )
      expect(res.status, 'recovered to open, not error / black screen').toBe('open')
      expect(res.boardCount, 'the .bak board was restored from disk').toBe(1)

      const canvasMounted = await pollEval(
        page,
        `document.querySelector('.react-flow__viewport') !== null`,
        4000
      )
      expect(canvasMounted, 'react-flow canvas is mounted after recovery').toBe(true)
    } finally {
      await mainCall(electronApp, 'teardownProject', tmp)
    }
  })

  test('deep-corrupt primary AND .bak → error recovery card, never a silent black screen', async ({
    page,
    electronApp
  }) => {
    const tmp = await mainCall<string>(
      electronApp,
      'createTempProject',
      'recovery-err-',
      'recovery-err'
    )
    try {
      await mainCall(electronApp, 'writeProjectFile', tmp, '.canvas/canvas.json', TOO_NEW)
      await mainCall(electronApp, 'writeProjectFile', tmp, '.canvas/canvas.json.bak', TOO_NEW)
      await evalIn(page, 'window.__canvasE2E.reset()')

      const res = await evalIn<{ status: string; error: string | null; boardCount: number }>(
        page,
        `window.__canvasE2E.openProjectFromDisk(${JSON.stringify(tmp)})`
      )
      expect(res.status, 'unrecoverable → error (not a silent blank canvas)').toBe('error')
      expect(res.error ?? '', 'carries the original too-new schema message').toContain(
        'newer than supported'
      )

      // The WelcomeScreen error card is shown and the canvas is unmounted (Canvas only
      // mounts on status:'open') — i.e. the failure is visible, not a black screen.
      const errVisible = await pollEval(
        page,
        `(() => { const el = document.querySelector('.welcome-error'); return !!el && /Could not open project/.test(el.textContent || '') })()`,
        4000
      )
      expect(errVisible, 'welcome-error recovery card is shown').toBe(true)
      const canvasGone = await evalIn<boolean>(
        page,
        `document.querySelector('.react-flow__viewport') === null`
      )
      expect(canvasGone, 'canvas is unmounted on the error state').toBe(true)
    } finally {
      await mainCall(electronApp, 'teardownProject', tmp)
    }
  })
})
