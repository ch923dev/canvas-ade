import { test, expect } from './fixtures'
import { evalIn, mainCall, pollEval, seed } from './helpers'

/**
 * Board Inspector — end-to-end. Proves the per-type composition wiring through the REAL stack:
 * a single selected board publishes itself as the active slot owner (inspectorSlotStore) → the board
 * portals its own per-type inspector into the screen-space shell → the shell reveals + the content is
 * interactive. The reveal predicates + slot store are unit-tested; here we prove the live portal +
 * that a relocated control (the otherwise keyboard-only Find) actually fires its existing handler.
 *
 * v2 reveal model = REVEAL-ON-SELECT: selecting a single board at a usable zoom is the whole trigger
 * (no proximity zone / focus pin anymore), so the popover is interactive (inert off) the moment the
 * selection lands — no synthetic pointer sweep needed.
 */
test.describe('@chrome @terminal Board Inspector — Terminal per-type content', () => {
  test('selecting a terminal reveals the inspector; sections render + Find opens the find bar', async ({
    page,
    electronApp
  }) => {
    const tmp = await mainCall<string>(electronApp, 'createTempProject', 'inspector-', 'inspector')
    try {
      await evalIn(page, `window.__canvasE2E.openProjectFromDisk(${JSON.stringify(tmp)})`)
      const id = await seed(page, 'terminal')
      await evalIn(page, `window.__canvasE2E.select(${JSON.stringify(id)})`)
      await evalIn(page, `window.__canvasE2E.setZoom(1)`) // eligibility requires zoom >= 0.4

      // The selected terminal portals its inspector content into the shell slot.
      const present = await pollEval(
        page,
        `!!document.querySelector('[data-test="board-inspector"] [data-test="inspector-find"]')`,
        5000
      )
      expect(present, 'TerminalInspector content is portaled into the shell slot').toBe(true)

      // Reveal-on-select: a single eligible selection reveals the popover (inert off) directly.
      const revealed = await pollEval(
        page,
        `document.querySelector('[data-test="board-inspector"]')?.getAttribute('data-revealed') === 'true'`,
        3000
      )
      expect(revealed, 'selecting a single board reveals the inspector').toBe(true)

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

test.describe('@chrome @preview Board Inspector — Browser per-type content', () => {
  test('selecting a browser reveals the inspector; sections render + the viewport control round-trips', async ({
    page,
    electronApp
  }) => {
    const tmp = await mainCall<string>(
      electronApp,
      'createTempProject',
      'inspector-b-',
      'inspector-b'
    )
    try {
      await evalIn(page, `window.__canvasE2E.openProjectFromDisk(${JSON.stringify(tmp)})`)
      const id = await seed(page, 'browser')
      await evalIn(page, `window.__canvasE2E.select(${JSON.stringify(id)})`)
      await evalIn(page, `window.__canvasE2E.setZoom(1)`) // eligibility requires zoom >= 0.4

      // The selected browser portals BrowserInspector content into the shell slot (Screenshot lives in
      // the always-open Preview section, so it is a stable presence probe regardless of disabled state).
      const present = await pollEval(
        page,
        `!!document.querySelector('[data-test="board-inspector"] [data-test="inspector-screenshot"]')`,
        5000
      )
      expect(present, 'BrowserInspector content is portaled into the shell slot').toBe(true)

      const revealed = await pollEval(
        page,
        `document.querySelector('[data-test="board-inspector"]')?.getAttribute('data-revealed') === 'true'`,
        3000
      )
      expect(revealed, 'selecting a single browser reveals the inspector').toBe(true)

      const labels = await evalIn<string>(
        page,
        `Array.from(document.querySelectorAll('[data-test="board-inspector"] .ca-inspector-section-lab')).map((e) => e.textContent).join('|')`
      )
      for (const section of ['Viewport', 'Navigation', 'Preview', 'Developer', 'Configuration']) {
        expect(labels, `the ${section} section renders`).toContain(section)
      }

      // The relocated viewport control fires the board's REAL setViewport → updateBoard; the change
      // round-trips back into the presentation-only segment (value is driven by board.viewport). Default
      // seed is 'desktop', so Desktop starts checked — click Mobile and prove it re-checks.
      await evalIn(
        page,
        `Array.from(document.querySelectorAll('[data-test="board-inspector"] [aria-label="Device class"] button')).find((b) => b.textContent.includes('Mobile')).click()`
      )
      const flipped = await pollEval(
        page,
        `document.querySelector('[data-test="board-inspector"] [aria-label="Device class"] button[aria-checked="true"]')?.textContent.includes('Mobile') === true`,
        3000
      )
      expect(
        flipped,
        'clicking the inspector Mobile segment sets board.viewport via the real handler'
      ).toBe(true)
    } finally {
      await mainCall(electronApp, 'teardownProject', tmp)
    }
  })
})

test.describe('@chrome Board Inspector — Command per-type content', () => {
  test('selecting the command board reveals the inspector; sections render + the view seg round-trips', async ({
    page,
    electronApp
  }) => {
    const tmp = await mainCall<string>(
      electronApp,
      'createTempProject',
      'inspector-c-',
      'inspector-c'
    )
    try {
      await evalIn(page, `window.__canvasE2E.openProjectFromDisk(${JSON.stringify(tmp)})`)
      const id = await seed(page, 'command')
      await evalIn(page, `window.__canvasE2E.select(${JSON.stringify(id)})`)
      await evalIn(page, `window.__canvasE2E.setZoom(1)`) // eligibility requires zoom >= 0.4

      // The selected command board portals CommandInspector content into the shell slot (the recap
      // flip lives in the always-open View section → a stable presence probe).
      const present = await pollEval(
        page,
        `!!document.querySelector('[data-test="board-inspector"] [data-test="inspector-command-recap"]')`,
        5000
      )
      expect(present, 'CommandInspector content is portaled into the shell slot').toBe(true)

      const revealed = await pollEval(
        page,
        `document.querySelector('[data-test="board-inspector"]')?.getAttribute('data-revealed') === 'true'`,
        3000
      )
      expect(revealed, 'selecting the command board reveals the inspector').toBe(true)

      const labels = await evalIn<string>(
        page,
        `Array.from(document.querySelectorAll('[data-test="board-inspector"] .ca-inspector-section-lab')).map((e) => e.textContent).join('|')`
      )
      for (const section of ['View', 'Status', 'Worker pool', 'Orchestration']) {
        expect(labels, `the ${section} section renders`).toContain(section)
      }

      // The relocated Kanban/Groups seg fires the board's REAL setView; the change round-trips back
      // into the presentation-only segment (value is driven by the store). Default is 'kanban', so
      // Kanban starts checked — click Groups and prove it re-checks.
      await evalIn(
        page,
        `Array.from(document.querySelectorAll('[data-test="board-inspector"] [aria-label="Board view"] button')).find((b) => b.textContent.includes('Groups')).click()`
      )
      const flipped = await pollEval(
        page,
        `document.querySelector('[data-test="board-inspector"] [aria-label="Board view"] button[aria-checked="true"]')?.textContent.includes('Groups') === true`,
        3000
      )
      expect(
        flipped,
        'clicking the inspector Groups segment sets the view via the real handler'
      ).toBe(true)
    } finally {
      await mainCall(electronApp, 'teardownProject', tmp)
    }
  })
})

test.describe('@chrome @preview Board Inspector — Data-Flow per-type content', () => {
  test('selecting an unbound data-flow board reveals the inspector with a live Source binder', async ({
    page,
    electronApp
  }) => {
    const tmp = await mainCall<string>(
      electronApp,
      'createTempProject',
      'inspector-d-',
      'inspector-d'
    )
    try {
      await evalIn(page, `window.__canvasE2E.openProjectFromDisk(${JSON.stringify(tmp)})`)
      // A browser board on the canvas gives the unbound data-flow inspector something to bind to.
      const browserId = await seed(page, 'browser', { title: 'app-under-test' })
      const id = await seed(page, 'dataflow')
      await evalIn(page, `window.__canvasE2E.select(${JSON.stringify(id)})`)
      await evalIn(page, `window.__canvasE2E.setZoom(1)`) // eligibility requires zoom >= 0.4

      // An unbound data-flow board portals only its Source section (the bind actions) — a stable probe
      // that the per-type content reached the shell slot and reveals.
      const revealed = await pollEval(
        page,
        `document.querySelector('[data-test="board-inspector"]')?.getAttribute('data-revealed') === 'true'`,
        5000
      )
      expect(revealed, 'selecting the data-flow board reveals the inspector').toBe(true)

      // Poll the portaled content (the shell reveals on selection a tick before the board's portal
      // effect mounts its section into the slot — same reason the other cases poll a probe first).
      const sourcePresent = await pollEval(
        page,
        `Array.from(document.querySelectorAll('[data-test="board-inspector"] .ca-inspector-section-lab')).some((e) => e.textContent === 'Source')`,
        5000
      )
      expect(sourcePresent, 'the Source binder section renders').toBe(true)

      // The bind action lists the seeded browser board by title; clicking it fires the board's REAL
      // updateBoard(sourceBoardId) — the section then re-renders without the (now-bound) self option.
      const bindPresent = await pollEval(
        page,
        `Array.from(document.querySelectorAll('[data-test="board-inspector"] .ca-inspector-act-lab')).some((e) => e.textContent.includes('app-under-test'))`,
        3000
      )
      expect(bindPresent, 'the unbound inspector offers a live bind-to-browser action').toBe(true)
      expect(browserId, 'the browser board was seeded').toBeTruthy()
    } finally {
      await mainCall(electronApp, 'teardownProject', tmp)
    }
  })
})
