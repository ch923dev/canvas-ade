import { test, expect } from './fixtures'
import { evalIn, mainCall, pollEval, seed } from './helpers'

const live = (id: string) =>
  `(() => { const r = window.__canvasE2E.getRuntime(${JSON.stringify(id)}); return !!r && r.live === true; })()`
const status = (id: string, s: string) =>
  `(() => { const r = window.__canvasE2E.getRuntime(${JSON.stringify(id)}); return !!r && r.status === ${JSON.stringify(s)}; })()`

test.describe('full view (native rebind — real instance)', () => {
  test('a full-viewed OTHER board: browser stays detached through a mutation + webContents survives', async ({
    page,
    electronApp
  }) => {
    const url = await mainCall<string>(electronApp, 'localUrl')
    const browserId = await seed(page, 'browser', { url })
    const planId = await seed(page, 'planning')
    await page.waitForTimeout(150)
    await evalIn(page, `window.__canvasE2E.fitView(${JSON.stringify(browserId)})`)
    expect(await pollEval(page, live(browserId), 6000)).toBe(true)
    await evalIn(page, `window.__canvasE2E.setFullView(${JSON.stringify(planId)})`)
    await page.waitForTimeout(400)
    await evalIn(page, `window.__canvasE2E.addChecklist(${JSON.stringify(planId)})`)
    await page.waitForTimeout(400)
    const cap = await mainCall<{ attached: boolean }>(electronApp, 'captureView', browserId)
    const survived = (await mainCall<string[]>(electronApp, 'viewIds')).includes(browserId)
    await evalIn(page, 'window.__canvasE2E.setFullView(null)')
    await page.waitForTimeout(300)
    expect(cap.attached, 'browser stayed detached over the modal').toBe(false)
    expect(survived, 'browser webContents survived full view').toBe(true)
  })

  test('full-viewing the browser ITSELF keeps the same webContents (no restart)', async ({
    page,
    electronApp
  }) => {
    const url = await mainCall<string>(electronApp, 'localUrl')
    const browserId = await seed(page, 'browser', { url })
    await page.waitForTimeout(150)
    await evalIn(page, `window.__canvasE2E.fitView(${JSON.stringify(browserId)})`)
    expect(await pollEval(page, status(browserId, 'connected'), 6000)).toBe(true)
    const before = await mainCall<number | null>(electronApp, 'viewWebContentsId', browserId)
    await evalIn(page, `window.__canvasE2E.openFullViewAnimated(${JSON.stringify(browserId)})`)
    await page.waitForTimeout(700)
    const during = await mainCall<number | null>(electronApp, 'viewWebContentsId', browserId)
    await evalIn(page, 'window.__canvasE2E.closeFullViewAnimated()')
    await page.waitForTimeout(700)
    const after = await mainCall<number | null>(electronApp, 'viewWebContentsId', browserId)
    expect(before).not.toBeNull()
    expect(during).toBe(before)
    expect(after).toBe(before)
  })

  test('Mobile full view is an aspect-correct letterboxed emulator (not stretched)', async ({
    page
  }) => {
    const planId = await seed(page, 'planning') // any board works; we full-view the browser below
    void planId
    const browserId = await seed(page, 'browser', { url: 'http://127.0.0.1:59999/' })
    await evalIn(
      page,
      `window.__canvasE2E.patchBoard(${JSON.stringify(browserId)}, { viewport: 'mobile' })`
    )
    await evalIn(page, `window.__canvasE2E.setFullView(${JSON.stringify(browserId)})`)
    await page.waitForTimeout(450)
    const emu = await evalIn<{
      found: boolean
      frameRatio: number
      stageRatio: number
      widthFrac: number
    }>(
      page,
      `(() => {
         const frame = document.querySelector('[data-bb-frame=' + JSON.stringify(${JSON.stringify(browserId)}) + ']');
         const stage = frame && frame.closest('.bb-stage');
         if (!frame || !stage) return { found: false, frameRatio: 0, stageRatio: 0, widthFrac: 0 };
         const f = frame.getBoundingClientRect();
         const s = stage.getBoundingClientRect();
         return { found: true, frameRatio: f.width / f.height, stageRatio: s.width / s.height, widthFrac: f.width / s.width };
       })()`
    )
    await evalIn(page, 'window.__canvasE2E.setFullView(null)')
    await page.waitForTimeout(300)
    const mobileRatio = 390 / 844
    expect(emu.found, 'device frame found in full view').toBe(true)
    expect(Math.abs(emu.frameRatio - mobileRatio), 'portrait mobile aspect').toBeLessThan(0.06)
    expect(emu.widthFrac, 'letterboxed (narrower than stage)').toBeLessThan(0.9)
    expect(emu.frameRatio, 'frame narrower-ratio than landscape stage').toBeLessThan(emu.stageRatio)
  })

  test('chrome-less frame; Esc from the focused terminal textarea closes + unmounts', async ({
    page
  }) => {
    const termId = await seed(page, 'terminal', { launchCommand: 'echo fullview-close' })
    await pollEval(
      page,
      `(() => { const t = window.__canvasE2E.readTerminal(${JSON.stringify(termId)}); return typeof t === 'string' && t.includes('fullview-close'); })()`,
      8000
    )
    await evalIn(page, `window.__canvasE2E.setFullView(${JSON.stringify(termId)})`)
    await page.waitForTimeout(400)
    const fvClose = await evalIn<{ frame: boolean; bandGone: boolean; typed: boolean }>(
      page,
      `(() => {
         const ta = document.querySelector('.fullview-host .xterm-helper-textarea');
         if (ta) ta.focus();
         const typing = document.activeElement?.tagName === 'TEXTAREA';
         (ta || document).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
         return {
           frame: !!document.querySelector('.fullview-scrim .fullview-frame .fullview-host'),
           bandGone: document.querySelector('.fullview-band') === null,
           typed: typing
         };
       })()`
    )
    await page.waitForTimeout(400)
    const gone = await evalIn<boolean>(page, `document.querySelector('.fullview-scrim') === null`)
    expect(fvClose.frame, 'chrome-less frame mounted').toBe(true)
    expect(fvClose.bandGone, 'no §6.1 band in full view').toBe(true)
    expect(fvClose.typed, 'Escape dispatched from focused TEXTAREA').toBe(true)
    expect(gone, 'modal unmounted after Esc').toBe(true)
  })
})
