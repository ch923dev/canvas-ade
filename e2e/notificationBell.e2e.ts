import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { callE2E, mainCall, seed } from './helpers'

/**
 * Notification bell (audit PR2) — the camera-cluster history panel over the REAL delivery path:
 * `notifyDeliver` drives MAIN's `createLifecycleDeliver` → `notify:lifecycle` IPC →
 * `useNotifications` ingest → notificationCenterStore row + badge, and the panel's interactions
 * (row Focus, Mark all as read) prove the ONE-unread-model unification against the on-canvas
 * attention ring. Tagged @chrome, not @core: the store/selector logic is pinned at the jsdom tier
 * (NotificationBell.test.tsx / notificationCenterStore.test.ts); this sliver proves the wiring in
 * the booted app.
 */

const unread = (page: Page): Promise<number> => callE2E<number>(page, { m: 'notifyUnread', a: [] })
const attention = (page: Page, id: string): Promise<string | null> =>
  callE2E<string | null>(page, { m: 'attentionKind', a: [id] })
const ring = (page: Page, id: string): Promise<string | null> =>
  callE2E<string | null>(page, { m: 'attentionRingKind', a: [id] })

test.describe('@chrome notification bell (history + unified unread)', () => {
  test.beforeEach(async ({ electronApp }) => {
    await mainCall(electronApp, 'notifyReset')
  })

  test('the real deliver path lands rows: badge count + tier, panel lists newest-first, Escape/re-click close', async ({
    page,
    electronApp
  }) => {
    const b1 = await seed(page, 'terminal')
    const b2 = await seed(page, 'terminal')
    const b3 = await seed(page, 'terminal')
    // seedBoard SELECTS the newest board, and a selected board's rows read on the next canvas
    // churn (sync rule 2 — selection means "seen", same contract as the attention-ring clear).
    // Park the selection on a sink board so the delivery targets stay unread deterministically.
    await seed(page, 'planning')
    await mainCall(electronApp, 'notifyDeliver', b1, 'needs-input')
    await mainCall(electronApp, 'notifyDeliver', b2, 'done')
    await mainCall(electronApp, 'notifyDeliver', b3, 'error')
    await expect.poll(() => unread(page), { timeout: 5000 }).toBe(3)

    const badge = page.locator('[data-test=notification-badge]')
    await expect(badge).toHaveText('3')
    // Any unread error wins the red tier.
    await expect(badge).toHaveAttribute('data-tier', 'err')

    await page.click('[data-test=notification-bell]')
    await expect(page.locator('.nb-menu')).toBeVisible()
    await expect(page.locator('[data-test=nb-row]')).toHaveCount(3)
    // Newest-first: the error (delivered last) leads.
    await expect(page.locator('[data-test=nb-row]').first().locator('.nb-dot')).toHaveAttribute(
      'data-kind',
      'error'
    )

    await page.keyboard.press('Escape')
    await expect(page.locator('.nb-menu')).toHaveCount(0)
    await page.click('[data-test=notification-bell]')
    await expect(page.locator('.nb-menu')).toBeVisible()
    await page.click('[data-test=notification-bell]') // re-click toggles closed (trigger excluded from outside-close)
    await expect(page.locator('.nb-menu')).toHaveCount(0)
  })

  test('row click = Focus: selection clears the on-canvas ring, reads the row, closes the panel', async ({
    page,
    electronApp
  }) => {
    const id = await seed(page, 'terminal')
    await seed(page, 'planning') // selection sink (see the seed comment in the first test)
    await mainCall(electronApp, 'notifyDeliver', id, 'needs-input')
    await expect.poll(() => ring(page, id), { timeout: 5000 }).toBe('needs-input')
    await expect.poll(() => unread(page), { timeout: 5000 }).toBe(1)

    await page.click('[data-test=notification-bell]')
    await page.click('[data-test=nb-row]')

    await expect(page.locator('.nb-menu')).toHaveCount(0)
    // Focus → selection → sync rule 2: the ring drops AND the row reads (badge gone).
    await expect.poll(() => ring(page, id), { timeout: 5000 }).toBeNull()
    await expect.poll(() => attention(page, id), { timeout: 5000 }).toBeNull()
    await expect.poll(() => unread(page), { timeout: 5000 }).toBe(0)
    await expect(page.locator('[data-test=notification-badge]')).toHaveCount(0)
  })

  test('Mark all as read clears the badge AND every attention mark (the ONE unread model)', async ({
    page,
    electronApp
  }) => {
    const b1 = await seed(page, 'terminal')
    const b2 = await seed(page, 'terminal')
    await seed(page, 'planning') // selection sink (see the seed comment in the first test)
    await mainCall(electronApp, 'notifyDeliver', b1, 'error')
    await mainCall(electronApp, 'notifyDeliver', b2, 'needs-input')
    await expect.poll(() => unread(page), { timeout: 5000 }).toBe(2)
    await expect.poll(() => attention(page, b1), { timeout: 5000 }).toBe('error')
    await expect.poll(() => attention(page, b2), { timeout: 5000 }).toBe('needs-input')

    await page.click('[data-test=notification-bell]')
    await page.click('[data-test=nb-markall]')

    await expect.poll(() => unread(page), { timeout: 5000 }).toBe(0)
    expect(await attention(page, b1), 'b1 ring cleared by mark-all').toBeNull()
    expect(await attention(page, b2), 'b2 ring cleared by mark-all').toBeNull()
    await expect(page.locator('[data-test=notification-badge]')).toHaveCount(0)
  })

  test('fresh spec (post-reset) opens to the empty state with Mark all disabled and no badge', async ({
    page
  }) => {
    await expect(page.locator('[data-test=notification-badge]')).toHaveCount(0)
    await page.click('[data-test=notification-bell]')
    await expect(page.locator('.nb-empty')).toBeVisible()
    await expect(page.locator('[data-test=nb-markall]')).toBeDisabled()
  })
})
