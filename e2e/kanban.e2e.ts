import { test, expect } from './fixtures'
import { evalIn, mainCall, seed } from './helpers'
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
  attachments?: {
    assetId?: string
    url?: string
    name: string
    kind: string
    mime?: string
    size?: number
  }[]
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

  test('adds a card through the create-mode modal (#346)', async ({ page }) => {
    const id = await seedKanban(page)
    const node = page.locator(`[data-id="${id}"]`)
    await node.getByRole('button', { name: 'Add card to Backlog' }).click()
    // The inline title box is gone — "+ Add card" opens the modal in create mode (empty draft).
    const modal = page.getByTestId('kanban-card-modal')
    await expect(modal).toBeVisible()
    await modal.getByTestId('kbm-title').fill('Fresh task')
    await modal.getByTestId('kbm-add').click()
    await expect(node.getByText('Fresh task', { exact: true })).toBeVisible()
    const backlog = (await kanbanCards(page)).filter((c) => c.columnId === 'backlog')
    expect(backlog.map((c) => c.title)).toEqual(['One', 'Fresh task'])
  })

  test('attaches a real file in create mode → persisted to assets/ + on the new card (#346)', async ({
    page,
    electronApp
  }) => {
    const id = await seedKanban(page)
    // asset.write needs a project dir open (mirrors the whiteboard-paste asset e2e).
    const tmp = await mainCall<string>(electronApp, 'createTempProject', 'canvas-kb346-', 'kb')
    try {
      const node = page.locator(`[data-id="${id}"]`)
      await node.getByRole('button', { name: 'Add card to Backlog' }).click()
      const modal = page.getByTestId('kanban-card-modal')
      await expect(modal).toBeVisible()
      await modal.getByTestId('kbm-title').fill('With file')
      // The "+ Add file" button opens a NATIVE picker via a hidden <input type=file>; Playwright sets
      // the files directly (no OS dialog). The bytes persist to the content-addressed store immediately.
      await modal.getByTestId('kba-input').setInputFiles({
        name: 'note.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('hello attach #346')
      })
      // The file chip renders once the blob is written + the draft entry lands.
      await expect(modal.getByText('note.txt', { exact: true })).toBeVisible()
      await modal.getByTestId('kbm-add').click()

      const created = (await kanbanCards(page)).find((c) => c.title === 'With file')
      expect(created?.attachments?.length, 'one attachment on the committed card').toBe(1)
      const att = created!.attachments![0]
      expect(att.name).toBe('note.txt')
      expect(att.kind).toBe('file')
      const assetId = att.assetId ?? ''
      expect(/^assets[/\\][0-9a-f]{40}\.txt$/.test(assetId), 'assets/<sha1>.txt id').toBe(true)
      // ADR 0009: the blob lives under <project>/.canvas/assets/ — resolve through `.canvas/`.
      const fileOk = await mainCall<boolean>(
        electronApp,
        'fileExists',
        await mainCall<string>(electronApp, 'joinPath', tmp, '.canvas', assetId)
      )
      expect(fileOk, 'attachment blob written to disk').toBe(true)
    } finally {
      await mainCall(electronApp, 'teardownProject', tmp)
    }
  })

  test('adds a LINK attachment in create mode (no blob; https:// prepended) (#346)', async ({
    page
  }) => {
    const id = await seedKanban(page)
    const node = page.locator(`[data-id="${id}"]`)
    await node.getByRole('button', { name: 'Add card to Backlog' }).click()
    const modal = page.getByTestId('kanban-card-modal')
    await expect(modal).toBeVisible()
    await modal.getByTestId('kbm-title').fill('With link')
    const link = modal.getByTestId('kba-link')
    await link.fill('github.com/anthropics/anthropic-sdk-typescript')
    await link.press('Enter')
    // The link chip renders with the typed text; committing lands it on the new card.
    await expect(
      modal.getByText('github.com/anthropics/anthropic-sdk-typescript', { exact: true })
    ).toBeVisible()
    await modal.getByTestId('kbm-add').click()
    const created = (await kanbanCards(page)).find((c) => c.title === 'With link')
    expect(created?.attachments?.length).toBe(1)
    const att = created!.attachments![0]
    expect(att.kind).toBe('link')
    expect(att.url).toBe('https://github.com/anthropics/anthropic-sdk-typescript') // scheme prepended
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
