import { test, expect } from './fixtures'
import { evalIn, mainCall, pollEval, seed } from './helpers'

const DETECTED_URL = 'http://localhost:3000'

test.describe('@preview terminal → browser preview link (live port-detect + gesture routing)', () => {
  test('hold / right-click open the connect picker; Connect links; tap refreshes (no picker)', async ({
    page,
    electronApp
  }) => {
    const termId = await seed(page, 'terminal', { launchCommand: 'echo link', w: 360 })
    const url = await mainCall<string>(electronApp, 'localUrl')
    const browserId = await seed(page, 'browser', { url })
    await evalIn(page, `window.__canvasE2E.fitView(${JSON.stringify(termId)})`)
    await evalIn(page, 'window.__canvasE2E.setZoom(1)')
    await mainCall(electronApp, 'writeTerminal', termId, 'echo http://localhost:3000/\r')
    const urlSeen = await pollEval(
      page,
      `(() => { const t = window.__canvasE2E.readTerminal(${JSON.stringify(termId)}); return typeof t === 'string' && t.includes('localhost:3000'); })()`,
      8000
    )
    const gesture = await evalIn<{
      detected: string[]
      holdOpened: boolean
      holdTitle: boolean
      holdCount: number
      rightOpened: boolean
      tapOpened: boolean
    }>(
      page,
      `(async () => {
         const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
         const detected = (await window.api.detectPorts(${JSON.stringify(termId)})).map((u) => u.url);
         const node = document.querySelector('.react-flow__node[data-id=' + JSON.stringify(${JSON.stringify(termId)}) + ']');
         const globe = node && node.querySelector('button[title*="choose browser"]');
         const picker = () => node.querySelector('.ca-port-picker');
         const pickerHas = (txt) => { const p = picker(); return !!p && p.textContent.includes(txt); };
         if (!globe) return { detected, holdOpened: false, holdTitle: false, holdCount: 0, rightOpened: false, tapOpened: false };
         globe.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
         await sleep(700);
         globe.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
         globe.dispatchEvent(new MouseEvent('click', { bubbles: true }));
         await sleep(600);
         const holdOpened = !!picker();
         const holdTitle = pickerHas('Push to which browser');
         const holdCount = picker() ? picker().querySelectorAll('.ca-browser-choice input').length : 0;
         const cancel = picker() && picker().querySelector('.ca-preview-dismiss');
         if (cancel) cancel.click();
         await sleep(120);
         globe.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
         await sleep(600);
         const rightOpened = !!picker();
         const firstBox = picker() && picker().querySelector('.ca-browser-choice input');
         if (firstBox) { firstBox.click(); await sleep(60); const c = picker().querySelector('.ca-browser-connect'); if (c) c.click(); }
         await sleep(200);
         globe.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
         globe.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
         globe.dispatchEvent(new MouseEvent('click', { bubbles: true }));
         await sleep(700);
         const tapOpened = !!picker();
         return { detected, holdOpened, holdTitle, holdCount, rightOpened, tapOpened };
       })()`
    )
    await page.waitForTimeout(150)
    const linkAfter = await evalIn<{ source: string | null; url: string }>(
      page,
      `(() => { const b = window.__canvasE2E.getBoards().find((x) => x.id === ${JSON.stringify(browserId)}); return { source: (b && b.type === 'browser' ? (b.previewSourceId ?? null) : null), url: (b && b.type === 'browser' ? b.url : '') }; })()`
    )
    expect(urlSeen, 'dev-server URL echoed into the terminal').toBe(true)
    expect(gesture.holdOpened, 'long-press opens picker').toBe(true)
    expect(gesture.holdTitle).toBe(true)
    expect(gesture.holdCount).toBeGreaterThanOrEqual(2)
    expect(gesture.rightOpened, 'right-click opens picker').toBe(true)
    expect(gesture.tapOpened, 'tap does NOT reopen picker').toBe(false)
    expect(linkAfter.source).toBe(termId)
    expect(linkAfter.url).toBe(DETECTED_URL)
  })
})
