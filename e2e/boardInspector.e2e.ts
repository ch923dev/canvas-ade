import { test, expect } from './fixtures'
import { evalIn, mainCall, pollEval, seed } from './helpers'

/**
 * Board Inspector — P0.5 end-to-end. Proves the per-type composition wiring through the REAL stack:
 * a single selected board publishes itself as the active slot owner (inspectorSlotStore) → the board
 * portals its own per-type inspector into the screen-space shell → the shell reveals + the content is
 * interactive. The reveal predicates + slot store are unit-tested; here we prove the live portal +
 * that a relocated control (the otherwise keyboard-only Find) actually fires its existing handler.
 *
 * The reveal is exercised for real: a synthetic window `pointermove` into the right-edge proximity
 * band trips the same reveal machine a user's cursor would (the listener only reads `clientX`, so a
 * dispatched event is faithful here — no CSS hit-testing involved), then a ~150ms dwell past the
 * entrance delay flips the panel interactive (inert off) so the relocated control is clickable.
 */
test.describe('@chrome @terminal Board Inspector — Terminal per-type content (P0.5)', () => {
  test('a selected terminal fills the inspector slot; sections render + Find opens the find bar', async ({
    page,
    electronApp
  }) => {
    const tmp = await mainCall<string>(electronApp, 'createTempProject', 'inspector-', 'inspector')
    try {
      await evalIn(page, `window.__canvasE2E.openProjectFromDisk(${JSON.stringify(tmp)})`)
      const id = await seed(page, 'terminal')
      await evalIn(page, `window.__canvasE2E.select(${JSON.stringify(id)})`)
      await evalIn(page, `window.__canvasE2E.setZoom(1)`) // eligibility requires zoom >= 0.4

      // The selected terminal portals its inspector content into the shell slot (mounted whenever
      // eligible — even before the panel is visually revealed).
      const present = await pollEval(
        page,
        `!!document.querySelector('[data-test="board-inspector"] [data-test="inspector-find"]')`,
        5000
      )
      expect(present, 'TerminalInspector content is portaled into the shell slot').toBe(true)

      // Reveal via the real proximity machine: a window pointermove into the right-edge band, held
      // there so the entrance-delay timer (100ms) commits inZone → the panel reveals (inert off).
      await evalIn(
        page,
        `window.dispatchEvent(new PointerEvent('pointermove', { clientX: window.innerWidth - 4, clientY: Math.round(window.innerHeight / 2), bubbles: true }))`
      )
      const revealed = await pollEval(
        page,
        `document.querySelector('[data-test="board-inspector"]')?.getAttribute('data-revealed') === 'true'`,
        3000
      )
      expect(revealed, 'right-edge proximity reveals the panel').toBe(true)

      const labels = await evalIn<string>(
        page,
        `Array.from(document.querySelectorAll('[data-test="board-inspector"] .ca-inspector-section-lab')).map((e) => e.textContent).join('|')`
      )
      for (const section of ['Appearance', 'Session', 'Configuration', 'Linking']) {
        expect(labels, `the ${section} section renders`).toContain(section)
      }

      // The keyboard-only Find now has a visible affordance; clicking it fires the SAME handler the
      // Ctrl/Cmd+F custom key handler does → the in-well find bar opens.
      await evalIn(
        page,
        `document.querySelector('[data-test="board-inspector"] [data-test="inspector-find"]').click()`
      )
      const findOpen = await pollEval(
        page,
        `!!document.querySelector('[data-test="terminal-find"]')`,
        3000
      )
      expect(findOpen, 'clicking the inspector Find opens the terminal find bar').toBe(true)
    } finally {
      await mainCall(electronApp, 'teardownProject', tmp)
    }
  })
})
