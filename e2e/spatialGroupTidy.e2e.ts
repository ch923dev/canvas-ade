import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { callE2E, evalIn } from './helpers'

/**
 * Spatial I3 — "tidy a group" against the REAL running app: the group tab's right-click menu →
 * **Tidy group** arranges ONLY that group (the `t` key's default arrangement, scoped), boards
 * outside it never move and are never covered — a group that needs more room moves, whole, to open
 * space, the camera follows, and ONE info toast offers Undo (which restores the start).
 */

interface Rect {
  id: string
  x: number
  y: number
  w: number
  h: number
}

const GAP = 28 // freeSlot's PLACE_GAP — the auto-placement spacing

async function rects(page: Page): Promise<Map<string, Rect>> {
  const list = await evalIn<Rect[]>(
    page,
    `window.__canvasE2E.getBoards().map((b) => ({ id: b.id, x: b.x, y: b.y, w: b.w, h: b.h }))`
  )
  return new Map(list.map((r) => [r.id, r]))
}

const intersects = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

function bbox(rs: readonly Rect[]): Rect {
  const x = Math.min(...rs.map((r) => r.x))
  const y = Math.min(...rs.map((r) => r.y))
  return {
    id: 'box',
    x,
    y,
    w: Math.max(...rs.map((r) => r.x + r.w)) - x,
    h: Math.max(...rs.map((r) => r.y + r.h)) - y
  }
}

test.describe('@spatial tidy a group (I3)', () => {
  test.slow() // a real PTY + an offscreen browser

  test('Tidy group: neighbours untouched, no overlaps, group contiguous; ONE Undo restores the start', async ({
    page
  }) => {
    // 1. "api and notes" = terminal + planning + browser, stacked on ONE spot (a messy group).
    const ids = await evalIn<[string, string, string]>(
      page,
      `(() => {
        const t = window.__canvasE2E
        return [
          t.seedBoard('terminal', { title: 'api' }),
          t.seedBoard('planning', { title: 'notes' }),
          t.seedBoard('browser', { title: 'web' })
        ]
      })()`
    )
    for (const id of ids) await callE2E(page, { m: 'patchBoard', a: [id, { x: 0, y: 0 }] })
    const seeded = await rects(page)
    const members = ids.map((id) => seeded.get(id)!)
    const box = bbox(members)

    // 2. Neighbours butted against the group's box — right of it AND below it, at the standard
    //    spacing — so ANY non-overlapping arrangement of the three needs room they occupy.
    const right = await callE2E<string>(page, { m: 'seedBoard', a: ['terminal', { title: 'nr' }] })
    const below = await callE2E<string>(page, { m: 'seedBoard', a: ['planning', { title: 'nd' }] })
    await callE2E(
      page,
      { m: 'patchBoard', a: [right, { x: box.x + box.w + GAP, y: box.y }] },
      { m: 'patchBoard', a: [below, { x: box.x, y: box.y + box.h + GAP }] }
    )
    await callE2E(page, { m: 'addGroup', a: ['api and notes', ids] })
    await callE2E(page, { m: 'setSelection', a: [[]] }, { m: 'fitView' })

    const before = await rects(page)
    const neighbours = [right, below].map((id) => before.get(id)!)

    // 3. Right-click the group's tab → the menu lists Tidy group in its place.
    await page.locator('.group-box-tab', { hasText: 'api and notes' }).click({ button: 'right' })
    await expect(page.locator('.group-ctx-row')).toHaveText([
      'Rename',
      'Focus',
      'Tidy group',
      'Add selected boards',
      'Remove group'
    ])
    await page.locator('.group-ctx-row', { hasText: 'Tidy group' }).click()
    await expect(page.locator('.group-ctx')).toHaveCount(0) // the row closed the menu

    // 4. The group moved to open space: ONE info toast, with Undo.
    const toast = page.locator('.toast-item', { hasText: 'Group tidied — moved to open space' })
    await expect(toast).toHaveCount(1)
    await expect(toast.locator('.toast-action')).toHaveText(['Undo'])

    const after = await rects(page)
    // Neighbours: byte-identical.
    for (const n of neighbours) expect(after.get(n.id)).toEqual(n)
    // No overlaps anywhere.
    const all = [...after.values()]
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        expect(intersects(all[i], all[j]), `${all[i].id} overlaps ${all[j].id}`).toBe(false)
      }
    }
    // Contiguous: no non-member inside the group's new box.
    const groupBox = bbox(ids.map((id) => after.get(id)!))
    for (const n of neighbours) expect(intersects(groupBox, after.get(n.id)!)).toBe(false)
    // The group actually moved (it could not fit where it was).
    expect(ids.some((id) => after.get(id)!.x !== 0 || after.get(id)!.y !== 0)).toBe(true)

    // 5. ONE Undo (the toast's) restores the whole start.
    await toast.locator('.toast-action', { hasText: 'Undo' }).click()
    await expect.poll(async () => [...(await rects(page)).values()]).toEqual([...before.values()])
    await expect(toast).toHaveCount(0)
  })
})
