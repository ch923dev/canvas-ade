import { test, expect } from './fixtures'
import { evalIn, mainCall, pollEval, seed, selectForInspector } from './helpers'

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

test.describe('@chrome @planning Board Inspector — Planning per-type content', () => {
  test('selecting a planning board reveals the inspector; the tool palette round-trips + keeps the board selected', async ({
    page,
    electronApp
  }) => {
    const tmp = await mainCall<string>(
      electronApp,
      'createTempProject',
      'inspector-p-',
      'inspector-p'
    )
    try {
      await evalIn(page, `window.__canvasE2E.openProjectFromDisk(${JSON.stringify(tmp)})`)
      const id = await seed(page, 'planning')
      await evalIn(page, `window.__canvasE2E.select(${JSON.stringify(id)})`)
      await evalIn(page, `window.__canvasE2E.setZoom(1)`) // eligibility requires zoom >= 0.4

      // The tool palette MOVED off the board into the Inspector (P3); the Select tool cell is a stable
      // presence probe (Tools is always open). Poll it — the shell reveals a tick before the portal mounts.
      const present = await pollEval(
        page,
        `!!document.querySelector('[data-test="board-inspector"] [data-test="plan-tool-select"]')`,
        5000
      )
      expect(present, 'PlanningInspector tool palette is portaled into the shell slot').toBe(true)

      const revealed = await pollEval(
        page,
        `document.querySelector('[data-test="board-inspector"]')?.getAttribute('data-revealed') === 'true'`,
        3000
      )
      expect(revealed, 'selecting a single planning board reveals the inspector').toBe(true)

      const labels = await evalIn<string>(
        page,
        `Array.from(document.querySelectorAll('[data-test="board-inspector"] .ca-inspector-section-lab')).map((e) => e.textContent).join('|')`
      )
      for (const section of ['Tools', 'Canvas']) {
        expect(labels, `the ${section} section renders`).toContain(section)
      }

      // Default tool is 'select' → its cell starts checked. Clicking the Pen cell fires the board's REAL
      // setTool; the change round-trips back into the presentation-only grid (value is driven by the
      // board's tool state).
      const selectStartsOn = await evalIn<boolean>(
        page,
        `document.querySelector('[data-test="board-inspector"] [data-test="plan-tool-select"]')?.getAttribute('aria-checked') === 'true'`
      )
      expect(selectStartsOn, 'the Select tool starts active').toBe(true)

      await evalIn(
        page,
        `document.querySelector('[data-test="board-inspector"] [data-test="plan-tool-pen"]').click()`
      )
      const penActive = await pollEval(
        page,
        `document.querySelector('[data-test="board-inspector"] [data-test="plan-tool-pen"]')?.getAttribute('aria-checked') === 'true'`,
        3000
      )
      expect(penActive, 'clicking the inspector Pen cell sets the tool via the real handler').toBe(
        true
      )

      // D3: picking a tool clears only the element selection, never the board's — so the board stays the
      // single eligible selection and the inspector stays revealed through the pick (no mid-draw hide).
      const stillRevealed = await evalIn<boolean>(
        page,
        `document.querySelector('[data-test="board-inspector"]')?.getAttribute('data-revealed') === 'true'`
      )
      expect(stillRevealed, 'picking a tool does not deselect the board / hide the inspector').toBe(
        true
      )
    } finally {
      await mainCall(electronApp, 'teardownProject', tmp)
    }
  })

  test('selecting a text element grows the Element section; a typography patch round-trips + keeps the board selected', async ({
    page,
    electronApp
  }) => {
    const tmp = await mainCall<string>(
      electronApp,
      'createTempProject',
      'inspector-pe-',
      'inspector-pe'
    )
    try {
      await evalIn(page, `window.__canvasE2E.openProjectFromDisk(${JSON.stringify(tmp)})`)
      const id = await seed(page, 'planning')
      // Seed one free-text element (M size) mid-board via the store, ids flow as DATA (not
      // interpolated into eval'd code — the #82/#114 CodeQL pattern, mirroring noteTint.e2e.ts).
      await page.evaluate((bid) => {
        ;(
          globalThis as unknown as { __canvasE2E: { patchBoard: (id: string, p: unknown) => void } }
        ).__canvasE2E.patchBoard(bid, {
          elements: [{ id: 'tp-1', kind: 'text', x: 220, y: 140, text: 'hello', fontSize: 'M' }]
        })
      }, id)
      await evalIn(page, `window.__canvasE2E.select(${JSON.stringify(id)})`)
      // fitView frames the board large + centred, clear of the left-docked inspector lane, so a REAL
      // click can reach board content without the popover occluding it (zoom stays ≥ 0.4 → revealed).
      await evalIn(page, `window.__canvasE2E.fitView(${JSON.stringify(id)})`)

      // No element selected yet → the inspector shows Tools/Canvas but NO Element section (empty state).
      await pollEval(
        page,
        `!!document.querySelector('[data-test="board-inspector"] [data-test="plan-tool-select"]')`,
        5000
      )
      const beforeLabels = await evalIn<string>(
        page,
        `Array.from(document.querySelectorAll('[data-test="board-inspector"] .ca-inspector-section-lab')).map((e) => e.textContent).join('|')`
      )
      expect(beforeLabels, 'no Element section until an element is selected').not.toContain(
        'Element'
      )

      // A fresh project shows the recap-consent modal CENTRED over the canvas; the other inspector
      // tests drive the left panel via evalIn (so they work through its scrim), but this one needs a
      // REAL pointer on board content — decline it first so it can't occlude the grip.
      await page
        .locator('[data-test="recap-decline"]')
        .click({ timeout: 5000 })
        .catch(() => {})

      // Select the text element with a REAL click on its drag grip (fires the board's selectOnPress) —
      // the select tool is the default, so the board is interactive.
      const grip = page.locator(`[data-id="${id}"] .pl-text-grip`)
      await grip.waitFor({ state: 'visible' })
      await grip.click()

      // The Element section appears at the top with the typography controls (homogeneous text).
      const typographyPresent = await pollEval(
        page,
        `!!document.querySelector('[data-test="board-inspector"] [aria-label="Font size"]')`,
        3000
      )
      expect(typographyPresent, 'selecting a text element grows the typography controls').toBe(true)

      const revealed = await evalIn<boolean>(
        page,
        `document.querySelector('[data-test="board-inspector"]')?.getAttribute('data-revealed') === 'true'`
      )
      expect(revealed, 'the board stays selected + the inspector revealed').toBe(true)

      // Click a different size (L) in the inspector → fires the board's REAL typography patch; read it
      // back off the store to prove the round-trip (M → L).
      const sizeOf = (): Promise<string | undefined> =>
        page.evaluate((bid) => {
          const boards = (
            globalThis as unknown as {
              __canvasE2E: {
                getBoards: () => {
                  id: string
                  type: string
                  elements?: { id: string; fontSize?: string }[]
                }[]
              }
            }
          ).__canvasE2E.getBoards()
          const b = boards.find((x) => x.id === bid)
          return b?.type === 'planning'
            ? b.elements?.find((e) => e.id === 'tp-1')?.fontSize
            : undefined
        }, id)
      expect(await sizeOf(), 'text starts at M').toBe('M')

      await evalIn(
        page,
        `Array.from(document.querySelectorAll('[data-test="board-inspector"] [aria-label="Font size"] button')).find((b) => b.textContent.trim() === 'L').click()`
      )
      await expect
        .poll(sizeOf, { message: 'the inspector L segment patches the element via the real store' })
        .toBe('L')

      // The typography patch must NOT deselect the board — the inspector stays revealed.
      const stillRevealed = await evalIn<boolean>(
        page,
        `document.querySelector('[data-test="board-inspector"]')?.getAttribute('data-revealed') === 'true'`
      )
      expect(
        stillRevealed,
        'a typography patch keeps the board selected / inspector revealed'
      ).toBe(true)
    } finally {
      await mainCall(electronApp, 'teardownProject', tmp)
    }
  })

  test('P4b: the Element Appearance block round-trips opacity + z-order through the real store', async ({
    page,
    electronApp
  }) => {
    const tmp = await mainCall<string>(
      electronApp,
      'createTempProject',
      'inspector-p4b-',
      'inspector-p4b'
    )
    try {
      await evalIn(page, `window.__canvasE2E.openProjectFromDisk(${JSON.stringify(tmp)})`)
      const id = await seed(page, 'planning')
      // Two text elements: ap-1 is first in the array (painted at the BACK), ap-2 last (FRONT). Text
      // is used (not a note) because its grip selects with a real click without the note grip's
      // drag-capture; opacity + z-order are all-kind, so text exercises them fully. Ids flow as DATA,
      // never interpolated into eval'd code (the #82/#114 CodeQL pattern).
      await page.evaluate((bid) => {
        ;(
          globalThis as unknown as { __canvasE2E: { patchBoard: (id: string, p: unknown) => void } }
        ).__canvasE2E.patchBoard(bid, {
          elements: [
            { id: 'ap-1', kind: 'text', x: 200, y: 140, text: 'AAA', fontSize: 'M' },
            { id: 'ap-2', kind: 'text', x: 360, y: 200, text: 'BBB', fontSize: 'M' }
          ]
        })
      }, id)
      await evalIn(page, `window.__canvasE2E.select(${JSON.stringify(id)})`)
      await evalIn(page, `window.__canvasE2E.fitView(${JSON.stringify(id)})`)
      await pollEval(
        page,
        `!!document.querySelector('[data-test="board-inspector"] [data-test="plan-tool-select"]')`,
        5000
      )
      // Decline the fresh-project recap modal so it can't occlude the grip.
      await page
        .locator('[data-test="recap-decline"]')
        .click({ timeout: 5000 })
        .catch(() => {})

      // Select ap-1 (the back element) with a REAL click on its drag grip — the select tool is default.
      const grip = page.locator(`[data-id="${id}"] .pl-text-grip`).first()
      await grip.waitFor({ state: 'visible' })
      await grip.click()

      // The Element section grows the Appearance sub-block — the opacity slider is always present.
      const opacityPresent = await pollEval(
        page,
        `!!document.querySelector('[data-test="board-inspector"] [aria-label="Element opacity"]')`,
        3000
      )
      expect(opacityPresent, 'selecting an element grows the Appearance opacity slider').toBe(true)

      // Read helpers off the real store.
      const opacityOf = (): Promise<number | undefined> =>
        page.evaluate((bid) => {
          const boards = (
            globalThis as unknown as {
              __canvasE2E: {
                getBoards: () => {
                  id: string
                  type: string
                  elements?: { id: string; opacity?: number }[]
                }[]
              }
            }
          ).__canvasE2E.getBoards()
          const b = boards.find((x) => x.id === bid)
          return b?.type === 'planning'
            ? b.elements?.find((e) => e.id === 'ap-1')?.opacity
            : undefined
        }, id)
      const orderOf = (): Promise<string[] | undefined> =>
        page.evaluate((bid) => {
          const boards = (
            globalThis as unknown as {
              __canvasE2E: {
                getBoards: () => { id: string; type: string; elements?: { id: string }[] }[]
              }
            }
          ).__canvasE2E.getBoards()
          const b = boards.find((x) => x.id === bid)
          return b?.type === 'planning' ? b.elements?.map((e) => e.id) : undefined
        }, id)

      expect(await opacityOf(), 'starts fully opaque (absent)').toBeUndefined()
      expect(await orderOf(), 'ap-1 starts at the back (index 0)').toEqual(['ap-1', 'ap-2'])

      // Drag the opacity slider to 40% — set the native range value + dispatch the input event so
      // React's onChange fires (synthetic .value assignment alone doesn't notify React).
      await evalIn(
        page,
        `(() => {
          const s = document.querySelector('[data-test="board-inspector"] [aria-label="Element opacity"]');
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          setter.call(s, '40');
          s.dispatchEvent(new Event('input', { bubbles: true }));
        })()`
      )
      await expect
        .poll(opacityOf, { message: 'the opacity slider patches the element via the real store' })
        .toBe(0.4)

      // Bring ap-1 to front → it moves to the end of the array (painted last / on top).
      await evalIn(
        page,
        `document.querySelector('[data-test="board-inspector"] [aria-label="Z-order"] button[title="Bring to front"]').click()`
      )
      await expect
        .poll(orderOf, { message: 'bring-to-front reorders ap-1 to the front (array end)' })
        .toEqual(['ap-2', 'ap-1'])

      // Each is one undo step: undo restores the order, then undo restores the opacity.
      await evalIn(page, 'window.__canvasE2E.undo()')
      await expect
        .poll(orderOf, { message: 'one undo restores the z-order' })
        .toEqual(['ap-1', 'ap-2'])
      await evalIn(page, 'window.__canvasE2E.undo()')
      await expect
        .poll(opacityOf, { message: 'one undo restores the opacity (back to absent/opaque)' })
        .toBeUndefined()
    } finally {
      await mainCall(electronApp, 'teardownProject', tmp)
    }
  })

  test('P4b: CREATING an element auto-selects it → the Element section appears immediately', async ({
    page,
    electronApp
  }) => {
    const tmp = await mainCall<string>(
      electronApp,
      'createTempProject',
      'inspector-p4bc-',
      'inspector-p4bc'
    )
    try {
      await evalIn(page, `window.__canvasE2E.openProjectFromDisk(${JSON.stringify(tmp)})`)
      const id = await seed(page, 'planning', { w: 560, h: 420 })
      await evalIn(page, `window.__canvasE2E.select(${JSON.stringify(id)})`)
      await evalIn(page, `window.__canvasE2E.fitView(${JSON.stringify(id)})`)
      await evalIn(page, `window.__canvasE2E.setZoom(1)`)
      // Wait for the well to mount. The board id flows as a DATA arg to page.evaluate/waitForFunction
      // (interpolated into the CSS selector INSIDE the browser callback), never into a host-side eval'd
      // code string — the #82/#114 CodeQL js/bad-code-sanitization pattern.
      await page.waitForFunction(
        (bid) =>
          !!(globalThis as any).document.querySelector(
            `.react-flow__node[data-id="${bid}"] .pl-well`
          ),
        id,
        { timeout: 5000 }
      )
      // Decline the fresh-project recap modal so it can't occlude the well tap.
      await page
        .locator('[data-test="recap-decline"]')
        .click({ timeout: 5000 })
        .catch(() => {})

      // Baseline: nothing selected → no Element section (Appearance opacity slider absent). The
      // selector is a compile-time constant (no id) so evalIn is safe here.
      const opacitySel = `[data-test="board-inspector"] [aria-label="Element opacity"]`
      expect(
        await evalIn<boolean>(page, `!!document.querySelector('${opacitySel}')`),
        'no Element section before any element exists'
      ).toBe(false)

      // Arm the Note tool (real key routed to the focused well) + tap an empty spot to CREATE a note.
      await page.evaluate(
        (bid) =>
          (globalThis as any).document
            .querySelector(`.react-flow__node[data-id="${bid}"] .pl-well`)
            ?.focus(),
        id
      )
      await page.keyboard.press('n')
      const well = await page.evaluate((bid) => {
        const w = (globalThis as any).document.querySelector(
          `.react-flow__node[data-id="${bid}"] .pl-well`
        )
        const r = w.getBoundingClientRect()
        return { x: Math.round(r.left + 90), y: Math.round(r.top + 90) }
      }, id)
      // A note is created on pointerDOWN (onWellPointerDown); send a full tap for a clean gesture.
      await mainCall(electronApp, 'sendInput', {
        type: 'mouseDown',
        x: well.x,
        y: well.y,
        button: 'left',
        clickCount: 1
      })
      await mainCall(electronApp, 'sendInput', {
        type: 'mouseUp',
        x: well.x,
        y: well.y,
        button: 'left',
        clickCount: 1
      })

      // The freshly-created note is auto-selected → the Element section's Appearance opacity slider
      // appears WITHOUT any manual grip click (the maintainer's create-flow bug: PR #277).
      const appeared = await pollEval(page, `!!document.querySelector('${opacitySel}')`, 3000)
      expect(appeared, 'creating a note auto-selects it → the Element section shows').toBe(true)
    } finally {
      await mainCall(electronApp, 'teardownProject', tmp)
    }
  })
})

