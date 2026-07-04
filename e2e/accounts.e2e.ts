import { test, expect } from './fixtures'
import { evalIn } from './helpers'
import type { Page } from '@playwright/test'

/**
 * @chrome Phase 1 accounts — the sign-in UI (chrome pill · SignInView · Settings "Account" section).
 *
 * The OAuth round-trip is NOT exercised here (no live WorkOS in e2e, and clicking a provider would
 * fire shell.openExternal). The sign-IN side is driven through `window.__canvasE2E.setAuthStatus` —
 * the deterministic stand-in for MAIN's `auth:statusChanged` push, which runs the SAME store `apply`
 * the real onStatusChanged handler runs, so the pill / modal / Settings react exactly as in prod.
 * Sign-OUT, by contrast, uses the REAL `auth:signOut` IPC (it clears local state only — no external
 * dependency) and asserts the real push flips the UI back, covering the full subscription path.
 *
 * The MAIN PKCE/exchange/state machine is covered by the authService/workosAuth unit tests; this
 * spec owns the renderer half: presence-only status → the three account surfaces.
 */

/** Drive the renderer account store to a status payload (the mocked push). */
function setStatus(
  page: Page,
  status: {
    isLoggedIn: boolean
    email?: string
    plan?: 'free' | 'pro'
    encryptionAvailable: boolean
  }
): Promise<void> {
  return evalIn(page, `window.__canvasE2E.setAuthStatus(${JSON.stringify(status)})`)
}

test.describe('@chrome accounts (Phase 1)', () => {
  test('signed-out: the chrome shows a Sign-in pill that opens SignInView, and the push auto-advances', async ({
    page
  }) => {
    await setStatus(page, { isLoggedIn: false, encryptionAvailable: true })

    // The chrome account control is the ghost "Sign in" pill (signed-out), before the Settings gear.
    const pill = page.locator('[data-test="account-signin"]')
    await expect(pill).toBeVisible()
    await expect(pill).toHaveText('Sign in')

    // Clicking it opens the focused SignInView in its idle (provider-choice) state.
    await pill.click()
    await expect(page.locator('[data-test="signin-modal"]')).toBeVisible()
    await expect(page.locator('[data-test="signin-google"]')).toBeVisible()
    await expect(page.locator('[data-test="signin-email"]')).toBeVisible()
    // No browser is opened — we never click a provider (that would fire shell.openExternal).

    // A status push (the mocked auth:statusChanged) flips the store to signed-in → the view
    // auto-advances closed and the chrome pill becomes the avatar. This is the real onClose path.
    await setStatus(page, {
      isLoggedIn: true,
      email: 'you@example.com',
      plan: 'free',
      encryptionAvailable: true
    })
    await expect(page.locator('[data-test="signin-modal"]')).toHaveCount(0)
    await expect(page.locator('[data-test="account-pill"]')).toBeVisible()
    // Free plan → no PRO micro-tag on the avatar.
    await expect(page.locator('[data-test="account-pill"]')).not.toContainText('PRO')
  })

  test('signed-in (Pro): avatar + Settings Account row + plan badge, then a real sign-out returns to signed-out', async ({
    page
  }) => {
    await setStatus(page, {
      isLoggedIn: true,
      email: 'pro@example.com',
      plan: 'pro',
      encryptionAvailable: true
    })

    // The chrome pill is now the avatar, carrying the PRO micro-tag.
    const pill = page.locator('[data-test="account-pill"]')
    await expect(pill).toBeVisible()
    await expect(pill).toContainText('PRO')

    // Clicking the avatar opens Settings on the "You" tab (initialSection='account'), so the Account
    // section is visible without any extra navigation.
    await pill.click()
    await expect(page.locator('[data-test="settings-panel"]')).toBeVisible()
    const row = page.locator('[data-test="account-row"]')
    await expect(row).toBeVisible()
    await expect(row).toContainText('pro@example.com')
    await expect(row).toContainText('PRO')
    // (Manage-subscription is now its own Billing tile — covered by modal.e2e's tiles-nav test.)

    // Sign out drives the REAL auth:signOut IPC; MAIN clears local state and pushes signed-out,
    // and the Account section flips to the signed-out CTA in place (the panel stays open).
    await page.locator('[data-test="account-signout"]').click()
    await expect(page.locator('[data-test="account-cta"]')).toBeVisible()
    await expect(page.locator('[data-test="account-row"]')).toHaveCount(0)

    // Close Settings (Esc closes from any tab) → the chrome pill is back to the signed-out "Sign in".
    await page.keyboard.press('Escape')
    await expect(page.locator('[data-test="settings-panel"]')).toHaveCount(0)
    await expect(page.locator('[data-test="account-signin"]')).toBeVisible()
  })

  test('Settings shows the Account CTA when signed-out; SignInView blocks on a missing keyring', async ({
    page
  }) => {
    await setStatus(page, { isLoggedIn: false, encryptionAvailable: true })

    // Open Settings via the gear → the "You" tab is active, so the Account section (signed-out CTA)
    // shows without any extra navigation.
    await page.locator('button[title="Settings"]').click()
    await expect(page.locator('[data-test="settings-panel"]')).toBeVisible()
    await expect(page.locator('[data-test="account-cta"]')).toBeVisible()
    await expect(page.locator('[data-test="account-cta-signin"]')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.locator('[data-test="settings-panel"]')).toHaveCount(0)

    // No system keyring (safeStorage off) → the SignInView shows the hard-block notice and offers
    // NO provider buttons (we never write plaintext tokens), only "Continue offline".
    await setStatus(page, { isLoggedIn: false, encryptionAvailable: false })
    await page.locator('[data-test="account-signin"]').click()
    await expect(page.locator('[data-test="signin-modal"]')).toBeVisible()
    await expect(page.locator('[data-test="signin-no-keyring"]')).toBeVisible()
    await expect(page.locator('[data-test="signin-google"]')).toHaveCount(0)

    // "Continue offline" dismisses the view (local-first — the app stays usable without an account).
    await page.getByRole('button', { name: 'Continue offline' }).click()
    await expect(page.locator('[data-test="signin-modal"]')).toHaveCount(0)
  })
})
