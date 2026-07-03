import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { evalIn, mainCall, seed, selectForInspector } from './helpers'

/**
 * D2-B terminal polish (design-audit wave D2):
 *  - first-run launchCommand hint: shows on a bare-shell terminal, opens config,
 *    × dismisses app-wide forever (sticky localStorage — leading-reset + restored
 *    below, the e2e harness reuses a persistent userData dir);
 *  - restart controls (P5: Inspector Session actions — the title-bar menu is gone):
 *    a MAIN-validated canResume (terminal-resume F1) splits Restart into explicit
 *    Resume / New actions — a dead stored id must NOT offer Resume;
 *  - A6 recap-flip focus transfer: focus follows the visible face both ways.
 *
 * The seed()-derived board id flows into page.evaluate as a STRUCTURED ARG, never
 * interpolated into an eval'd code string (CodeQL js/bad-code-sanitization — the
 * preview-align.e2e.ts pattern from #82). Locator strings are fine: they are
 * selectors, not code. Browser globals inside the evaluated functions go through
 * `globalThis as any` (tsconfig.node has no DOM lib; no-explicit-any is off for e2e/).
 */

const HINT_KEY = 'ca.terminal.hintDismissed'
const node = (id: string): string => `.react-flow__node[data-id="${id}"]`

const patchBoard = (page: Page, id: string, patch: Record<string, unknown>): Promise<void> =>
  page.evaluate((a) => (globalThis as any).__canvasE2E.patchBoard(a.id, a.patch), { id, patch })
const terminalEchoed = (page: Page, id: string, marker: string): Promise<boolean> =>
  page.evaluate(
    (a) => {
      const t = (globalThis as any).__canvasE2E.readTerminal(a.id)
      return typeof t === 'string' && t.includes(a.marker)
    },
    { id, marker }
  )
const focusInRecap = (page: Page, id: string): Promise<boolean> =>
  page.evaluate((a) => {
    const d = (globalThis as any).document
    const w = d.querySelector(`[data-test="recap-wrap-${a}"]`)
    return !!w && (d.activeElement === w || w.contains(d.activeElement))
  }, id)
const focusInXterm = (page: Page, id: string): Promise<boolean> =>
  page.evaluate((a) => {
    const d = (globalThis as any).document
    const n = d.querySelector(`.react-flow__node[data-id="${a}"]`)
    const el = d.activeElement
    return !!n && !!el && n.contains(el) && el.classList.contains('xterm-helper-textarea')
  }, id)
// True once the flip fold has SETTLED (flat-at-rest: the stage wrapper carries no
// inline transform outside a fold — useTerminalFlip's stageStyle contract).
const flipSettled = (page: Page, id: string): Promise<boolean> =>
  page.evaluate((a) => {
    const d = (globalThis as any).document
    const stage = d.querySelector(`[data-test="recap-wrap-${a}"]`)?.parentElement
    return !!stage && !stage.style.transform
  }, id)

