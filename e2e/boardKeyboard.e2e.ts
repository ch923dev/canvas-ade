/**
 * D4-B keyboard-first canvas (audit A3/A4) — the real-app slivers jsdom can't prove:
 * real-OS Tab/arrow/Enter delivery through the window keymap (the mid-dispatch
 * listener-removal class only real input catches), key-repeat burst coalescing into
 * ONE undo step (real down…down…up), the A3 focus-return from a focused NATIVE
 * preview view (before-input-event → host webContents.focus — pure main-process
 * behavior), and the negative probes: Tab/arrows from a focused xterm or planning
 * well must NOT drive board selection (the whitelist guard + D3-C's element-level
 * arrows own those surfaces). The component contract (cycle order, deltas, clamps,
 * checkpoint discipline) is pinned in useBoardKeyboardNav.test.tsx.
 *
 * Renderer state crosses via structured-arg page.evaluate — ids flow as DATA, never
 * interpolated into eval'd code (CodeQL js/bad-code-sanitization, #82 pattern).
 */
import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { evalIn, mainCall, seed } from './helpers'

interface BoardLite {
  id: string
  x: number
  y: number
  w: number
  h: number
}

const getSelection = (page: Page): Promise<string[]> =>
  evalIn<string[]>(page, `window.__canvasE2E.getSelection()`)

const getViewport = (page: Page): Promise<{ x: number; y: number; zoom: number }> =>
  evalIn<{ x: number; y: number; zoom: number }>(page, `window.__canvasE2E.getViewport()`)

const boardOf = (page: Page, id: string): Promise<BoardLite | undefined> =>
  page.evaluate((boardId) => {
    const boards = (globalThis as any).__canvasE2E.getBoards() as BoardLite[]
    const b = boards.find((x) => x.id === boardId)
    return b ? { id: b.id, x: b.x, y: b.y, w: b.w, h: b.h } : undefined
  }, id)

const select = (page: Page, ids: string[]): Promise<void> =>
  page.evaluate((sel) => (globalThis as any).__canvasE2E.setSelection(sel), ids)

/** Seed `n` planning boards (cheap: no PTY, no native view). seedBoard staggers x at a
 *  shared y, so spatial reading order (y, then x) === seed order. Selection cleared. */
async function seedPlanningRow(page: Page, n: number): Promise<string[]> {
  const ids: string[] = []
  for (let i = 0; i < n; i++) ids.push(await seed(page, 'planning'))
  await select(page, [])
  await evalIn(page, `window.__canvasE2E.fitView()`)
  await page.waitForTimeout(300)
  return ids
}

