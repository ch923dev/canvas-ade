import { test, expect } from './fixtures'
import { callE2E, evalIn, seed } from './helpers'

test.describe('@chrome board ⋯ menu (real layout / native occlusion)', () => {
  test('⋯ trigger stays in the title bar + popover clamps on-screen + visible at rest', async ({
    page
  }) => {
    const id = await seed(page, 'terminal', { launchCommand: 'echo menu', w: 150 })
    await callE2E(page, { m: 'fitView', a: [id] })
    await evalIn(page, 'window.__canvasE2E.setZoom(1)')
    await page.waitForTimeout(150)
    // The board id crosses as a STRUCTURED ARG (never interpolated into eval'd code —
    // CodeQL js/bad-code-sanitization); the probe body is otherwise verbatim.
    const chrome = await page.evaluate<
      { found: boolean; triggerInBar: boolean; restColor: string; inViewport: boolean },
      string
    >(async (boardId) => {
      const g = globalThis as any
      const sleep = (ms: number): Promise<unknown> => new Promise((r) => setTimeout(r, ms))
      const sel = (s: string, root?: any): any => (root || g.document).querySelector(s)
      const node = sel('.react-flow__node[data-id=' + JSON.stringify(boardId) + ']')
      const bar = node && sel('.board-titlebar', node)
      const more = node && sel('button[title="More"]', node)
      if (!bar || !more)
        return { found: false, triggerInBar: false, restColor: '', inViewport: false }
      const b = bar.getBoundingClientRect()
      const t = more.getBoundingClientRect()
      const triggerInBar = t.width > 0 && t.left >= b.left - 0.5 && t.right <= b.right + 0.5
      const svg = more.querySelector('svg')
      const restColor = svg ? g.getComputedStyle(svg).color : ''
      const overshoot = g.innerWidth - t.right + 40
      g.__canvasE2E.panBy(overshoot, 0)
      await sleep(80)
      const more2 = sel('button[title="More"]', node)
      more2.click()
      await sleep(80)
      const menu = sel('.board-menu')
      const m = menu && menu.getBoundingClientRect()
      const inViewport =
        !!m && m.left >= 0 && m.top >= 0 && m.right <= g.innerWidth && m.bottom <= g.innerHeight
      more2.click()
      await sleep(40)
      g.__canvasE2E.panBy(-overshoot, 0)
      return { found: true, triggerInBar, restColor, inViewport }
    }, id)
    expect(chrome.found).toBe(true)
    expect(chrome.triggerInBar, '⋯ within the title bar (13)').toBe(true)
    expect(chrome.inViewport, 'popover clamps on-screen (14)').toBe(true)
    expect(chrome.restColor, 'rest colour resolves the CSS var').toBe('rgb(155, 155, 161)')
  })
  // (The "open ⋯ menu detaches the live preview (un-occludes the popover)" test was dropped in OS-3
  // Phase 5: OSR is the default engine and its canvas is a clipped DOM node the popover renders over
  // — there is no native view to occlusion-detach when the menu opens.)
})
