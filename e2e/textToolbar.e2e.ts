import { test, expect } from './fixtures'
import { evalIn, mainCall, pollEval, seed } from './helpers'

test.describe('text font toolbar (real OS input)', () => {
  test('select a text element → toolbar → click size L → persists fontSize', async ({
    page,
    electronApp
  }) => {
    const planId = await seed(page, 'planning')
    await evalIn(
      page,
      `window.__canvasE2E.patchBoard(${JSON.stringify(planId)}, { w: 520, h: 400, elements: [
        { id: 'txt', kind: 'text', x: 160, y: 160, text: 'Hello' }
      ] })`
    )
    await page.waitForTimeout(160)

    // Poll until the grip is on-screen and has a non-zero rect.
    const gripReady = await pollEval(
      page,
      `(() => {
         const id = ${JSON.stringify(planId)};
         const node = document.querySelector('.react-flow__node[data-id=' + JSON.stringify(id) + ']');
         const grip = node && node.querySelector('.pl-text-grip');
         if (!grip) return false;
         const r = grip.getBoundingClientRect();
         return r.width > 0;
       })()`,
      4000
    )
    expect(gripReady, 'text grip is on screen').toBe(true)

    // Now read the actual coordinates for the real OS click.
    const g = await evalIn<{ cx: number; cy: number }>(
      page,
      `(() => {
         const id = ${JSON.stringify(planId)};
         const node = document.querySelector('.react-flow__node[data-id=' + JSON.stringify(id) + ']');
         const grip = node.querySelector('.pl-text-grip');
         const r = grip.getBoundingClientRect();
         return { cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2) };
       })()`
    )

    await mainCall(electronApp, 'sendInput', {
      type: 'mouseDown',
      x: g.cx,
      y: g.cy,
      button: 'left',
      clickCount: 1
    })
    await mainCall(electronApp, 'sendInput', {
      type: 'mouseUp',
      x: g.cx,
      y: g.cy,
      button: 'left',
      clickCount: 1
    })

    // Poll until the toolbar appears.
    const toolbarReady = await pollEval(
      page,
      `(() => {
         const id = ${JSON.stringify(planId)};
         const node = document.querySelector('.react-flow__node[data-id=' + JSON.stringify(id) + ']');
         const btn = node && node.querySelector('.pl-text-toolbar button[aria-label="size L"]');
         if (!btn) return false;
         const r = btn.getBoundingClientRect();
         return r.width > 0;
       })()`,
      4000
    )
    expect(toolbarReady, 'toolbar appeared with a size-L button').toBe(true)

    // Read the size-L button coords.
    const s = await evalIn<{ cx: number; cy: number }>(
      page,
      `(() => {
         const id = ${JSON.stringify(planId)};
         const node = document.querySelector('.react-flow__node[data-id=' + JSON.stringify(id) + ']');
         const btn = node.querySelector('.pl-text-toolbar button[aria-label="size L"]');
         const r = btn.getBoundingClientRect();
         return { cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2) };
       })()`
    )

    await mainCall(electronApp, 'sendInput', {
      type: 'mouseDown',
      x: s.cx,
      y: s.cy,
      button: 'left',
      clickCount: 1
    })
    await mainCall(electronApp, 'sendInput', {
      type: 'mouseUp',
      x: s.cx,
      y: s.cy,
      button: 'left',
      clickCount: 1
    })

    // Poll until the store reflects fontSize: 'L'.
    const persisted = await pollEval(
      page,
      `(() => {
         const b = window.__canvasE2E.getBoards().find((x) => x.id === ${JSON.stringify(planId)});
         const t = b && b.type === 'planning' ? b.elements.find((e) => e.id === 'txt') : null;
         return !!t && t.fontSize === 'L';
       })()`,
      4000
    )
    expect(persisted, 'fontSize L persisted to the element').toBe(true)
  })
})
