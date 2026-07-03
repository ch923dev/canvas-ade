import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect } from './fixtures'
import { evalIn, mainCall, seed, selectForInspector } from './helpers'

/**
 * F4 (terminal-resume): the Inspector's fault-only hook-health line, driven end-to-end through
 * the REAL surfaces — real consent (recap:setConsent installs the hook via the production
 * decision callback), a real .claude/settings.local.json clobber (the bridgespace class: a
 * third-party tool rewriting the file mid-session), the real `recap:health` IPC, and the real
 * focus-time re-ensure (via the __canvasE2EMain.recapReEnsure seam — a renderer-synthetic
 * window `focus` re-queries the health WITHOUT reaching MAIN's browser-window-focus, which is
 * exactly what lets the spec observe the fault before healing it).
 *
 * The runner-missing and no-capture faults are unit-pinned (recapHealth.test.ts /
 * useHookHealth.test.tsx): the dev runner always exists, and the 15s no-capture grace against
 * a real claude session belongs to the epic-end manual check, not a suite spec.
 */
test('@terminal hook-health: settings clobber surfaces the fault line; re-ensure heals it', async ({
  page,
  electronApp
}) => {
  const tmp = await mainCall<string>(
    electronApp,
    'createTempProject',
    'recap-health-',
    'recap-health'
  )
  try {
    // Consent through the production path: persists the decision AND installs the recap hook
    // into <tmp>/.claude/settings.local.json (dev runner = a real node/electron, always found).
    const consent = await evalIn<{ ok: boolean }>(page, `window.api.recap.setConsent('enabled')`)
    expect(consent.ok, 'consent enable persisted + hook installed').toBe(true)

    // Default shell board (NO claude launch): the no-capture grace never arms, so the only
    // fault this board can surface is the hook/runner class — the one under test.
    const id = await seed(page, 'terminal', {})
    await selectForInspector(page, id)

    // Healthy: consented + hook installed + runner ok → the line does not exist AT ALL.
    await expect(page.locator('[data-test="inspector-hook-health"]')).toHaveCount(0)

    // The clobber: a third-party tool wipes our hook mid-session. The renderer re-checks on
    // window focus; a synthetic renderer `focus` never reaches MAIN, so the self-heal stays
    // un-run and the fault becomes observable.
    rmSync(join(tmp, '.claude', 'settings.local.json'))
    await evalIn(page, `window.dispatchEvent(new Event('focus'))`)
    const line = page.locator('[data-test="inspector-hook-health"]')
    await expect(line).toContainText('hook not installed')
    await expect(line).toHaveAttribute('data-fault', 'hook')

    // The heal: the SAME re-ensure MAIN runs on a real window focus, then a re-query — the
    // line clears without a restart or a project re-open.
    await mainCall(electronApp, 'recapReEnsure')
    await evalIn(page, `window.dispatchEvent(new Event('focus'))`)
    await expect(page.locator('[data-test="inspector-hook-health"]')).toHaveCount(0)
  } finally {
    await mainCall(electronApp, 'teardownProject', tmp)
  }
})
