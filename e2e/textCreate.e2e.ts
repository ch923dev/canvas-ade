import { test, expect } from './fixtures'
import { evalIn, mainCall, pollEval, seed } from './helpers'
import type { Page } from '@playwright/test'

/** Read the screen-center of a named element inside a planning board node, or null if absent. */
async function boardBtnCenter(
  page: Page,
  planId: string,
  selector: string
): Promise<{ cx: number; cy: number } | null> {
  return evalIn<{ cx: number; cy: number } | null>(
    page,
    `(() => {
       const n = document.querySelector('.react-flow__node[data-id=${JSON.stringify(planId)}]');
       const b = n && n.querySelector(${JSON.stringify(selector)});
       if (!b) return null;
       const r = b.getBoundingClientRect();
       if (!(r.width > 0)) return null;
       return { cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2) };
     })()`
  )
}

/** Read the current React Flow viewport zoom from the DOM transform. */
async function rfZoom(page: Page): Promise<number> {
  return evalIn<number>(
    page,
    `(() => {
       const vp = document.querySelector('.react-flow__viewport');
       if (!vp) return 0;
       const m = getComputedStyle(vp).transform.match(/matrix\\(([^,]+)/);
       return m ? parseFloat(m[1]) : 0;
     })()`
  )
}

test.describe('@planning text create + edit (real OS input)', () => {
  /**
   * Test A — Text tool: drag makes a wrapped area text with a height-mapped size.
   *
   * Camera zoom: we call setZoom(1) after the board renders (seed triggers a fitView
   * which resets zoom). Once zoom == 1: screen-px drag maps 1:1 to board-px.
   * A 90px screen drag → 90 board px → tokenFromHeight(90) = 'XL'
   * (thresholds in textStyle.ts: < 24 → S · < 40 → M · < 70 → L · ≥ 70 → XL).
   * Button and well coords are re-read AFTER zoom settles to avoid stale screen positions.
   */
  test('Text tool drag makes a wrapped area text with a height-mapped size', async ({
    page,
    electronApp
  }) => {
    const planId = await seed(page, 'planning', { w: 560, h: 420 })

    // The board is selected after seed (addBoard sets selectedId), so the tool strip is
    // rendered. Poll for the Text tool button to confirm the board has mounted and React
    // has rendered the toolbar row.
    await expect
      .poll(() => boardBtnCenter(page, planId, 'button[title="text"]'), {
        message: 'Text tool button appeared in the planning board toolbar',
        timeout: 4000
      })
      .not.toBeNull()

    // Force zoom = 1 AFTER the board has rendered (seed + first fitView sets it to ~1.5+).
    // At zoom=1: screen-px drag == board-px → a 90px drag → tokenFromHeight(90) = 'XL'.
    await evalIn(page, `window.__canvasE2E.setZoom(1)`)

    // Poll until the RF viewport DOM transform actually reflects zoom=1 (zoomTo schedules
    // a rAF before the transform updates in the DOM — same pattern as placement.e2e.ts).
    await expect
      .poll(() => rfZoom(page), { message: 'RF viewport zoom settled to 1', timeout: 3000 })
      // numDigits=1 → tolerance ±0.05 (absorbs one rAF transit frame); do NOT tighten to
      // toBeCloseTo(1, 3) — sub-0.05 settle jitter would make this flaky.
      .toBeCloseTo(1, 1)

    // Re-read button and well coords NOW (they shifted when zoom changed).
    const tbtn = await boardBtnCenter(page, planId, 'button[title="text"]')
    expect(tbtn, 'Text tool button visible at zoom=1').not.toBeNull()

    // Click the Text tool button with real OS input.
    await mainCall(electronApp, 'sendInput', {
      type: 'mouseDown',
      x: tbtn!.cx,
      y: tbtn!.cy,
      button: 'left',
      clickCount: 1
    })
    await mainCall(electronApp, 'sendInput', {
      type: 'mouseUp',
      x: tbtn!.cx,
      y: tbtn!.cy,
      button: 'left',
      clickCount: 1
    })

    // Read the well's top-left to compute absolute drag start coords.
    const well = await evalIn<{ x: number; y: number }>(
      page,
      `(() => {
         const n = document.querySelector('.react-flow__node[data-id=${JSON.stringify(planId)}]');
         const w = n && n.querySelector('.pl-well');
         if (!w) return { x: 200, y: 200 };
         const r = w.getBoundingClientRect();
         return { x: Math.round(r.left + 60), y: Math.round(r.top + 60) };
       })()`
    )

    // Drag a wide (220px) × tall (90px) box inside the well.
    // At zoom=1: board width = 220px (≥ MIN_TEXT_WIDTH_PX=40); board height = 90px
    // → tokenFromHeight(90) = 'XL'. Drag clearly exceeds the 4px no-drag threshold.
    //
    // Input strategy: `sendInput mouseDown` starts the gesture (real OS event, required for
    // correct hit-testing through the camera transform). Then Playwright CDP `page.mouse.move`
    // drives the moves — the `setPointerCapture` that `onWellPointerDown` sets means events
    // go to the well regardless of where the mouse is, so CDP mouse moves are reliable here.
    // `sendInput mouseUp` closes the gesture.
    //
    // Sequencing: poll for the draft-textbox preview element after mouseDown to confirm the
    // renderer processed the pointerdown before we send moves (sendInput queues events in the
    // main process; the renderer is async — moves sent before the down is processed land when
    // drag.current is still null and are silently dropped by onWellPointerMove's null-guard).
    await mainCall(electronApp, 'sendInput', {
      type: 'mouseDown',
      x: well.x,
      y: well.y,
      button: 'left',
      clickCount: 1
    })
    // Wait for the draft-preview element to confirm the pointerdown was processed.
    const downProcessed = await pollEval(
      page,
      `!!document.querySelector('.react-flow__node[data-id=${JSON.stringify(planId)}] .pl-well [aria-hidden="true"]')`,
      2000
    )
    expect(downProcessed, 'draft textbox preview appeared after mouseDown').toBe(true)

    // Send moves via CDP (page.mouse) — more reliable for pointer-captured elements than
    // sendInput, which doesn't route through the browser's pointer-capture machinery.
    await page.mouse.move(well.x + 10, well.y + 5)
    await page.mouse.move(well.x + 110, well.y + 45)
    await page.mouse.move(well.x + 220, well.y + 90)

    await mainCall(electronApp, 'sendInput', {
      type: 'mouseUp',
      x: well.x + 220,
      y: well.y + 90,
      button: 'left',
      clickCount: 1
    })

    // Poll until the board has a text element with a width (area text) and XL fontSize.
    // getBoards() returns Board[] with .elements directly (PlanningBoard has
    // `elements: PlanningElement[]` — NOT `data.elements`; confirmed from e2eHooks.ts
    // and textToolbar.e2e.ts line 103).
    const ok = await pollEval(
      page,
      `(() => {
         const b = window.__canvasE2E.getBoards().find(b => b.id === ${JSON.stringify(planId)});
         if (!b || b.type !== 'planning') return false;
         const t = b.elements.find(e => e.kind === 'text');
         return !!t && typeof t.width === 'number' && t.width >= 40 && t.fontSize === 'XL';
       })()`,
      4000
    )
    expect(ok, 'area text element with width >= 40 and fontSize XL appeared in the store').toBe(
      true
    )
  })

  /**
   * Test B — Typing in a fresh text shows the toolbar before any grip-select.
   *
   * A freshly-mounted empty FreeText auto-focuses its textarea (FreeText.tsx useEffect on
   * element.text === ''). patchBoard adds the element; once React renders it the textarea
   * auto-focuses and onEditingChange fires → editingTextId is set → toolbarTextEl resolves
   * → TextToolbar renders. We call .focus() in the poll expression to make it deterministic
   * on slower runs where the auto-focus may arrive after the first eval tick.
   */
  test('typing in a fresh text shows the toolbar before any grip-select', async ({ page }) => {
    const planId = await seed(page, 'planning', { w: 520, h: 400 })

    // Inject an empty text element via patchBoard — same shape as textToolbar.e2e.ts uses.
    await evalIn(
      page,
      `window.__canvasE2E.patchBoard(${JSON.stringify(planId)}, { elements: [
        { id: 'txt', kind: 'text', x: 120, y: 140, text: '' }
      ] })`
    )

    // Poll: focus the textarea (if not already auto-focused) then check the toolbar exists.
    // The toolbar class is .pl-text-toolbar (TextToolbar.tsx className="pl-text-toolbar").
    // The textarea is inside .pl-text (FreeText.tsx className="pl-text").
    const shown = await pollEval(
      page,
      `(() => {
         const n = document.querySelector('.react-flow__node[data-id=${JSON.stringify(planId)}]');
         if (!n) return false;
         const ta = n.querySelector('.pl-text textarea');
         if (ta) ta.focus();
         return !!(n.querySelector('.pl-text-toolbar'));
       })()`,
      3000
    )
    expect(shown, 'TextToolbar appeared from editing alone (no grip-select)').toBe(true)
  })
})