test.describe('@chrome Board Inspector — full-view overlay (P5-D7)', () => {
  test('full view raises the inspector above the scrim; exit restores the base layer', async ({
    page,
    electronApp
  }) => {
    const tmp = await mainCall<string>(
      electronApp,
      'createTempProject',
      'inspector-fv-',
      'inspector-fv'
    )
    try {
      await evalIn(page, `window.__canvasE2E.openProjectFromDisk(${JSON.stringify(tmp)})`)
      const id = await seed(page, 'planning')
      await selectForInspector(page, id)

      const revealed = await pollEval(
        page,
        `document.querySelector('[data-test="board-inspector"]')?.getAttribute('data-revealed') === 'true'`,
        3000
      )
      expect(revealed, 'selecting the board reveals the inspector').toBe(true)

      // Enter full view → the scrim (z 200) mounts; the wrap must jump to the menu layer (250) so
      // the inspector — the ONE control home since P5 removed the title-bar clusters — stays
      // reachable over the modal.
      await evalIn(page, `window.__canvasE2E.setFullView(${JSON.stringify(id)})`)
      const raised = await pollEval(
        page,
        `!!document.querySelector('.fullview-scrim') && getComputedStyle(document.querySelector('.ca-inspector-wrap')).zIndex === '250'`,
        3000
      )
      expect(raised, 'the inspector wrap rises above the full-view scrim').toBe(true)

      // Still revealed + interactive over the modal: the Tools palette keeps firing its handler.
      await evalIn(
        page,
        `document.querySelector('[data-test="board-inspector"] [data-test="plan-tool-note"]').click()`
      )
      const toolPicked = await pollEval(
        page,
        `document.querySelector('[data-test="board-inspector"] [data-test="plan-tool-note"]')?.getAttribute('aria-checked') === 'true'`,
        3000
      )
      expect(toolPicked, 'an inspector control fires over the full-view scrim').toBe(true)

      // Exit full view → the scrim unmounts and the wrap returns to the base chrome layer.
      await evalIn(page, `window.__canvasE2E.setFullView(null)`)
      const restored = await pollEval(
        page,
        `!document.querySelector('.fullview-scrim') && getComputedStyle(document.querySelector('.ca-inspector-wrap')).zIndex === '45'`,
        4000
      )
      expect(restored, 'exiting full view restores the base z-index').toBe(true)
    } finally {
      await mainCall(electronApp, 'teardownProject', tmp)
    }
  })
})
