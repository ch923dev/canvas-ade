import { test, expect } from './fixtures'
import { evalIn, seed } from './helpers'
import type { Page } from '@playwright/test'

/**
 * @planning Mermaid Diagram element (v11 / S4) — the real-app integration jsdom CANNOT prove: a
 * `diagram` element with no svgCache must drive the HIDDEN MAIN render worker (a real Chromium
 * BrowserWindow with scoped `unsafe-eval`), get back sanitized SVG, and display it as an inert
 * `<img>` blob. jsdom stubs `getComputedTextLength`/`getBBox` to 0, so Mermaid layout only works in
 * a real browser — exactly why the worker exists and why this is an e2e, not a unit test.
 *
 * Renderer state crosses via structured-arg page.evaluate — ids/source flow as DATA, never
 * interpolated into eval'd code (CodeQL js/bad-code-sanitization, #82 pattern).
 */

/** Seed a planning board carrying one un-rendered diagram element (svgCache absent → must render). */
async function seedDiagram(page: Page, source: string): Promise<string> {
  const id = await seed(page, 'planning')
  await page.evaluate(
    ({ boardId, src }) => {
      ;(globalThis as any).__canvasE2E.patchBoard(boardId, {
        elements: [
          {
            id: 'dg-1',
            kind: 'diagram',
            x: 40,
            y: 40,
            w: 320,
            h: 220,
            source: src,
            engine: 'mermaid'
          }
        ]
      })
    },
    { boardId: id, src: source }
  )
  await evalIn(page, `window.__canvasE2E.fitView()`)
  await page.waitForTimeout(300)
  return id
}

