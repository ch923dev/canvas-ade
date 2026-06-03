import { test, expect } from './fixtures'
import { evalIn, mainCall, seed } from './helpers'

test.describe('board ⋯ menu (real layout / native occlusion)', () => {
  test('⋯ trigger stays in the title bar + popover clamps on-screen + visible at rest', async ({ page }) => {
    const id = await seed(page, 'terminal', { launchCommand: 'echo menu', w: 150 })
    await evalIn(page, `window.__canvasE2E.fitView(${JSON.stringify(id)})`)
    await evalIn(page, 'window.__canvasE2E.setZoom(1)')
    await page.waitForTimeout(150)
    const chrome = await evalIn<{ found: boolean; triggerInBar: boolean; restColor: string; inViewport: boolean }>(
      page,
      `(async () => {
         const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
         const sel = (s, root) => (root || document).querySelector(s);
         const node = sel('.react-flow__node[data-id=' + JSON.stringify(${JSON.stringify(id)}) + ']');
         const bar = node && sel('.board-titlebar', node);
         const more = node && sel('button[title="More"]', node);
         if (!bar || !more) return { found: false, triggerInBar: false, restColor: '', inViewport: false };
         const b = bar.getBoundingClientRect();
         const t = more.getBoundingClientRect();
         const triggerInBar = t.width > 0 && t.left >= b.left - 0.5 && t.right <= b.right + 0.5;
         const svg = more.querySelector('svg');
         const restColor = svg ? getComputedStyle(svg).color : '';
         const overshoot = (window.innerWidth - t.right) + 40;
         window.__canvasE2E.panBy(overshoot, 0);
         await sleep(80);
         const more2 = sel('button[title="More"]', node);
         more2.click(); await sleep(80);
         const menu = sel('.board-menu');
         const m = menu && menu.getBoundingClientRect();
         const inViewport = !!m && m.left >= 0 && m.top >= 0 && m.right <= window.innerWidth && m.bottom <= window.innerHeight;
         more2.click(); await sleep(40);
         window.__canvasE2E.panBy(-overshoot, 0);
         return { found: true, triggerInBar, restColor, inViewport };
       })()`
    )
    expect(chrome.found).toBe(true)
    expect(chrome.triggerInBar, '⋯ within the title bar (13)').toBe(true)
    expect(chrome.inViewport, 'popover clamps on-screen (14)').toBe(true)
    expect(chrome.restColor, 'rest colour resolves the CSS var').toBe('rgb(155, 155, 161)')
  })

  test('open ⋯ menu detaches the live preview (un-occludes the popover) → reattaches on close', async ({ page, electronApp }) => {
    const url = await mainCall<string>(electronApp, 'localUrl')
    const id = await seed(page, 'browser', { url })
    await evalIn(page, `window.__canvasE2E.fitView(${JSON.stringify(id)})`)
    await evalIn(page, 'window.__canvasE2E.setZoom(1)')
    await page.waitForTimeout(250)
    const occl = await evalIn<{ found: boolean; liveBefore: boolean; liveDuringMenu: boolean; liveAfter: boolean }>(
      page,
      `(async () => {
         const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
         const sel = (s, root) => (root || document).querySelector(s);
         const id = ${JSON.stringify(id)};
         const live = () => !!(window.__canvasE2E.getRuntime(id) || {}).live;
         const node = sel('.react-flow__node[data-id=' + JSON.stringify(id) + ']');
         const more = node && sel('button[title="More"]', node);
         if (!more) return { found: false, liveBefore: false, liveDuringMenu: false, liveAfter: false };
         const liveBefore = live();
         more.click(); await sleep(250);
         const liveDuringMenu = live();
         more.click(); await sleep(300);
         const liveAfter = live();
         return { found: true, liveBefore, liveDuringMenu, liveAfter };
       })()`
    )
    expect(occl.found).toBe(true)
    expect(occl.liveBefore, 'live before open').toBe(true)
    expect(occl.liveDuringMenu, 'detached while menu open').toBe(false)
    expect(occl.liveAfter, 'reattached on close').toBe(true)
  })
})
