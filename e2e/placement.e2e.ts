import { test, expect } from './fixtures'
import { evalIn, mainCall, pollEval } from './helpers'

test.describe('@core drag-to-create board placement (real OS input through the camera)', () => {
  test('a drag creates a board sized to the rectangle', async ({ page, electronApp }) => {
    await evalIn(page, `window.__canvasE2E.setZoom(1)`) // world size == screen drag size
    await evalIn(page, `window.__canvasE2E.setTool('terminal')`)
    // wait for the capture overlay to mount before driving OS input at it
    expect(await pollEval(page, `!!document.querySelector('.placement-capture')`, 2000)).toBe(true)
    expect(await evalIn<number>(page, `window.__canvasE2E.getBoards().length`)).toBe(0)

    const drag = async (x1: number, y1: number, x2: number, y2: number): Promise<void> => {
      await mainCall(electronApp, 'sendInput', {
        type: 'mouseDown',
        x: x1,
        y: y1,
        button: 'left',
        clickCount: 1
      })
      await mainCall(electronApp, 'sendInput', { type: 'mouseMove', x: x2, y: y2, button: 'left' })
      await mainCall(electronApp, 'sendInput', {
        type: 'mouseUp',
        x: x2,
        y: y2,
        button: 'left',
        clickCount: 1
      })
    }
    await drag(420, 360, 720, 580) // 300 x 220, lower-middle (clear of the top chrome)

    expect(await pollEval(page, `window.__canvasE2E.getBoards().length === 1`, 4000)).toBe(true)
    const b = await evalIn<{ type: string; w: number; h: number }>(
      page,
      `(() => { const b = window.__canvasE2E.getBoards()[0]; return { type: b.type, w: b.w, h: b.h }; })()`
    )
    expect(b.type).toBe('terminal')
    expect(Math.abs(b.w - 300)).toBeLessThanOrEqual(10)
    expect(Math.abs(b.h - 220)).toBeLessThanOrEqual(10)
    expect(await evalIn<string>(page, `window.__canvasE2E.getTool()`)).toBe('select') // reverted after create
  })

  test('a click spawns a default-size board', async ({ page, electronApp }) => {
    await evalIn(page, `window.__canvasE2E.setTool('browser')`)
    expect(await pollEval(page, `!!document.querySelector('.placement-capture')`, 2000)).toBe(true)
    await mainCall(electronApp, 'sendInput', {
      type: 'mouseDown',
      x: 500,
      y: 500,
      button: 'left',
      clickCount: 1
    })
    await mainCall(electronApp, 'sendInput', {
      type: 'mouseUp',
      x: 501,
      y: 500,
      button: 'left',
      clickCount: 1
    })
    expect(await pollEval(page, `window.__canvasE2E.getBoards().length === 1`, 4000)).toBe(true)
    const b = await evalIn<{ type: string; w: number; h: number }>(
      page,
      `(() => { const b = window.__canvasE2E.getBoards()[0]; return { type: b.type, w: b.w, h: b.h }; })()`
    )
    expect(b).toEqual({ type: 'browser', w: 700, h: 500 }) // DEFAULT_BOARD_SIZE.browser
  })

  test('Escape while armed cancels — no board, tool back to select', async ({ page }) => {
    await evalIn(page, `window.__canvasE2E.setTool('planning')`)
    expect(await pollEval(page, `!!document.querySelector('.placement-capture')`, 2000)).toBe(true)
    await page.keyboard.press('Escape')
    expect(await evalIn<number>(page, `window.__canvasE2E.getBoards().length`)).toBe(0)
    expect(await evalIn<string>(page, `window.__canvasE2E.getTool()`)).toBe('select')
  })
})
