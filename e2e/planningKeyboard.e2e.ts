import { test, expect } from './fixtures'
import { evalIn, seed } from './helpers'
import type { Page } from '@playwright/test'

/**
 * D3-C planning keyboard (audit A4 partial) — the real-app slivers jsdom can't prove:
 * real-OS key delivery into the focused `.pl-well` THROUGH the camera-transformed
 * canvas (a real grip click must focus the well via native focus routing — nothing
 * calls focus() for it), modifier chords reaching the React handler intact, and the
 * Shift+F10 menu opening on the shared D1-C shell (real Escape closes it — the
 * mid-dispatch listener-removal class only real input catches). The component
 * contract (deltas, burst-undo coalescing, lock/group precedence, checkpoint
 * discipline) is pinned in usePlanningKeyboard.integration.test.tsx.
 *
 * Renderer state crosses via structured-arg page.evaluate — ids flow as DATA, never
 * interpolated into eval'd code (CodeQL js/bad-code-sanitization, #82 pattern).
 */

interface ElLite {
  id: string
  x: number
  y: number
  groupId?: string
}

const elsOf = (page: Page, id: string): Promise<ElLite[]> =>
  page.evaluate((boardId) => {
    const boards = (globalThis as any).__canvasE2E.getBoards() as {
      id: string
      type: string
      elements?: { id: string; x: number; y: number; groupId?: string }[]
    }[]
    const b = boards.find((x) => x.id === boardId)
    return b && b.type === 'planning'
      ? (b.elements ?? []).map((e) => ({ id: e.id, x: e.x, y: e.y, groupId: e.groupId }))
      : []
  }, id)

const elOf = async (page: Page, id: string, elId: string): Promise<ElLite | undefined> =>
  (await elsOf(page, id)).find((e) => e.id === elId)

/** Seed a planning board with two text-bearing notes (text ⇒ no blur-prune). */
async function seedTwoNotes(page: Page): Promise<string> {
  const id = await seed(page, 'planning')
  await page.evaluate(
    ({ boardId, elements }) => {
      ;(globalThis as any).__canvasE2E.patchBoard(boardId, { elements })
    },
    {
      boardId: id,
      elements: [
        {
          id: 'kb-a',
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
          id: 'kb-b',
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
  await evalIn(page, `window.__canvasE2E.fitView()`)
  await page.waitForTimeout(300)
  return id
}

test.describe('@planning planning keyboard (real OS input)', () => {
  test('grip click focuses the well; real arrows nudge 1px, Shift+arrow 10px', async ({ page }) => {
    const id = await seedTwoNotes(page)

    // A REAL click on the note grip RING: selects the note AND native focus routing
    // must land on the focusable well ancestor — the precondition every key below
    // relies on. Position offset: the grip's CENTER is the note textarea (which takes
    // focus itself and stops keydown propagation) — the ring is the drag/select band.
    await page
      .locator(`[data-id="${id}"] .pl-note-grip`)
      .first()
      .click({ position: { x: 6, y: 6 } })
    await expect
      .poll(() => evalIn<string>(page, `(document.activeElement?.className || '')`))
      .toContain('pl-well')

    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowDown')
    await expect.poll(async () => (await elOf(page, id, 'kb-a'))?.x).toBe(42)
    expect((await elOf(page, id, 'kb-a'))?.y).toBe(41)

    await page.keyboard.press('Shift+ArrowLeft')
    await expect.poll(async () => (await elOf(page, id, 'kb-a'))?.x).toBe(32)

    // The unselected sibling never moved.
    const b = await elOf(page, id, 'kb-b')
    expect(b?.x).toBe(260)
    expect(b?.y).toBe(160)
  })

  test('real Ctrl+G groups the marquee selection; Ctrl+Shift+G ungroups', async ({ page }) => {
    const id = await seedTwoNotes(page)

    // Multi-select via a REAL marquee drag across both notes (a modifier mouse click
    // can't carry Shift reliably in Electron — memory e2e-modifier-keys-synthetic —
    // and the marquee is the primary multi-select flow anyway). The empty-well press
    // also natively focuses the well for the chord below.
    const wellBox = await page.locator(`[data-id="${id}"] .pl-well`).boundingBox()
    if (!wellBox) throw new Error('planning well not on screen')
    await page.mouse.move(wellBox.x + 5, wellBox.y + 5)
    await page.mouse.down()
    await page.mouse.move(wellBox.x + wellBox.width - 5, wellBox.y + wellBox.height - 5, {
      steps: 8
    })
    await page.mouse.up()

    await page.keyboard.press('Control+g')
    await expect
      .poll(async () => {
        const els = await elsOf(page, id)
        const a = els.find((e) => e.id === 'kb-a')
        const b = els.find((e) => e.id === 'kb-b')
        return !!a?.groupId && a.groupId === b?.groupId
      })
      .toBe(true)

    await page.keyboard.press('Control+Shift+g')
    await expect
      .poll(async () => {
        const els = await elsOf(page, id)
        return els.every((e) => e.groupId === undefined)
      })
      .toBe(true)
  })

  test('real Shift+F10 opens the element context menu; real Escape closes it', async ({ page }) => {
    const id = await seedTwoNotes(page)

    await page
      .locator(`[data-id="${id}"] .pl-note-grip`)
      .first()
      .click({ position: { x: 6, y: 6 } })
    await page.keyboard.press('Shift+F10')

    // The shared D1-C Menu shell, opened from the keyboard path, anchored on-screen.
    const groupItem = page.locator('[data-testid="w3-menu-group"]')
    await expect(groupItem).toBeVisible()

    await page.keyboard.press('Escape')
    await expect(groupItem).toHaveCount(0)
  })
})