test.describe('@chrome board keyboard nav (real OS input, D4-B)', () => {
  test('Tab cycles selection in reading order; Shift+Tab reverses; wraps', async ({ page }) => {
    const [a, b, c] = await seedPlanningRow(page, 3)

    await page.keyboard.press('Tab') // nothing selected → enters at the first board
    await expect.poll(() => getSelection(page)).toEqual([a])
    await page.keyboard.press('Tab')
    await expect.poll(() => getSelection(page)).toEqual([b])
    await page.keyboard.press('Shift+Tab')
    await expect.poll(() => getSelection(page)).toEqual([a])
    await page.keyboard.press('Shift+Tab') // wraps backward to the last board
    await expect.poll(() => getSelection(page)).toEqual([c])
  })

  test('a real key-repeat arrow burst moves the board and undoes as ONE step', async ({ page }) => {
    const [a] = await seedPlanningRow(page, 1)
    await select(page, [a])
    const before = (await boardOf(page, a))!

    // Real key-repeat grammar: repeated keydown, ONE keyup — exactly what holding the
    // key produces. The whole burst must coalesce into a single undo step.
    await page.keyboard.down('ArrowRight')
    await page.keyboard.down('ArrowRight')
    await page.keyboard.down('ArrowRight')
    await page.keyboard.up('ArrowRight')
    await expect.poll(async () => (await boardOf(page, a))?.x).toBe(before.x + 3)

    // Shift = 10px (a separate burst — the keyup above ended the first).
    await page.keyboard.press('Shift+ArrowDown')
    await expect.poll(async () => (await boardOf(page, a))?.y).toBe(before.y + 10)

    // Two bursts → exactly two undo steps back to the origin.
    await evalIn(page, `window.__canvasE2E.undo()`)
    await expect.poll(async () => (await boardOf(page, a))?.y).toBe(before.y)
    await evalIn(page, `window.__canvasE2E.undo()`)
    await expect.poll(async () => (await boardOf(page, a))?.x).toBe(before.x)
  })

  test('Alt+arrows resize the selected board', async ({ page }) => {
    const [a] = await seedPlanningRow(page, 1)
    await select(page, [a])
    const before = (await boardOf(page, a))!

    await page.keyboard.press('Alt+ArrowRight')
    await expect.poll(async () => (await boardOf(page, a))?.w).toBe(before.w + 1)
    await page.keyboard.press('Shift+Alt+ArrowDown')
    await expect.poll(async () => (await boardOf(page, a))?.h).toBe(before.h + 10)
    // Plain arrow afterwards still MOVES (the Alt keyup ended the resize burst).
    await page.keyboard.press('ArrowLeft')
    await expect.poll(async () => (await boardOf(page, a))?.x).toBe(before.x - 1)
  })

  test('Enter camera-focuses the selected board (the double-click fit path)', async ({ page }) => {
    const ids = await seedPlanningRow(page, 3)
    await select(page, [ids[1]])
    const vpBefore = await getViewport(page)

    await page.keyboard.press('Enter')
    // Focus-fit zooms in on the single board from the 3-board fit — the camera must move.
    await expect
      .poll(async () => {
        const vp = await getViewport(page)
        return vp.zoom !== vpBefore.zoom || vp.x !== vpBefore.x || vp.y !== vpBefore.y
      })
      .toBe(true)
    expect((await getViewport(page)).zoom).toBeGreaterThan(vpBefore.zoom)

    // Esc exits focus mode (clearSelection path) — selection empties.
    await page.keyboard.press('Escape')
    await expect.poll(() => getSelection(page)).toEqual([])
  })

  test('A3: Esc inside a focused native preview returns focus + selects the board', async ({
    page,
    electronApp
  }) => {
    const url = await mainCall<string>(electronApp, 'localUrl')
    const browserId = await seed(page, 'browser', { url })
    const planId = await seed(page, 'planning')
    await select(page, [])
    await evalIn(page, `window.__canvasE2E.fitView()`)
    await expect
      .poll(
        () =>
          page.evaluate((id) => {
            const r = (globalThis as any).__canvasE2E.getRuntime(id)
            return !!r && r.status === 'connected'
          }, browserId),
        { timeout: 10_000 }
      )
      .toBe(true)

    // A user clicking into the preview = the native view's webContents takes OS focus;
    // the renderer window can no longer see the keyboard (the A3 trap).
    expect(await mainCall<boolean>(electronApp, 'focusView', browserId)).toBe(true)
    await expect.poll(() => mainCall<boolean>(electronApp, 'hostFocused')).toBe(false)

    // Real Esc through the VIEW's webContents → before-input-event forwards + main
    // hands focus back to the host window; the renderer selects the board.
    expect(
      await mainCall<boolean>(electronApp, 'sendInputToView', browserId, {
        type: 'keyDown',
        keyCode: 'Escape'
      })
    ).toBe(true)
    await mainCall(electronApp, 'sendInputToView', browserId, {
      type: 'keyUp',
      keyCode: 'Escape'
    })
    await expect.poll(() => mainCall<boolean>(electronApp, 'hostFocused')).toBe(true)
    await expect.poll(() => getSelection(page)).toEqual([browserId])

    // The keyboard is genuinely live again: Tab continues the cycle from that board.
    await page.keyboard.press('Tab')
    await expect.poll(() => getSelection(page)).toEqual([planId])
  })

  test('negative: Tab/arrows in a focused xterm do not drive board selection', async ({ page }) => {
    const termId = await seed(page, 'terminal')
    const planId = await seed(page, 'planning')
    await select(page, [planId])
    const before = (await boardOf(page, planId))!

    // Focus the terminal's xterm (its helper textarea takes real focus).
    await expect
      .poll(() =>
        page.evaluate((id) => (globalThis as any).__canvasE2E.terminalMounted(id), termId)
      )
      .toBe(true)
    await page.evaluate((id) => (globalThis as any).__canvasE2E.focusTerminal(id), termId)
    await expect
      .poll(() => evalIn<string>(page, `(document.activeElement?.className || '')`))
      .toContain('xterm-helper-textarea')

    await page.keyboard.press('Tab')
    await page.keyboard.press('ArrowRight')
    await page.waitForTimeout(200)
    // Board selection and geometry are untouched — the keys belonged to the terminal.
    expect(await getSelection(page)).toEqual([planId])
    expect((await boardOf(page, planId))!.x).toBe(before.x)
  })

  test('negative: arrows in a focused planning well nudge the ELEMENT, never the board', async ({
    page
  }) => {
    const planId = await seed(page, 'planning')
    await page.evaluate(
      ({ boardId, elements }) => {
        ;(globalThis as any).__canvasE2E.patchBoard(boardId, { elements })
      },
      {
        boardId: planId,
        elements: [
          {
            id: 'kb-neg',
            kind: 'note',
            x: 40,
            y: 40,
            w: 156,
            h: 96,
            tint: 'yellow',
            text: 'N',
            rotation: 0
          }
        ]
      }
    )
    await evalIn(page, `window.__canvasE2E.fitView()`)
    await page.waitForTimeout(300)
    const boardBefore = (await boardOf(page, planId))!

    // Real grip click: selects the note + native focus routing lands on the well
    // (the D3-C precondition).
    await page
      .locator(`[data-id="${planId}"] .pl-note-grip`)
      .first()
      .click({ position: { x: 6, y: 6 } })
    await expect
      .poll(() => evalIn<string>(page, `(document.activeElement?.className || '')`))
      .toContain('pl-well')

    await page.keyboard.press('ArrowRight')
    // The element nudged (D3-C owns arrows there)…
    await expect
      .poll(() =>
        page.evaluate((id) => {
          const boards = (globalThis as any).__canvasE2E.getBoards() as {
            id: string
            elements?: { id: string; x: number }[]
          }[]
          return boards.find((b) => b.id === id)?.elements?.find((e) => e.id === 'kb-neg')?.x
        }, planId)
      )
      .toBe(41)
    // …and the BOARD did not move (the whitelist guard kept the canvas keymap out).
    expect((await boardOf(page, planId))!.x).toBe(boardBefore.x)

    // Tab from the well must not cycle board selection either.
    const selBefore = await getSelection(page)
    await page.keyboard.press('Tab')
    await page.waitForTimeout(200)
    expect(await getSelection(page)).toEqual(selBefore)
  })
})
