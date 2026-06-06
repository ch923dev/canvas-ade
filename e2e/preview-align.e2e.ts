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
import { test, expect } from './fixtures'
import { evalIn, mainCall, pollEval, seed } from './helpers'

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

// These helpers build strings evaluated in the renderer (evalIn). The interpolated values are
// the app's own seed() board id + our status literals — never external input — but allowlist
// them so the eval-string construction is provably sanitized (CodeQL js/code-injection) and a
// malformed token fails loudly instead of silently.
const safe = (v: string): string => {
  if (!/^[\w-]+$/.test(v)) throw new Error(`unsafe e2e token: ${JSON.stringify(v)}`)
  return v
}
const runtimeStatus = (id: string, status: string): string =>
  `(() => { const r = window.__canvasE2E.getRuntime(${JSON.stringify(safe(id))}); return !!r && r.status === ${JSON.stringify(safe(status))}; })()`
const runtimeLive = (id: string): string =>
  `(() => { const r = window.__canvasE2E.getRuntime(${JSON.stringify(safe(id))}); return !!r && r.live === true; })()`
const frameRectExpr = (id: string): string =>
  `(() => { const el = document.querySelector('[data-bb-frame="${safe(id)}"]'); if (!el) return null; const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height }; })()`

const BORDER = 1
const TOLERANCE = 2 // px — native vs frame-inset at settled rest

test.describe('preview camera-sync regression', () => {
  test('native rect tracks the .bb-frame after a REAL panOnScroll', async ({
    page,
    electronApp
  }) => {
    const url = await mainCall<string>(electronApp, 'localUrl')
    const id = await seed(page, 'browser', { url })
    await page.waitForTimeout(150)
    await evalIn(page, `window.__canvasE2E.fitView(${JSON.stringify(safe(id))})`)
    expect(await pollEval(page, runtimeStatus(id, 'connected'), 12_000)).toBe(true)
    await pollEval(page, runtimeLive(id), 8000)
    await page.waitForTimeout(600)

    // native (main) + frame-inset (renderer) divergence, plus the attached flag.
    async function divergence(): Promise<{ attached: boolean; maxAbs: number } | null> {
      const nb = await mainCall<NativeBounds | null>(electronApp, 'viewBounds', id)
      const fr = await evalIn<FrameRect | null>(page, frameRectExpr(id))
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
    await evalIn(page, `window.__canvasE2E.fitView(${JSON.stringify(safe(id))})`)
    expect(await pollEval(page, runtimeStatus(id, 'connected'), 12_000)).toBe(true)
    await pollEval(page, runtimeLive(id), 8000)
    await page.waitForTimeout(400)

    const attached = async (): Promise<boolean | null> => {
      const nb = await mainCall<NativeBounds | null>(electronApp, 'viewBounds', id)
      return nb ? nb.attached : null
    }

    // Open the panel; the board (centered by fitView) starts clear of the 300px panel → live.
    await evalIn(page, 'window.__canvasE2E.openDigest()')
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
    await evalIn(page, 'window.__canvasE2E.closeDigest()')
    await expect
      .poll(attached, {
        message: 'native re-attaches once the digest panel closes',
        timeout: 6000,
        intervals: [200, 200, 300, 500]
      })
      .toBe(true)
  })
})
