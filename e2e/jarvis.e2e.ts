import { test, expect } from './fixtures'
import type { Page } from '@playwright/test'
import { evalIn, mainCall, pollEval, seed } from './helpers'

/**
 * Jarvis — converse round-trip through the PANEL surface (KICKOFF-PANEL.md; mock rev 1
 * approved 2026-07-13). Deterministic end to end: the STUB voice engine supplies the
 * final transcript over the real session MessagePort, `setLlmMock` flips CANVAS_LLM_MOCK
 * so the brain streams the deterministic mock reply with zero egress, and TTS degrades to
 * text-only (no model on CI) — proving the full renderer↔MAIN turn pipeline: edge-tab
 * click → panel opens AND converse arms (one gesture) → final consumed (NOT the dictation
 * draft) → jarvis:turn:start → delta stream → panel transcript → done. Plus the
 * STRUCTURAL MIC-GATE: Esc/✕ closes the panel and tears converse + capture down with it.
 */

const STUB_FINAL = 'refactor the preview cap' // VOICE_STUB_SCRIPT's final text
const MOCK_REPLY_HEAD = `Understood: ${STUB_FINAL}` // mockJarvisReply's deterministic head

interface JarvisProbe {
  converseMode: boolean
  activeTurnId: number | null
  awaitingReply: boolean
  streamText: string
  lastUserText: string
  turnCount: number
  lastAssistantText: string
  panelOpen: boolean
  lastError: string | null
  composing: string
}

const jarvisState = (page: Page): Promise<JarvisProbe> =>
  page.evaluate(() => (globalThis as any).__canvasE2E.jarvisState())

const voiceDraft = (page: Page): Promise<string> =>
  page.evaluate(() => (globalThis as any).__canvasE2E.voiceState().draft)

const voiceCapturing = (page: Page): Promise<boolean> =>
  page.evaluate(() => (globalThis as any).__canvasE2E.voiceState().capturing)