/** Relative luminance (WCAG) of a `#rrggbb`/`#rgb` colour — used to assert the ER rows are DARK. */
function luminance(hex: string): number {
  const m = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(hex.trim())
  if (!m) return NaN
  let h = m[1]
  if (h.length === 3)
    h = h
      .split('')
      .map((c) => c + c)
      .join('')
  const ch = (i: number): number => {
    const c = parseInt(h.slice(i, i + 2), 16) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * ch(0) + 0.7152 * ch(2) + 0.0722 * ch(4)
}

/** Read the (only) diagram element's board-local size from the live store. */
async function diagramSize(page: Page, boardId: string): Promise<{ w: number; h: number }> {
  return page.evaluate((bid) => {
    const boards = (globalThis as any).__canvasE2E.getBoards() as {
      id: string
      type: string
      elements?: { kind: string; w: number; h: number }[]
    }[]
    const d = boards.find((x) => x.id === bid)?.elements?.find((e) => e.kind === 'diagram')
    return { w: d?.w ?? 0, h: d?.h ?? 0 }
  }, boardId)
}

test.describe('@planning diagram element (real Mermaid worker)', () => {
  test('renders a flowchart source to an inert SVG <img> via the hidden worker', async ({
    page
  }) => {
    await seedDiagram(page, 'graph TD\n  A[Plan] --> B[Build]\n  B --> C[Verify]')

    // The worker spawns a BrowserWindow + loads Mermaid on first render — allow a generous budget.
    const img = page.locator('.pl-diagram img')
    await expect(img).toBeVisible({ timeout: 20000 })
    // Displayed as a blob: object URL (CSP img-src blob:) — never an inline data: or remote URL.
    await expect(img).toHaveAttribute('src', /^blob:/, { timeout: 20000 })
    // The error fallback must NOT be showing for a valid source.
    await expect(page.locator('.pl-diagram-state')).toHaveCount(0)

    await page.screenshot({ path: 'test-results/diagram-flowchart.png' })
  })

  test('shows an inline parse error for an invalid source (no crash)', async ({ page }) => {
    await seedDiagram(page, 'graph TD\n  A --> ((((')
    // A bad source resolves to the error state, not a thrown render / blank img.
    await expect(page.locator('.pl-diagram-state')).toContainText(/error/i, { timeout: 20000 })
    await expect(page.locator('.pl-diagram img')).toHaveCount(0)
  })

  test('the bottom-right handle resizes the diagram via a real drag', async ({ page }) => {
    const boardId = await seedDiagram(page, 'graph TD\n  A[Plan] --> B[Build]')
    await expect(page.locator('.pl-diagram img')).toBeVisible({ timeout: 20000 })

    // Select the card (body click, below the 22px header) → the resize handle appears.
    await page.locator('.pl-diagram').click({ position: { x: 24, y: 80 } })
    const handle = page.locator('.pl-diagram-resize')
    await expect(handle).toBeVisible()
    await page.screenshot({ path: 'test-results/diagram-resize-handle.png' })

    const before = await diagramSize(page, boardId)
    const box = await handle.boundingBox()
    if (!box) throw new Error('resize handle has no bounding box')
    // Real OS drag of the corner handle outward by +80/+60 screen px.
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2 + 80, box.y + box.height / 2 + 60, { steps: 8 })
    await page.mouse.up()

    const after = await diagramSize(page, boardId)
    expect(after.w).toBeGreaterThan(before.w)
    expect(after.h).toBeGreaterThan(before.h)
  })

  test('erDiagram attribute rows render on DARK surfaces (a11y contrast — rowOdd/rowEven)', async ({
    page
  }) => {
    // The unified `erBox` renderer fills attribute rows from the `rowOdd`/`rowEven` theme vars (NOT
    // the legacy `attributeBackgroundColor*` — an earlier fix set those and was a silent no-op, so
    // Mermaid's near-white `rowOdd` default left half the rows unreadable). Render through the REAL
    // worker with the REAL theme builder (`diagramThemeVars`) and assert EVERY row background is
    // dark. Reads fills off the SVG string directly — CSP `connect-src` forbids fetching the blob.
    await seed(page, 'planning') // ensure the canvas + window.__canvasE2E are live
    const res = await page.evaluate(async () => {
      const g = globalThis as any
      const themeVars = g.__canvasE2E.diagramThemeVars()
      const out = await g.api.diagram.render({
        source:
          'erDiagram\n  USER ||--o{ ORDER : places\n  USER {\n' +
          '    string id PK\n    string email\n    string name\n' +
          '    int age\n    datetime createdAt\n    boolean active\n  }',
        themeVars,
        id: 'er-contrast'
      })
      if (!out.ok) return { error: out.error as string }
      const doc = new g.DOMParser().parseFromString(out.svg, 'image/svg+xml')
      const fillsOf = (cls: string): string[] =>
        Array.from(doc.querySelectorAll(`.${cls} path, .${cls} rect`) as Iterable<any>)
          .map((n: any) => n.getAttribute('fill'))
          .filter((f: unknown): f is string => !!f && f !== 'none')
      return { odd: fillsOf('row-rect-odd'), even: fillsOf('row-rect-even') }
    })

    expect('error' in res ? res.error : '').toBe('')
    if ('error' in res) return // narrow for TS; the assert above already failed
    // Both parities must have rendered (proves the source produced alternating rows, not an empty box).
    expect(res.odd.length).toBeGreaterThan(0)
    expect(res.even.length).toBeGreaterThan(0)
    // EVERY row background must be dark (luminance well below mid-grey). Mermaid's broken `rowOdd`
    // default is ≈ near-white (luminance ~0.9) → this fails loudly if the var name ever drifts again.
    for (const fill of [...res.odd, ...res.even]) {
      expect(luminance(fill), `row fill ${fill} must be dark`).toBeLessThan(0.2)
    }
  })

  test('semantic status classes tint nodes from tokens; motion sentinel is baked (S4b)', async ({
    page
  }) => {
    // Render through the REAL worker with the REAL theme builders: a bare `:::done`/`:::active`
    // (no classDef boilerplate — the agent contract) must land the class on the node group, and the
    // injected themeCSS must carry the token-derived status rules + the motion cache sentinel.
    await seed(page, 'planning')
    const res = await page.evaluate(async () => {
      const g = globalThis as any
      const out = await g.api.diagram.render({
        source: 'flowchart TD\n  A[Parse]:::done --> B[Build]:::active\n  B --> C[Ship]',
        themeVars: g.__canvasE2E.diagramThemeVars(),
        themeCss: g.__canvasE2E.diagramThemeCss(true),
        id: 'status-theme'
      })
      if (!out.ok) return { error: out.error as string }
      return {
        doneOnNode: /class="[^"]*node[^"]*done/.test(out.svg),
        activeOnNode: /class="[^"]*node[^"]*active/.test(out.svg),
        // Mermaid's serializer rewrites hex → rgb() (`#4f8cff` → `rgb(79, 140, 255)`) but passes
        // rgba() through verbatim — match the serialized forms.
        hasDoneRule: /\.node\.done rect[^}]+rgba\(62, 207, 142/.test(out.svg),
        hasActiveRule: /\.node\.active rect[^}]+(?:#4f8cff|rgb\(79, 140, 255\))/.test(out.svg),
        sentinel: out.svg.includes('expanse-motion-on')
      }
    })
    expect('error' in res ? res.error : '').toBe('')
    if ('error' in res) return
    expect(res.doneOnNode, 'bare :::done must land on the node <g>').toBe(true)
    expect(res.activeOnNode).toBe(true)
    expect(res.hasDoneRule, 'themeCSS done rule (ok-wash fill) must survive into the SVG').toBe(
      true
    )
    expect(res.hasActiveRule, 'themeCSS active rule (accent) must survive into the SVG').toBe(true)
    expect(res.sentinel, 'motion sentinel must be baked for cache invalidation').toBe(true)
  })

  test('edge flow: motion ON restyles animate:true edges; motion OFF forces them static', async ({
    page
  }) => {
    // The agent opt-in is Mermaid's own `e1@{ animate: true }` syntax. Motion ON must override the
    // built-in glacial dash (20s/50s) with the accent expanse-flow march; motion OFF (the
    // reduced-motion render) must strip animation entirely — same source, both proven through the
    // real worker (the cascade contract: id-prefixed themeCSS lands AFTER Mermaid's own rules).
    await seed(page, 'planning')
    const src = 'flowchart TD\n  A[Plan] e1@--> B[Build]\n  e1@{ animate: true }'
    const res = await page.evaluate(async (source) => {
      const g = globalThis as any
      const render = async (motion: boolean) =>
        g.api.diagram.render({
          source,
          themeVars: g.__canvasE2E.diagramThemeVars(),
          themeCss: g.__canvasE2E.diagramThemeCss(motion),
          id: motion ? 'flow-on' : 'flow-off'
        })
      const on = await render(true)
      const off = await render(false)
      if (!on.ok) return { error: on.error as string }
      if (!off.ok) return { error: off.error as string }
      return {
        edgeClassEmitted: on.svg.includes('edge-animation-fast'),
        onHasFlow: on.svg.includes('@keyframes expanse-flow'),
        onSentinel: on.svg.includes('expanse-motion-on'),
        // Serializer notes: selector lists are id-prefixed and re-joined without spaces (anchor on
        // the last selector), and `animation: none` expands to the full shorthand with the name
        // last (`animation:auto ease 0s 1 normal none running none!important`) — assert a `none`
        // inside an !important animation declaration; the motion-ON form (`expanse-flow … infinite`)
        // contains no `none`, so this stays discriminating.
        offKillsAnimation:
          /\.edge-animation-slow[^}]+animation:[^};]*\bnone\b[^};]*!important/.test(off.svg),
        offHasNoFlowKeyframes: !off.svg.includes('@keyframes expanse-flow'),
        offSentinel: off.svg.includes('expanse-motion-off')
      }
    }, src)
    expect('error' in res ? res.error : '').toBe('')
    if ('error' in res) return
    expect(res.edgeClassEmitted, 'animate:true must emit the edge-animation class').toBe(true)
    expect(res.onHasFlow).toBe(true)
    expect(res.onSentinel).toBe(true)
    expect(res.offKillsAnimation, 'reduced-motion render must force edges static').toBe(true)
    expect(res.offHasNoFlowKeyframes).toBe(true)
    expect(res.offSentinel).toBe(true)
  })

  test('the </> source toggle closes on a single click (no blur-then-reopen)', async ({ page }) => {
    // Regression: while editing, the source <textarea> holds focus. A bare press on </> blurred it
    // FIRST (onBlur → setEditing(false) → re-render), so the click then read editing===false and
    // RE-OPENED the editor — one click = close+reopen, the editor never closed. The fix is
    // preventDefault on the button's mousedown (keeps focus in the textarea → no spurious blur).
    await seedDiagram(page, 'graph TD\n  A[Plan] --> B[Build]')
    await expect(page.locator('.pl-diagram img')).toBeVisible({ timeout: 20000 })

    // Select the card (body click, below the 22px header) → the header + </> toggle appear.
    await page.locator('.pl-diagram').click({ position: { x: 24, y: 80 } })
    const toggle = page.locator('.pl-diagram-head button').last() // </> is always the last header button
    await expect(toggle).toBeVisible()

    // Open the source editor.
    await toggle.click()
    await expect(page.locator('.pl-diagram-src')).toBeVisible()

    // A SINGLE click must close it (pre-fix this reopened → the textarea stayed visible).
    await toggle.click()
    await expect(page.locator('.pl-diagram-src')).toHaveCount(0)
    await expect(page.locator('.pl-diagram img')).toBeVisible({ timeout: 20000 })
  })
})
