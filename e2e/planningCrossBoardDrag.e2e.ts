import { test, expect } from './fixtures'
import { seed } from './helpers'
import type { Page } from '@playwright/test'

/**
 * @planning — cross-board element transfer, Phase 4 cross-board DRAG (spec §3.C). The sliver
 * jsdom/unit can't prove: the gesture is ENTIRELY `document.elementFromPoint` hit-testing across
 * two CSS-transformed boards, so it MUST be driven through REAL OS input — Playwright's
 * `page.mouse` (CDP-trusted, real hit-testing), NOT synthetic `dispatchEvent`, which bypasses the
 * transform and false-greens (memory `e2e-sendinputevent-vs-dispatchevent`). Asserts off
 * `getBoards()`: a plain drag from A's note grip across to B's well RE-HOMES it (A loses it, B
 * gains it — Move); dropping back inside A is the UNCHANGED within-board drop (no transfer);
 * Alt-drag COPIES (source intact). The placement/clamp math is pinned in crossBoardDrag.test.ts.
 *
 * Renderer state crosses via structured-arg page.evaluate — ids/positions flow as DATA, never
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

/** The single note's board-local position in a board (null if the board has != 1 element). */
function soleElementPos(page: Page, boardId: string): Promise<{ x: number; y: number } | null> {
  return page.evaluate((id) => {
    const b = (globalThis as any).__canvasE2E
      .getBoards()
      .find((x: { id: string }) => x.id === id) as { elements?: { x: number; y: number }[] }
    const els = b?.elements ?? []
    return els.length === 1 ? { x: els[0].x, y: els[0].y } : null
  }, boardId)
}

/** Seed ONE text-bearing note (text ⇒ no empty-note blur-prune) into a planning board. */
async function seedNote(page: Page, boardId: string, x: number, y: number): Promise<void> {
  await page.evaluate(
    ({ boardId, el }) => {
      ;(globalThis as any).__canvasE2E.patchBoard(boardId, { elements: [el] })
    },
    {
      boardId,
      el: { id: 'dn-a', kind: 'note', x, y, w: 156, h: 96, tint: 'yellow', text: 'A', rotation: 0 }
    }
  )
}

/** Drag A's note grip to a target point via REAL mouse input (held Alt ⇒ copy). `to` is a
 *  screen point; the well-center variant is computed by the caller. */
async function dragNoteTo(
  page: Page,
  fromBoard: string,
  to: { x: number; y: number },
  opts: { alt?: boolean } = {}
): Promise<void> {
  const grip = page.locator(`[data-id="${fromBoard}"] .pl-note-grip`).first()
  const gb = await grip.boundingBox()
  if (!gb) throw new Error('source note grip not on screen')
  // Press near the grip's top-left padding band (its center is the textarea, which stops the
  // press) — the proven hittable spot (planningSendToBoard.e2e / planningKeyboard.e2e).
  await page.mouse.move(gb.x + 6, gb.y + 6)
  if (opts.alt) await page.keyboard.down('Alt')
  await page.mouse.down()
  // Step across so intermediate pointermoves fire the cross-board sub-mode + leave the source.
  await page.mouse.move(to.x, to.y, { steps: 14 })
  await page.mouse.up()
  if (opts.alt) await page.keyboard.up('Alt')
}

/** Screen center of a planning board's well. */
async function wellCenter(page: Page, boardId: string): Promise<{ x: number; y: number }> {
  const box = await page.locator(`[data-id="${boardId}"] .pl-well`).boundingBox()
  if (!box) throw new Error(`planning well ${boardId} not on screen`)
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

test.describe('@planning cross-board drag (Phase 4 — element transfer)', () => {
  test('plain drag re-homes to the target well; dropping back is within-board (no transfer)', async ({
    page
  }) => {
    const a = await seed(page, 'planning', { title: 'Drag A' })
    const b = await seed(page, 'planning', { title: 'Drag B' })
    await seedNote(page, a, 40, 40)
    // Fit ALL boards so both A and B are on screen + their wells are large enough to hit.
    await page.evaluate(() => (globalThis as any).__canvasE2E.fitView())
    await page.waitForTimeout(300)

    // 1. Plain drag A's note → B's well center: B gains it, A loses it (Move = one re-home).
    await dragNoteTo(page, a, await wellCenter(page, b))
    await expect.poll(async () => (await planningCounts(page))[b]).toBe(1)
    expect((await planningCounts(page))[a]).toBe(0)
    // It landed inside B (placement clamped ≥ 0, well within the board box).
    const pos = await soleElementPos(page, b)
    expect(pos).not.toBeNull()
    expect(pos!.x).toBeGreaterThanOrEqual(0)
    expect(pos!.y).toBeGreaterThanOrEqual(0)

    // ONE undo restores BOTH boards (the engine's single coalesced transfer step).
    await page.evaluate(() => (globalThis as any).__canvasE2E.undo())
    await expect.poll(async () => (await planningCounts(page))[a]).toBe(1)
    expect((await planningCounts(page))[b]).toBe(0)

    // 2. Drop back INSIDE the source well → the unchanged within-board move (no transfer):
    //    A keeps its note, B stays empty.
    await dragNoteTo(page, a, await wellCenter(page, a))
    await page.waitForTimeout(150)
    const counts = await planningCounts(page)
    expect(counts[a]).toBe(1)
    expect(counts[b]).toBe(0)
  })

  test('Alt-drag copies to the target (source intact)', async ({ page }) => {
    const a = await seed(page, 'planning', { title: 'Copy A' })
    const b = await seed(page, 'planning', { title: 'Copy B' })
    await seedNote(page, a, 40, 40)
    await page.evaluate(() => (globalThis as any).__canvasE2E.fitView())
    await page.waitForTimeout(300)

    // Alt held at grab ⇒ copy: B gains a duplicate, A is untouched.
    await dragNoteTo(page, a, await wellCenter(page, b), { alt: true })
    await expect.poll(async () => (await planningCounts(page))[b]).toBe(1)
    expect((await planningCounts(page))[a]).toBe(1)
  })
})
