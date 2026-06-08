import { test, expect } from './fixtures'
import { evalIn, mainCall, pollEval, seed } from './helpers'
import { type Page } from '@playwright/test'

// Poll until `expr` (a renderer expression returning `{cx,cy}` screen coords, or null when
// not ready) yields coords, then return them. Reading the rect INSIDE the poll keeps the
// coordinate read atomic with the readiness check — a separate post-poll read could race a
// floating element (e.g. the toolbar) still settling its position and then click stale coords.
async function pollRect(
  page: Page,
  expr: string,
  message: string,
  timeout = 4000
): Promise<{ cx: number; cy: number }> {
  let rect: { cx: number; cy: number } | null = null
  await expect
    .poll(
      async () => {
        rect = await evalIn<{ cx: number; cy: number } | null>(page, expr)
        return rect !== null
      },
      { message, timeout }
    )
    .toBe(true)
  return rect!
}

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
    // Select the text by a real OS press on its drag grip (coords read atomically — the
    // pollRect below self-waits for React Flow to render the grip, so no fixed sleep needed).
    const g = await pollRect(
      page,
      `(() => {
         const id = ${JSON.stringify(planId)};
         const node = document.querySelector('.react-flow__node[data-id=' + JSON.stringify(id) + ']');
         const grip = node && node.querySelector('.pl-text-grip');
         if (!grip) return null;
         const r = grip.getBoundingClientRect();
         if (!(r.width > 0)) return null;
         return { cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2) };
       })()`,
      'text grip is on screen'
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

    // The toolbar should appear for the single text selection; real-click its size-L button.
    const s = await pollRect(
      page,
      `(() => {
         const id = ${JSON.stringify(planId)};
         const node = document.querySelector('.react-flow__node[data-id=' + JSON.stringify(id) + ']');
         const btn = node && node.querySelector('.pl-text-toolbar button[aria-label="size L"]');
         if (!btn) return null;
         const r = btn.getBoundingClientRect();
         if (!(r.width > 0)) return null;
         return { cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2) };
       })()`,
      'toolbar size-L button appeared'
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

    // The store should reflect fontSize: 'L'.
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
