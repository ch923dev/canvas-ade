/**
 * REGRESSION GUARD — the native WebContentsView must track its HTML `.bb-frame` after a REAL
 * camera pan. Guards the useOnViewportChange single-slot collision (Canvas autosave clobbering
 * usePreviewManager's camera sync) that froze the native view on pan/zoom.
 * See docs/research/2026-06-06-browser-preview-camera-sync-rootcause.md.
 *
 * MUST use real OS input (sendInput wheel = panOnScroll): programmatic panBy/setZoom use
 * duration:0 and do NOT fire useOnViewportChange. MUST assert at settled rest only — mid-motion
 * the view is intentionally detached to an HTML snapshot (detach+snapshot LOD), so the native
 * rect is stale until re-attach. Asserts on deterministic viewBounds (main getter), never
 * capturePage (memory: e2e-browser-trio-flake).
 *   pnpm build; pnpm exec playwright test e2e/preview-align.e2e.ts
 */
import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { mainCall, seed } from './helpers'

interface NativeBounds {
  attached: boolean
  bounds: { x: number; y: number; width: number; height: number }
}
interface FrameRect {
  left: number
  top: number
  width: number
  height: number
}

// Read renderer state via structured-arg page.evaluate — the board id flows as DATA, never
// interpolated into an eval'd code string (which CodeQL flags as js/bad-code-sanitization: a
// JSON.stringify'd value embedded in code can still break out via U+2028/U+2029). Each
// evaluated function is self-contained — page.evaluate serializes only the function + its arg,
// so it cannot close over module scope. tsconfig.node includes e2e/ but has no DOM lib, so the
// browser globals are reached via `globalThis` (known to tsc) cast through `any` (no-explicit-any
// is off for e2e/) — that is also why the rest of the suite probes through eval strings.
const callHook = (page: Page, method: string, ...args: unknown[]): Promise<void> =>
  page.evaluate(({ method, args }) => (globalThis as any).__canvasE2E[method](...args), {
    method,
    args
  })
const runtimeStatus = (page: Page, id: string, status: string): Promise<boolean> =>
  page.evaluate(
    (a) => {
      const r = (globalThis as any).__canvasE2E.getRuntime(a.id)
      return !!r && r.status === a.status
    },
    { id, status }
  )
const runtimeLive = (page: Page, id: string): Promise<boolean> =>
  page.evaluate((id) => {
    const r = (globalThis as any).__canvasE2E.getRuntime(id)
    return !!r && r.live === true
  }, id)
const frameRect = (page: Page, id: string): Promise<FrameRect | null> =>
  page.evaluate((id) => {
    const el: any = Array.from(
      (globalThis as any).document.querySelectorAll('[data-bb-frame]')
    ).find((e: any) => e.getAttribute('data-bb-frame') === id)
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { left: r.left, top: r.top, width: r.width, height: r.height }
  }, id)

const pollTrue = async (fn: () => Promise<boolean>, timeout: number): Promise<boolean> => {
  try {
    await expect.poll(fn, { timeout }).toBe(true)
    return true
  } catch {
    return false
  }
}

const BORDER = 1
const TOLERANCE = 2 // px — native vs frame-inset at settled rest

