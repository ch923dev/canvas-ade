import { test, expect } from './fixtures'
import { seed } from './helpers'
import type { Page } from '@playwright/test'

/**
 * @planning — cross-board element transfer, Phase 2 picker (SendToBoardPanel). The real-app
 * sliver the jsdom hook/component tests can't prove: the full menu → picker → transfer wiring
 * driven through REAL OS input (a marquee select + a right-click that opens the element menu
 * THROUGH the camera transform, then a click on the portaled picker). Asserts off `getBoards()`:
 * Copy adds to the target while the source is untouched; Move re-homes (and ONE undo restores
 * BOTH boards — the single-undo-step contract); "+ New planning board" spawns a board that
 * holds the elements. The placement math + toast are pinned in useSendToBoard.test.tsx.
 *
 * Renderer state crosses via structured-arg page.evaluate — ids flow as DATA, never
 * interpolated into eval'd code (CodeQL js/bad-code-sanitization, #82 pattern).
 */

/** Per-planning-board element counts, keyed by board id. */
function planningCounts(page: Page): Promise<Record<string, number>> {
  return page.evaluate(() => {
    const boards = (globalThis as any).__canvasE2E.getBoards() as {
      id: string
      type: string
      elements?: unknown[]
    }[]
    const out: Record<string, number> = {}
    for (const b of boards) if (b.type === 'planning') out[b.id] = (b.elements ?? []).length
    return out
  })
}

/** Seed two text-bearing notes (text ⇒ no blur-prune) into a planning board. */
async function seedTwoNotes(page: Page, boardId: string): Promise<void> {
  await page.evaluate(
    ({ boardId, elements }) => {
      ;(globalThis as any).__canvasE2E.patchBoard(boardId, { elements })
    },
    {
      boardId,
      elements: [
        {
          id: 'st-a',
          kind: 'note',
          x: 40,
          y: 40,
          w: 156,
          h: 96,
          tint: 'yellow',
          text: 'A',
          rotation: 0
        },
        {
          id: 'st-b',
          kind: 'note',
          x: 260,
          y: 160,
          w: 156,
          h: 96,
          tint: 'blue',
          text: 'B',
          rotation: 0
        }
      ]
    }
  )
}

test.describe('@planning send-to-board picker (cross-board element transfer)', () => {
  test('Copy keeps the source, Move re-homes (one undo restores both), New spawns a board', async ({
    page
  }) => {
    const a = await seed(page, 'planning', { title: 'Plan A' })
    const b = await seed(page, 'planning', { title: 'Plan B' })
    await seedTwoNotes(page, a)
    // Fit board A so its notes are large + reliably hittable (B is chosen by title, not on screen).
    await page.evaluate((id) => (globalThis as any).__canvasE2E.fitView(id), a)
    await page.waitForTimeout(300)

    // Open the picker for A's (multi-)selection: a REAL marquee across both notes, then a
    // right-click on a note opens the element menu, and "Send to board…" opens the picker.
    const openPickerForA = async (): Promise<void> => {
      const well = page.locator(`[data-id="${a}"] .pl-well`)
      const box = await well.boundingBox()
      if (!box) throw new Error('planning well A not on screen')
      await page.mouse.move(box.x + 5, box.y + 5)
      await page.mouse.down()
      await page.mouse.move(box.x + box.width - 5, box.y + box.height - 5, { steps: 8 })
      await page.mouse.up()
      // Right-click the note's grip RING (not its textarea center) so the contextmenu bubbles to
      // the well with the note under the cursor — the proven hittable spot (planningKeyboard.e2e).
      await page
        .locator(`[data-id="${a}"] .pl-note-grip`)
        .first()
        .click({ button: 'right', position: { x: 6, y: 6 } })
      await page.locator('[data-testid="w3-menu-send-to-board"]').click()
      await expect(page.locator('.pl-sendto')).toBeVisible()
    }

    // 1. Copy → Plan B. B gains both; A is untouched (copy).
    await openPickerForA()
    await page.locator('.pl-sendto').getByRole('radio', { name: 'Copy' }).click()
    await page.locator('.pl-sendto-board', { hasText: 'Plan B' }).click()
    await expect.poll(async () => (await planningCounts(page))[b]).toBe(2)
    expect((await planningCounts(page))[a]).toBe(2)

    // 2. Move → Plan B (default mode). A loses both; B now holds 4.
    await openPickerForA()
    await page.locator('.pl-sendto-board', { hasText: 'Plan B' }).click()
    await expect.poll(async () => (await planningCounts(page))[a]).toBe(0)
    expect((await planningCounts(page))[b]).toBe(4)

    // ONE undo restores BOTH boards (the single coalesced transfer step).
    await page.evaluate(() => (globalThis as any).__canvasE2E.undo())
    await expect.poll(async () => (await planningCounts(page))[a]).toBe(2)
    expect((await planningCounts(page))[b]).toBe(2)

    // 3. "+ New planning board" → a fresh planning board holds the (moved) elements.
    const boardsBefore = await page.evaluate(
      () => (globalThis as any).__canvasE2E.getBoards().length
    )
    await openPickerForA()
    await page.locator('.pl-sendto-board', { hasText: 'New planning board' }).click()
    await expect
      .poll(async () => page.evaluate(() => (globalThis as any).__canvasE2E.getBoards().length))
      .toBe(boardsBefore + 1)
    const freshCount = await page.evaluate(
      ({ a, b }) => {
        const boards = (globalThis as any).__canvasE2E.getBoards() as {
          id: string
          type: string
          elements?: unknown[]
        }[]
        const fresh = boards.find((x) => x.type === 'planning' && x.id !== a && x.id !== b)
        return fresh ? (fresh.elements ?? []).length : -1
      },
      { a, b }
    )
    expect(freshCount).toBe(2)
  })
})
