import { test, expect } from './fixtures'
import { callE2E, mainCall, seed } from './helpers'
import { type Page } from '@playwright/test'

// Poll until `read` (a renderer probe returning `{cx,cy}` screen coords, or null when
// not ready) yields coords, then return them. Reading the rect INSIDE the poll keeps the
// coordinate read atomic with the readiness check — a separate post-poll read could race a
// floating element (e.g. the toolbar) still settling its position and then click stale coords.
async function pollRect(
  read: () => Promise<{ cx: number; cy: number } | null>,
  message: string,
  timeout = 4000
): Promise<{ cx: number; cy: number }> {
  let rect: { cx: number; cy: number } | null = null
  await expect
    .poll(
      async () => {
        rect = await read()
        return rect !== null
      },
      { message, timeout }
    )
    .toBe(true)
  return rect!
}

/** Screen-centre of `innerSel` inside the board node — both the board id and the selector cross
 *  as STRUCTURED ARGS (never interpolated into eval'd code; CodeQL js/bad-code-sanitization). */
function rectOf(
  page: Page,
  id: string,
  innerSel: string
): Promise<{ cx: number; cy: number } | null> {
  return page.evaluate(
    (a) => {
      const g = globalThis as any
      const node = g.document.querySelector(
        '.react-flow__node[data-id=' + JSON.stringify(a.id) + ']'
      )
      const el = node && node.querySelector(a.innerSel)
      if (!el) return null
      const r = el.getBoundingClientRect()
      if (!(r.width > 0)) return null
      return { cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2) }
    },
    { id, innerSel }
  )
}

test.describe('@planning text font toolbar (real OS input)', () => {
  test('select a text element → toolbar → click size L → persists fontSize', async ({
    page,
    electronApp
  }) => {
    const planId = await seed(page, 'planning')
    await callE2E(page, {
      m: 'patchBoard',
      a: [
        planId,
        { w: 520, h: 400, elements: [{ id: 'txt', kind: 'text', x: 160, y: 160, text: 'Hello' }] }
      ]
    })
    // Select the text by a real OS press on its drag grip (coords read atomically — the
    // pollRect below self-waits for React Flow to render the grip, so no fixed sleep needed).
    const g = await pollRect(() => rectOf(page, planId, '.pl-text-grip'), 'text grip is on screen')
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
      () => rectOf(page, planId, '.pl-text-toolbar button[aria-label="size L"]'),
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

    // The store should reflect fontSize: 'L' — read the boards as VALUES and compare in Node.
    let persisted = false
    try {
      await expect
        .poll(
          async () => {
            const boards = await callE2E<
              Array<{
                id: string
                type: string
                elements?: Array<{ id: string; fontSize?: string }>
              }>
            >(page, { m: 'getBoards' })
            const b = boards.find((x) => x.id === planId)
            const t =
              b && b.type === 'planning' ? (b.elements ?? []).find((e) => e.id === 'txt') : null
            return !!t && t.fontSize === 'L'
          },
          { timeout: 4000 }
        )
        .toBe(true)
      persisted = true
    } catch {
      /* stays false — asserted with the message below */
    }
    expect(persisted, 'fontSize L persisted to the element').toBe(true)
  })
})