test.describe('@preview preview camera-sync regression', () => {
  test('native rect tracks the .bb-frame after a REAL panOnScroll', async ({
    page,
    electronApp
  }) => {
    const url = await mainCall<string>(electronApp, 'localUrl')
    const id = await seed(page, 'browser', { url })
    await page.waitForTimeout(150)
    await callHook(page, 'fitView', id)
    expect(await pollTrue(() => runtimeStatus(page, id, 'connected'), 12_000)).toBe(true)
    await pollTrue(() => runtimeLive(page, id), 8000)
    await page.waitForTimeout(600)

    // native (main) + frame-inset (renderer) divergence, plus the attached flag.
    async function divergence(): Promise<{ attached: boolean; maxAbs: number } | null> {
      const nb = await mainCall<NativeBounds | null>(electronApp, 'viewBounds', id)
      const fr = await frameRect(page, id)
      if (!nb || !fr) return null
      const ex = {
        x: fr.left + BORDER,
        y: fr.top + BORDER,
        width: fr.width - BORDER * 2,
        height: fr.height - BORDER * 2
      }
      const maxAbs = Math.max(
        Math.abs(nb.bounds.x - ex.x),
        Math.abs(nb.bounds.y - ex.y),
        Math.abs(nb.bounds.width - ex.width),
        Math.abs(nb.bounds.height - ex.height)
      )
      return { attached: nb.attached, maxAbs }
    }

    // Sanity: at rest the native must be live and aligned with its frame.
    const rest = await divergence()
    expect(rest, 'measured a rest native rect').not.toBeNull()
    expect(rest!.attached, 'native view is live at rest').toBe(true)
    expect(rest!.maxAbs, `rest divergence ${rest!.maxAbs}px`).toBeLessThanOrEqual(TOLERANCE)

    // REAL panOnScroll (wheel over the empty left margin, clear of the device stage → the
    // canvas PANS; zoom needs Ctrl/Meta). Pan DOWN (deltaY > 0 moves the board down) so the
    // board's stage TOP stays >= paneTop and the board remains live-eligible at rest
    // (isLiveEligible: screenY >= paneTop — a board panned above the pane top correctly
    // demotes to a snapshot since a WebContentsView can't clip above the pane).
    for (let step = 0; step < 4; step++) {
      await mainCall(electronApp, 'sendInput', {
        type: 'mouseWheel',
        x: 60,
        y: 380,
        deltaX: 0,
        deltaY: 90
      })
      await page.waitForTimeout(120)
    }

    // Settle: the rAF pump self-stops after a few idle frames and endMotion re-attaches the
    // native view. Poll until the view is attached again AND aligned, then hard-assert.
    await expect
      .poll(
        async () => {
          const d = await divergence()
          return d && d.attached ? d.maxAbs : Number.POSITIVE_INFINITY
        },
        {
          message: 'native re-attaches and tracks the frame within 2px after the pan',
          timeout: 6000,
          intervals: [200, 200, 300, 500]
        }
      )
      .toBeLessThanOrEqual(TOLERANCE)
  })

  // A native WebContentsView paints above ALL HTML, so a Browser board whose live stage
  // overlaps the fixed "Project context" digest panel (a 300px left overlay) would cover it
  // — the page bleeds out of bounds over the panel when you pan the board under it. The fix
  // adds the open panel's rect to the occlusion zones so an overlapping live view demotes to
  // its (clippable, z-ordered) HTML snapshot. This guards that demote.
  test('Browser native demotes to snapshot when panned under the open digest panel', async ({
    page,
    electronApp
  }) => {
    const url = await mainCall<string>(electronApp, 'localUrl')
    const id = await seed(page, 'browser', { url })
    await page.waitForTimeout(150)
    await callHook(page, 'fitView', id)
    expect(await pollTrue(() => runtimeStatus(page, id, 'connected'), 12_000)).toBe(true)
    await pollTrue(() => runtimeLive(page, id), 8000)
    await page.waitForTimeout(400)

    const attached = async (): Promise<boolean | null> => {
      const nb = await mainCall<NativeBounds | null>(electronApp, 'viewBounds', id)
      return nb ? nb.attached : null
    }

    // Open the panel; the board (centered by fitView) starts clear of the 300px panel → live.
    await callHook(page, 'openDigest')
    await page.waitForTimeout(400)
    expect(await attached(), 'board is live before it overlaps the panel').toBe(true)

    // Real panOnScroll LEFT (deltaX < 0 moves the board left) until its stage sits under the
    // panel. Then it must DEMOTE — a live native view here would paint over the panel.
    for (let step = 0; step < 5; step++) {
      await mainCall(electronApp, 'sendInput', {
        type: 'mouseWheel',
        x: 600,
        y: 400,
        deltaX: -120,
        deltaY: 0
      })
      await page.waitForTimeout(120)
    }
    await expect
      .poll(attached, {
        message: 'native demotes to snapshot while overlapping the open digest panel',
        timeout: 6000,
        intervals: [200, 200, 300, 500]
      })
      .toBe(false)

    // Closing the panel removes the occlusion → the board re-attaches (proves the demote is
    // panel-specific, not merely a side effect of the leftward pan).
    await callHook(page, 'closeDigest')
    await expect
      .poll(attached, {
        message: 'native re-attaches once the digest panel closes',
        timeout: 6000,
        intervals: [200, 200, 300, 500]
      })
      .toBe(true)
  })
})
