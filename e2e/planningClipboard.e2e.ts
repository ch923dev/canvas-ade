import { test, expect } from './fixtures'
import { seed } from './helpers'
import type { Page } from '@playwright/test'

/**
 * @planning — cross-board element clipboard, Phase 3 (Ctrl+C / Ctrl+X / Ctrl+V). The real-app
 * sliver the jsdom hook/integration tests can't prove: real-OS modifier-chord delivery into the
 * focused `.pl-well` THROUGH the camera transform, and that a paste lands on the board whose well
 * holds focus (cross-board). Asserts off `getBoards()`: Copy adds to the target while the source
 * is untouched; paste-twice yields two distinct sets; Cut re-homes (locked stays in source) and
 * each clipboard action is its OWN undo step (one Ctrl+Z per step). The placement math + the
 * exact lock/checkpoint semantics are pinned in the hook unit/integration tests.
 *
 * Renderer state crosses via structured-arg page.evaluate — ids flow as DATA, never interpolated
 * into eval'd code (CodeQL js/bad-code-sanitization, #82 pattern).
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

/** Element ids of a planning board (to prove fresh-id pasted copies never collide). */
function planningIds(page: Page, boardId: string): Promise<string[]> {
  return page.evaluate((id) => {
    const boards = (globalThis as any).__canvasE2E.getBoards() as {
      id: string
      type: string
      elements?: { id: string }[]
    }[]
    const b = boards.find((x) => x.id === id)
    return b && b.type === 'planning' ? (b.elements ?? []).map((e) => e.id) : []
  }, boardId)
}

/** Seed text-bearing notes (text ⇒ no blur-prune) into a planning board. */
async function seedNotes(
  page: Page,
  boardId: string,
  notes: Record<string, unknown>[]
): Promise<void> {
  await page.evaluate(
    ({ boardId, elements }) => {
      ;(globalThis as any).__canvasE2E.patchBoard(boardId, { elements })
    },
    { boardId, elements: notes }
  )
}

const note = (
  id: string,
  x: number,
  y: number,
  over: Record<string, unknown> = {}
): Record<string, unknown> => ({
  id,
  kind: 'note',
  x,
  y,
  w: 156,
  h: 96,
  tint: 'yellow',
  text: id,
  rotation: 0,
  ...over
})

/** Marquee across A's whole well → selects every note in it; also natively focuses A's well. */
async function marqueeSelectAll(page: Page, boardId: string): Promise<void> {
  const box = await page.locator(`[data-id="${boardId}"] .pl-well`).boundingBox()
  if (!box) throw new Error(`planning well ${boardId} not on screen`)
  await page.mouse.move(box.x + 5, box.y + 5)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width - 5, box.y + box.height - 5, { steps: 8 })
  await page.mouse.up()
}

const undo = (page: Page): Promise<void> =>
  page.evaluate(() => (globalThis as any).__canvasE2E.undo())

test.describe('@planning element clipboard (Ctrl+C/X/V, real OS input)', () => {
  test('Ctrl+C in A → Ctrl+V in B copies (A intact); paste twice = two sets; one undo per step', async ({
    page
  }) => {
    const a = await seed(page, 'planning', { title: 'Plan A' })
    const b = await seed(page, 'planning', { title: 'Plan B' })
    await seedNotes(page, a, [note('na', 40, 40), note('nb', 260, 160)])
    // Fit ALL boards so BOTH wells are on screen + hittable (paste needs B focused).
    await page.evaluate(() => (globalThis as any).__canvasE2E.fitView())
    await page.waitForTimeout(300)

    // Select both notes in A, copy.
    await marqueeSelectAll(page, a)
    await page.keyboard.press('Control+c')

    // Focus B (click its empty well) and paste — the focused board receives the copies.
    await page.locator(`[data-id="${b}"] .pl-well`).click()
    await page.keyboard.press('Control+v')
    await expect.poll(async () => (await planningCounts(page))[b]).toBe(2)
    expect((await planningCounts(page))[a]).toBe(2) // source untouched (copy)

    // Fresh ids — B's pasted ids never collide with A's source ids.
    const aIds = await planningIds(page, a)
    const bIds = await planningIds(page, b)
    expect(bIds.every((id) => !aIds.includes(id))).toBe(true)

    // Paste again → a second distinct set (B now holds 4).
    await page.keyboard.press('Control+v')
    await expect.poll(async () => (await planningCounts(page))[b]).toBe(4)

    // Each paste is its OWN undo step — one Ctrl+Z per paste.
    await undo(page)
    await expect.poll(async () => (await planningCounts(page))[b]).toBe(2)
    await undo(page)
    await expect.poll(async () => (await planningCounts(page))[b]).toBe(0)
    expect((await planningCounts(page))[a]).toBe(2) // A never moved
  })

  test('Ctrl+X cuts (locked stays in A) → Ctrl+V in B; one undo restores each step', async ({
    page
  }) => {
    const a = await seed(page, 'planning', { title: 'Plan A' })
    const b = await seed(page, 'planning', { title: 'Plan B' })
    await seedNotes(page, a, [note('na', 40, 40), note('nb', 260, 160, { locked: true })])
    await page.evaluate(() => (globalThis as any).__canvasE2E.fitView())
    await page.waitForTimeout(300)

    // Marquee both (the locked + the unlocked), then cut.
    await marqueeSelectAll(page, a)
    await page.keyboard.press('Control+x')

    // Lock-precedence: the unlocked note is cut; the locked one STAYS in A.
    await expect.poll(async () => (await planningCounts(page))[a]).toBe(1)
    expect(await planningIds(page, a)).toEqual(['nb'])

    // Paste into B — only the unlocked note rode onto the clipboard.
    await page.locator(`[data-id="${b}"] .pl-well`).click()
    await page.keyboard.press('Control+v')
    await expect.poll(async () => (await planningCounts(page))[b]).toBe(1)

    // Cut + paste are TWO undo steps — one Ctrl+Z undoes the paste, another the cut.
    await undo(page)
    await expect.poll(async () => (await planningCounts(page))[b]).toBe(0)
    await undo(page)
    await expect.poll(async () => (await planningCounts(page))[a]).toBe(2) // cut restored both notes
  })
})