test.describe('@voice jarvis converse (stub voice → mock brain → panel transcript)', () => {
  test.beforeEach(async ({ electronApp }) => {
    await mainCall(electronApp, 'voiceStubSet', true)
    await mainCall(electronApp, 'setLlmMock', true)
  })
  test.afterEach(async ({ page, electronApp }) => {
    // End any live capture so no session/consumer leaks into the next spec (resetAll
    // also force-disarms converse mode + closes the panel renderer-side). The wake-word
    // opt-in persists in userData — force it back off so no later spec inherits a live
    // closed-panel listener.
    await page
      .evaluate(() =>
        (globalThis as any).api.jarvis.config.set({ wakeWordEnabled: false, listenMode: 'auto' })
      )
      .catch(() => {})
    await page.evaluate(() => (globalThis as any).api.voice.stop()).catch(() => {})
    await mainCall(electronApp, 'setLlmMock', false)
    await mainCall(electronApp, 'voiceStubSet', false)
  })

  test('edge tab opens the panel + arms the mic → mock reply streams into the transcript; Esc closes and kills capture', async ({
    page
  }) => {
    // Collapsed home: the edge tab renders, the panel is off-screen (mic hard-off).
    const tab = page.locator('[data-test="jarvis-edge-tab"]')
    const panel = page.locator('[data-test="jarvis-panel"]')
    await expect(tab).toBeVisible()
    await expect(panel).toHaveAttribute('data-open', 'false')

    // ONE gesture: open the panel AND arm converse (KICKOFF-PANEL §4).
    await tab.click()
    await expect(panel).toHaveAttribute('data-open', 'true')
    await expect
      .poll(async () => (await jarvisState(page)).converseMode, { timeout: 10_000 })
      .toBe(true)
    await expect(tab).toHaveCount(0) // the tab retires while the panel is open
    // The mic-gate strip is the on-screen contract while the mic can hear.
    await expect(page.locator('[data-test="jarvis-mic"]')).toContainText('mic live')

    // The stub final routes to the brain: the utterance + the mock reply stream to done
    // inside the panel body. The dictation flyout/draft must never see the final.
    await expect
      .poll(async () => (await jarvisState(page)).lastUserText, { timeout: 15_000 })
      .toBe(STUB_FINAL)
    await expect
      .poll(async () => (await jarvisState(page)).lastAssistantText, { timeout: 15_000 })
      .toContain(MOCK_REPLY_HEAD)
    const done = await jarvisState(page)
    expect(done.turnCount).toBeGreaterThanOrEqual(2) // user + assistant landed
    expect(done.lastError).toBeNull()
    expect(await voiceDraft(page)).toBe('') // converse consumed the final — no draft leak
    await expect(page.locator('.voice-flyout')).toHaveCount(0) // composer suppressed

    // The rendered panel transcript carries both rows (not just the store).
    await expect(page.locator('[data-test="jarvis-body"]')).toContainText(STUB_FINAL)
    await expect(page.locator('[data-test="jarvis-body"]')).toContainText('Understood')

    // THE STRUCTURAL MIC-GATE: Esc closes the panel; converse mode AND capture die with
    // it — closed panel = no capture path exists.
    await page.keyboard.press('Escape')
    await expect.poll(async () => (await jarvisState(page)).panelOpen).toBe(false)
    await expect.poll(async () => (await jarvisState(page)).converseMode).toBe(false)
    await expect.poll(async () => voiceCapturing(page), { timeout: 10_000 }).toBe(false)
    await expect(tab).toBeVisible() // collapsed home again
  })

  test('double-tap hotkey: the immediately-closed panel never leaves a hot mic (MIC-1/2)', async ({
    page
  }) => {
    // Tap 1 opens the panel and STARTS the async arm chain; tap 2 closes mid-arm. The
    // stale arm continuation must never register a consumer or start capture later.
    await page.keyboard.press('Control+Shift+KeyJ')
    await page.keyboard.press('Control+Shift+KeyJ')
    await expect.poll(async () => (await jarvisState(page)).panelOpen).toBe(false)
    // Give the stale arm continuation every chance to land wrong, then assert it didn't.
    await page.waitForTimeout(1500)
    const s = await jarvisState(page)
    expect(s.converseMode).toBe(false)
    expect(s.panelOpen).toBe(false)
    expect(await voiceCapturing(page)).toBe(false) // closed panel ⇒ no capture path exists
    await expect(page.locator('[data-test="jarvis-edge-tab"]')).toBeVisible()
  })

  test('scoped Esc (ESC-1): a focused terminal keeps Esc; the canvas root still closes', async ({
    page
  }) => {
    await page.locator('[data-test="jarvis-edge-tab"]').click()
    await expect
      .poll(async () => (await jarvisState(page)).converseMode, { timeout: 10_000 })
      .toBe(true)
    // Esc with focus INSIDE a terminal board belongs to the terminal (vim/TUI), not the panel.
    const id = await seed(page, 'terminal', {})
    await pollEval(page, `window.__canvasE2E.terminalMounted(${JSON.stringify(id)})`, 10_000)
    await page.locator('.xterm').first().click()
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)
    const s = await jarvisState(page)
    expect(s.panelOpen).toBe(true) // the panel did not steal the terminal's Esc
    expect(s.converseMode).toBe(true)
    // Focus back on the canvas root (blur the terminal) — Esc is the mic-off gesture
    // again. The board selection must SURVIVE that press: the panel-close Esc runs in
    // the capture chain and stops before the bubble clearSelection (one Esc, one layer —
    // the rubber-band-selection-vanishes finding from the PR #343 review).
    await evalIn(page, `window.__canvasE2E.setSelection([${JSON.stringify(id)}])`)
    await evalIn(page, 'document.activeElement && document.activeElement.blur()')
    await page.keyboard.press('Escape')
    await expect.poll(async () => (await jarvisState(page)).panelOpen).toBe(false)
    await expect.poll(async () => (await jarvisState(page)).converseMode).toBe(false)
    expect(await evalIn(page, 'window.__canvasE2E.getSelection()')).toEqual([id])
  })

  test('listen-hold (auto): finals split by a thinking pause merge into ONE turn', async ({
    page,
    electronApp
  }) => {
    // Two finals ~1.4 s apart — the pre-fix behavior shipped the first alone and let the
    // second SUPERSEDE it (the "Jarvis cuts me off" bug). The hold must buffer both.
    await mainCall(electronApp, 'voiceStubSet', true, [
      { atFrame: 2, t: 'partial', text: 'add a note' },
      { atFrame: 8, t: 'final', text: 'add a note' },
      { atFrame: 20, t: 'partial', text: 'about the release' },
      { atFrame: 26, t: 'final', text: 'about the release' }
    ])
    await page.locator('[data-test="jarvis-edge-tab"]').click()
    await expect
      .poll(async () => (await jarvisState(page)).converseMode, { timeout: 10_000 })
      .toBe(true)
    // The first fragment BUFFERS into the composing row instead of shipping alone.
    await expect
      .poll(async () => (await jarvisState(page)).composing, { timeout: 10_000 })
      .toContain('add a note')
    await expect(page.locator('[data-test="jarvis-composing"]')).toBeVisible()
    // …then the merged utterance sends as ONE turn after the hold window.
    await expect
      .poll(async () => (await jarvisState(page)).lastUserText, { timeout: 15_000 })
      .toBe('add a note about the release')
    await expect
      .poll(async () => (await jarvisState(page)).lastAssistantText, { timeout: 15_000 })
      .toContain('Understood: add a note about the release')
    const s = await jarvisState(page)
    expect(s.composing).toBe('') // the buffer emptied into the turn
    expect(s.turnCount).toBeGreaterThanOrEqual(2)
    await page.keyboard.press('Escape')
    await expect.poll(async () => (await jarvisState(page)).panelOpen).toBe(false)
  })

  test('listen-hold (manual): nothing sends until the Send button ships the buffer', async ({
    page
  }) => {
    await page.evaluate(() => (globalThis as any).api.jarvis.config.set({ listenMode: 'manual' }))
    await page.locator('[data-test="jarvis-edge-tab"]').click()
    await expect
      .poll(async () => (await jarvisState(page)).converseMode, { timeout: 10_000 })
      .toBe(true)
    await expect
      .poll(async () => (await jarvisState(page)).composing, { timeout: 15_000 })
      .toBe(STUB_FINAL)
    // Well past the default auto window: still composing — manual NEVER auto-sends.
    await page.waitForTimeout(3500)
    const parked = await jarvisState(page)
    expect(parked.activeTurnId).toBeNull()
    expect(parked.lastUserText).toBe('')
    expect(parked.composing).toBe(STUB_FINAL)
    // The panel Send button is the manual send (a spoken "send it" lands the same path).
    await page.locator('[data-test="jarvis-send"]').click()
    await expect
      .poll(async () => (await jarvisState(page)).lastUserText, { timeout: 15_000 })
      .toBe(STUB_FINAL)
    await expect
      .poll(async () => (await jarvisState(page)).lastAssistantText, { timeout: 15_000 })
      .toContain(MOCK_REPLY_HEAD)
    await page.keyboard.press('Escape')
    await expect.poll(async () => (await jarvisState(page)).panelOpen).toBe(false)
  })

  test('mic strip disarms and re-arms without closing the panel (E2E-1)', async ({ page }) => {
    await page.locator('[data-test="jarvis-edge-tab"]').click()
    await expect
      .poll(async () => (await jarvisState(page)).converseMode, { timeout: 10_000 })
      .toBe(true)
    const mic = page.locator('[data-test="jarvis-mic"]')
    await expect(mic).toHaveAttribute('data-mic', 'live', { timeout: 10_000 })

    // Disarm via the strip: converse + capture die, the panel STAYS open.
    await mic.click()
    await expect.poll(async () => (await jarvisState(page)).converseMode).toBe(false)
    await expect.poll(async () => voiceCapturing(page), { timeout: 10_000 }).toBe(false)
    expect((await jarvisState(page)).panelOpen).toBe(true)
    await expect(mic).toHaveAttribute('data-mic', 'off')
    await expect(mic).toContainText('mic off')

    // Re-arm via the same strip: the full arm chain runs again inside the open panel.
    await mic.click()
    await expect
      .poll(async () => (await jarvisState(page)).converseMode, { timeout: 10_000 })
      .toBe(true)
    await expect(mic).toHaveAttribute('data-mic', 'live', { timeout: 10_000 })
    await expect.poll(async () => voiceCapturing(page), { timeout: 10_000 }).toBe(true)
  })

  test('Settings-disable while the panel is open runs the full teardown (E2E-1)', async ({
    page
  }) => {
    await page.locator('[data-test="jarvis-edge-tab"]').click()
    await expect
      .poll(async () => (await jarvisState(page)).converseMode, { timeout: 10_000 })
      .toBe(true)
    // The Settings › Persona toggle's IPC — MAIN pushes jarvis:config:changed and the
    // panel must close through the SAME teardown as ✕/Esc (mic never outlives the surface).
    await page.evaluate(() => (globalThis as any).api.jarvis.config.set({ enabled: false }))
    await expect.poll(async () => (await jarvisState(page)).panelOpen).toBe(false)
    await expect.poll(async () => (await jarvisState(page)).converseMode).toBe(false)
    await expect.poll(async () => voiceCapturing(page), { timeout: 10_000 }).toBe(false)
    // Disabled = the whole surface dormant: no edge tab either.
    await expect(page.locator('[data-test="jarvis-edge-tab"]')).toHaveCount(0)

    // Re-enable: the collapsed home returns (tab only, panel closed, mic still off).
    await page.evaluate(() => (globalThis as any).api.jarvis.config.set({ enabled: true }))
    await expect(page.locator('[data-test="jarvis-edge-tab"]')).toBeVisible()
    expect((await jarvisState(page)).converseMode).toBe(false)
  })

  test('edge-tab badge + event chips render live boards only (E2E-1/BADGE-1)', async ({ page }) => {
    // A real board gets a mark; a DEAD id gets one too — only the live board may render.
    const id = await seed(page, 'planning', {})
    await evalIn(
      page,
      `window.__canvasE2E.setAttention(${JSON.stringify(id)}, 'needs-input');
       window.__canvasE2E.setAttention('ghost-board-id', 'error')`
    )
    // Collapsed home: the badge counts ONE (the ghost is filtered), not two.
    await expect(page.locator('[data-test="jarvis-badge"]')).toHaveText('1')

    // Open panel: one chip, for the live board, with the needs-input copy.
    await page.locator('[data-test="jarvis-edge-tab"]').click()
    await expect(page.locator('[data-test="jarvis-panel"]')).toHaveAttribute('data-open', 'true')
    const chips = page.locator('[data-test="jarvis-events"] .jp-notif')
    await expect(chips).toHaveCount(1)
    await expect(chips.first()).toContainText('Agent needs your input')

    // Chip click focuses + selects the board — the selection clears the mark and the
    // chip strip empties (the useNotifications wiring, driven from the panel surface).
    await chips.first().click()
    await expect.poll(() => evalIn(page, 'window.__canvasE2E.getSelection()')).toEqual([id])
    await expect(page.locator('[data-test="jarvis-events"]')).toHaveCount(0)
    await page.keyboard.press('Escape') // teardown: close the panel again
    await expect.poll(async () => (await jarvisState(page)).panelOpen).toBe(false)
  })

  test('wake word (D3): opt-in only, and its sole power is opening the panel', async ({
    page,
    electronApp
  }) => {
    // OFF BY DEFAULT: with the panel closed and the feature untouched, there is no wake
    // session to fire into — the carve-out's ground state.
    expect(await mainCall(electronApp, 'voiceStubWake')).toBe(false)

    // Opt in: the closed-panel listener arms (stub engine holds the wake port).
    await page.evaluate(() => (globalThis as any).api.jarvis.config.set({ wakeWordEnabled: true }))
    await expect
      .poll(async () => mainCall(electronApp, 'voiceStubWake'), { timeout: 10_000 })
      .toBe(true)

    // THE ONE POWER: the detection opened the panel and armed the mic through the
    // existing gesture — same end state as an edge-tab click.
    await expect
      .poll(async () => (await jarvisState(page)).panelOpen, { timeout: 10_000 })
      .toBe(true)
    await expect
      .poll(async () => (await jarvisState(page)).converseMode, { timeout: 10_000 })
      .toBe(true)

    // Panel open ⇒ the wake listener stands down (converse capture owns the mic): a
    // second fire finds no wake session.
    await expect
      .poll(async () => mainCall(electronApp, 'voiceStubWake'), { timeout: 10_000 })
      .toBe(false)

    // Close the panel — the listener re-arms on the closed panel (feature still on).
    await page.keyboard.press('Escape')
    await expect.poll(async () => (await jarvisState(page)).panelOpen).toBe(false)
    await expect.poll(async () => voiceCapturing(page), { timeout: 10_000 }).toBe(false)
    await expect
      .poll(async () => mainCall(electronApp, 'voiceStubWake'), { timeout: 10_000 })
      .toBe(true)
    // (That re-armed fire re-opened the panel — tidy up through the teardown path.)
    await expect.poll(async () => (await jarvisState(page)).panelOpen).toBe(true)
    await page.evaluate(() => (globalThis as any).api.jarvis.config.set({ wakeWordEnabled: false }))
    await page.keyboard.press('Escape')
    await expect.poll(async () => (await jarvisState(page)).panelOpen).toBe(false)
  })

  test('MAIN history follows the mode: recorded per project, cleared on demand', async ({
    page
  }) => {
    await page.locator('[data-test="jarvis-edge-tab"]').click()
    await expect
      .poll(async () => (await jarvisState(page)).lastAssistantText, { timeout: 15_000 })
      .toContain(MOCK_REPLY_HEAD)
    // MAIN's canonical history recorded the exchange (the D4′ session mode default).
    const history = await page.evaluate(() => (globalThis as any).api.jarvis.history.get())
    expect(history.length).toBeGreaterThanOrEqual(2)
    expect(history[0].text).toBe(STUB_FINAL)
    // Clear (the Settings › Persona Clear button's IPC) empties it.
    await page.evaluate(() => (globalThis as any).api.jarvis.history.clear())
    expect(await page.evaluate(() => (globalThis as any).api.jarvis.history.get())).toEqual([])
    // ✕ closes the panel through the same teardown as Esc.
    await page.locator('[data-test="jarvis-close"]').click()
    await expect.poll(async () => (await jarvisState(page)).converseMode).toBe(false)
  })
})