test.describe('@terminal terminal polish (D2-B)', () => {
  test('first-run hint: bare shell shows the pill; click opens config; × dismisses app-wide', async ({
    page
  }) => {
    // Leading reset: the persistent userData dir can carry a dismissal from a prior run.
    await evalIn(page, `localStorage.removeItem(${JSON.stringify(HINT_KEY)})`)
    try {
      const id = await seed(page, 'terminal') // NO launchCommand → bare shell
      const hint = page.locator(`${node(id)} [data-test="terminal-hint"]`)
      await expect(hint).toBeVisible()

      // The pill text is the action: it opens the unified config dialog (edit mode).
      await hint.getByRole('button', { name: /Set a launch command/ }).click()
      await expect(page.locator('[data-test="new-terminal-dialog"]')).toBeVisible()
      await page.locator('[data-test="new-terminal-cancel"]').click()
      await expect(page.locator('[data-test="new-terminal-dialog"]')).toHaveCount(0)

      // × dismisses, persists the sticky key, and survives as gone.
      await hint.locator('[data-test="terminal-hint-dismiss"]').click()
      await expect(hint).toHaveCount(0)
      const sticky = await evalIn<string | null>(
        page,
        `localStorage.getItem(${JSON.stringify(HINT_KEY)})`
      )
      expect(sticky).toBe('1')

      // A terminal WITH a launch command never shows the pill (independent of dismissal).
      await evalIn(page, `localStorage.removeItem(${JSON.stringify(HINT_KEY)})`)
      const id2 = await seed(page, 'terminal', { launchCommand: 'echo HINTLESS' })
      // Anchor on the board chrome first: a bare toHaveCount(0) would pass trivially
      // before the seeded board even renders (asserting absence of everything).
      await expect(page.locator(node(id2))).toBeVisible()
      await expect(page.locator(`${node(id2)} [data-test="terminal-hint"]`)).toHaveCount(0)
    } finally {
      // Never ratchet later specs/runs: leave the key absent (the pre-dismissal state).
      await evalIn(page, `localStorage.removeItem(${JSON.stringify(HINT_KEY)})`)
    }
  })

  test('restart controls: Resume appears only for a MAIN-validated session (F1/F3)', async ({
    page,
    electronApp
  }) => {
    // P5 replaced the title-bar restart MENU (TerminalRestartMenu) with flat Inspector Session
    // actions. Terminal-resume F1 then replaced the bare `!!agentSessionId` gate with a MAIN
    // validation against the transcript's on-disk reality — a stored id with no transcript
    // (eager capture / rotation / retention, the "No conversation found" class) must NOT offer
    // Resume, while a lineage-proven transcript must.
    const id = await seed(page, 'terminal', { launchCommand: 'echo RESTART' })
    await selectForInspector(page, id)
    const inspector = page.locator('[data-test="board-inspector"]')
    const DEAD = 'sess-e2e-dead-1'
    const LIVE = 'sess-e2e-live-1'
    const checkState = (): Promise<{ sessionId?: string; canResume: boolean } | null> =>
      page.evaluate((a) => (globalThis as any).__canvasE2E.resumeCheckState(a), id)

    // No agent session → a single Restart action.
    await expect(inspector.locator('[data-test="inspector-restart"]')).toBeVisible()
    await expect(inspector.getByRole('button', { name: 'Resume session' })).toHaveCount(0)

    try {
      // RC-1 shape: a bare stored id whose transcript never existed. Await the ASYNC MAIN check
      // settling for THIS id before asserting absence (a bare toHaveCount(0) passes trivially
      // before the IPC round-trip lands).
      await patchBoard(page, id, { agentSessionId: DEAD })
      await expect
        .poll(async () => {
          const s = await checkState()
          return s && s.sessionId === DEAD ? s.canResume : null
        })
        .toBe(false)
      await expect(inspector.getByRole('button', { name: 'Resume session' })).toHaveCount(0)
      await expect(inspector.locator('[data-test="inspector-restart"]')).toBeVisible()
      // F1b: the command palette gates its Resume row on the SAME MAIN verdict (via
      // resumeValidityStore) — the dead id must not list it. restart-new anchors the
      // assertion: it proves the terminal's selected-board rows actually built.
      await page.keyboard.press('Control+k')
      await expect(page.locator('[data-test="command-palette"]')).toBeVisible()
      await expect(page.locator('[data-test="palette-row-restart-new"]')).toBeVisible()
      await expect(page.locator('[data-test="palette-row-restart-resume"]')).toHaveCount(0)
      await page.keyboard.press('Escape')
      await expect(page.locator('[data-test="command-palette"]')).toHaveCount(0)
      // F3: at click time MAIN resolves the same dead id to a FRESH start, not a dead --resume.
      const dead = await page.evaluate(
        (a) => (globalThis as any).window.api.terminal.resumeLaunch(a.id, { sessionId: a.sid }),
        { id, sid: DEAD }
      )
      expect(dead).toEqual({ mode: 'fresh' })

      // A real transcript whose lineage carries the id → the Resume / New pair replaces Restart.
      const jsonl =
        [
          JSON.stringify({
            sessionId: LIVE,
            type: 'user',
            timestamp: '2026-07-03T10:00:00.000Z',
            message: { role: 'user', content: 'fix the auth bug' }
          }),
          JSON.stringify({
            sessionId: LIVE,
            type: 'assistant',
            timestamp: '2026-07-03T10:00:05.000Z',
            message: { role: 'assistant', content: [{ type: 'text', text: 'On it.' }] }
          })
        ].join('\n') + '\n'
      const transcript = await mainCall<string>(electronApp, 'seedRecapTranscript', jsonl)
      await patchBoard(page, id, { agentSessionId: LIVE, agentTranscriptPath: transcript })
      await expect(inspector.getByRole('button', { name: 'Resume session' })).toBeVisible()
      await expect(inspector.getByRole('button', { name: 'New session' })).toBeVisible()
      await expect(inspector.locator('[data-test="inspector-restart"]')).toHaveCount(0)
      // F1b: the validated verdict flips the palette row ON (the Inspector Resume button
      // above proves the same hook published true — one source of truth, two surfaces).
      await page.keyboard.press('Control+k')
      await expect(page.locator('[data-test="command-palette"]')).toBeVisible()
      await expect(page.locator('[data-test="palette-row-restart-resume"]')).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(page.locator('[data-test="command-palette"]')).toHaveCount(0)
      // F3: the click-time launch line resumes the transcript's actual session id.
      const live = await page.evaluate(
        (a) =>
          (globalThis as any).window.api.terminal.resumeLaunch(a.id, {
            sessionId: a.sid,
            transcriptPath: a.path
          }),
        { id, sid: LIVE, path: transcript }
      )
      expect(live).toEqual({ mode: 'resume', command: `claude --resume ${LIVE}` })
    } finally {
      // Restore the CLAUDE_CONFIG_DIR seedRecapTranscript mutated so the throwaway fixture root
      // can't leak into a later e2e file and untrust its real-transcript paths (N1).
      await mainCall(electronApp, 'restoreClaudeConfigDir')
    }
  })

  test('A6: flipping transfers focus to the recap and back to xterm', async ({ page }) => {
    const id = await seed(page, 'terminal', { launchCommand: 'echo FLIPFOCUS' })
    // Let the spawn settle so xterm exists before we assert focus round-trips.
    await expect.poll(() => terminalEchoed(page, id, 'FLIPFOCUS'), { timeout: 10_000 }).toBe(true)

    // P5: flip via Inspector › Session › View recap (the title-bar flip button is gone). The
    // focus-transfer effect keys off the flip STATE, so it fires the same for this trigger.
    await selectForInspector(page, id)
    await page.locator('[data-test="inspector-recap"]').click()
    await expect
      .poll(() => focusInRecap(page, id), {
        timeout: 4000,
        message: 'focus moved to the recap face after flip'
      })
      .toBe(true)

    // The fold must SETTLE before flipping back: toggle() swallows clicks while a
    // fold is in flight (intended re-entrancy guard), and the focus poll above can
    // pass right after the 150ms face swap — under load the settle timer starves,
    // so an immediate second click lands mid-fold and is silently ignored (the
    // recap face then stays up forever; caught by a full-suite run's failure.png).
    await expect
      .poll(() => flipSettled(page, id), { timeout: 4000, message: 'flip fold settled' })
      .toBe(true)

    await page.locator('[data-test="inspector-recap"]').click()
    await expect
      .poll(() => focusInXterm(page, id), {
        timeout: 4000,
        message: 'focus restored to xterm after flip-back'
      })
      .toBe(true)
  })
})
