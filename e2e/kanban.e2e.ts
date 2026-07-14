import { test, expect } from './fixtures'
import { evalIn, seed } from './helpers'
import type { Page } from '@playwright/test'

/**
 * @planning Kanban board human interaction (P4.2) — against the REAL app.
 *
 * Pins the slivers the jsdom tier can't: the board mounts through BoardNode's per-type dispatch + the
 * lazy chunk, HTML5-native drag re-parents a card between columns under the React Flow transform (a
 * real mouse drag, not a synthetic dispatch that would bypass the transform hit-test), inline add
 * lands through `updateBoard`, and column authoring (rename/delete-with-reflow) round-trips. Board
 * state is read as DATA via structured-arg page.evaluate (ids never interpolated into an eval'd
 * string). The base `page` fixture resets the canvas before each test.
 */
type Card = {
  id: string
  columnId: string
  title: string
  description?: string
  tags?: string[]
  fileRefs?: { path: string; line?: number; endLine?: number }[]
}
type Column = { id: string; title: string; wip?: number }

const SEED = {
  columns: [
    { id: 'backlog', title: 'Backlog' },
    { id: 'progress', title: 'In Progress', wip: 2 },
    { id: 'review', title: 'Review' }
  ],
  cards: [
    { id: 'c1', columnId: 'backlog', title: 'One' },
    { id: 'c2', columnId: 'progress', title: 'Two' },
    { id: 'c3', columnId: 'progress', title: 'Three' }
  ]
}

const kanbanCards = (page: Page): Promise<Card[]> =>
  page.evaluate(() => {
    const b = (
      (globalThis as any).__canvasE2E.getBoards() as { type: string; cards?: Card[] }[]
    ).find((x) => x.type === 'kanban')
    return b?.cards ?? []
  })

const kanbanColumns = (page: Page): Promise<Column[]> =>
  page.evaluate(() => {
    const b = (
      (globalThis as any).__canvasE2E.getBoards() as { type: string; columns?: Column[] }[]
    ).find((x) => x.type === 'kanban')
    return b?.columns ?? []
  })

async function seedKanban(page: Page): Promise<string> {
  const id = await seed(page, 'kanban', SEED)
  await evalIn(page, `window.__canvasE2E.fitView()`)
  await page.waitForTimeout(300)
  return id
}

test.describe('@planning kanban board interaction (P4.2)', () => {
  test('renders lanes + cards and paints the at-limit WIP badge warn', async ({ page }) => {
    const id = await seedKanban(page)
    const node = page.locator(`[data-id="${id}"]`)
    await expect(node.getByText('Backlog', { exact: true })).toBeVisible()
    await expect(node.getByText('One', { exact: true })).toBeVisible()
    const badge = node.getByText('WIP 2/2') // In Progress: 2 cards, limit 2 → at limit
    await expect(badge).toBeVisible()
    await expect(badge).toHaveClass(/kb-wip-full/)
  })

  test('adds a card through the inline input', async ({ page }) => {
    const id = await seedKanban(page)
    const node = page.locator(`[data-id="${id}"]`)
    await node.getByRole('button', { name: 'Add card to Backlog' }).click()
    const input = node.getByRole('textbox', { name: 'New card in Backlog' })
    await input.fill('Fresh task')
    await input.press('Enter')
    await expect(node.getByText('Fresh task', { exact: true })).toBeVisible()
    const backlog = (await kanbanCards(page)).filter((c) => c.columnId === 'backlog')
    expect(backlog.map((c) => c.title)).toEqual(['One', 'Fresh task'])
  })

  test('drags a card between columns (HTML5 native drag re-parents it)', async ({ page }) => {
    const id = await seedKanban(page)
    const node = page.locator(`[data-id="${id}"]`)
    const card = node.locator('[data-testid="kb-card"]', { hasText: 'One' })
    await card.dragTo(node.getByText('Review', { exact: true }))
    await expect
      .poll(async () => (await kanbanCards(page)).find((c) => c.id === 'c1')?.columnId)
      .toBe('review')
  })

  test('opens the card-detail modal and edits description + tags (v19)', async ({ page }) => {
    const id = await seedKanban(page)
    const node = page.locator(`[data-id="${id}"]`)
    // A click on the card opens the detail modal (rendered in a portal at document.body).
    await node.locator('[data-testid="kb-card"]', { hasText: 'One' }).click()
    const modal = page.getByTestId('kanban-card-modal')
    await expect(modal).toBeVisible()

    // edit the description (commits on blur)
    const desc = modal.getByTestId('kbm-desc')
    await desc.fill('Wrote it in the modal')
    await desc.blur()
    await expect
      .poll(async () => (await kanbanCards(page)).find((c) => c.id === 'c1')?.description)
      .toBe('Wrote it in the modal')

    // add a tag (Enter commits)
    const tag = modal.getByTestId('kbm-tag-input')
    await tag.fill('urgent')
    await tag.press('Enter')
    await expect
      .poll(async () => (await kanbanCards(page)).find((c) => c.id === 'c1')?.tags)
      .toEqual(['urgent'])

    // Esc closes the modal; the edits persist
    await page.keyboard.press('Escape')
    await expect(modal).toBeHidden()
    // the description indicator now shows on the card face
    await expect(
      node
        .locator('[data-testid="kb-card"]', { hasText: 'One' })
        .locator('[aria-label="Has a description"]')
    ).toBeVisible()
  })

  test('renames a column and deletes one (cards reflow to the neighbour)', async ({ page }) => {
    const id = await seedKanban(page)
    const node = page.locator(`[data-id="${id}"]`)
    // rename Backlog → Todo
    await node.getByText('Backlog', { exact: true }).dblclick()
    const rename = node.getByRole('textbox', { name: 'Column title' })
    await rename.fill('Todo')
    await rename.press('Enter')
    await expect(node.getByText('Todo', { exact: true })).toBeVisible()

    // delete In Progress → its two cards reflow to the lane that slides into place (Review)
    await node.getByRole('button', { name: 'Delete column In Progress' }).click()
    await expect.poll(async () => (await kanbanColumns(page)).length).toBe(2)
    const review = (await kanbanCards(page)).filter((c) => c.columnId === 'review')
    expect(review.map((c) => c.id).sort()).toEqual(['c2', 'c3'])
  })
})
