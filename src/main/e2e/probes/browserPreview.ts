/**
 * Browser-board / native-WebContentsView probes: a non-blank per-view capturePage
 * (the gap mainWindow.capturePage can't see), node-gesture detach/reattach, focus
 * detach (the #43961 ghost), and refused-URL → load-failed.
 */
import type { E2EProbe } from '../types'

// ── Browser: seed pointing at the in-process localServer (deterministic), fit the
// camera to it (forces zoom ≥ LOD so the native view attaches), wait for the
// connected status, then assert a NON-BLANK per-view capturePage (the gap). ──
export const browser: E2EProbe = {
  name: 'browser',
  async run(ctx) {
    const browserId = await ctx.evalIn<string>(
      `window.__canvasE2E.seedBoard('browser', { url: ${JSON.stringify(ctx.localUrl)} })`
    )
    ctx.ids.browserId = browserId
    await ctx.delay(150) // let React Flow mount + measure the new node before fitView
    await ctx.evalIn(`window.__canvasE2E.fitView(${JSON.stringify(browserId)})`)
    const connected = await ctx.poll(async () => {
      const rt = await ctx.evalIn<{ status: string; live: boolean } | null>(
        `window.__canvasE2E.getRuntime(${JSON.stringify(browserId)})`
      )
      return rt?.status === 'connected' && rt.live === true
    }, 10000)
    let capDetail = 'not connected'
    let browserOk = false
    if (connected) {
      // Brief pause after connected: the view needs at least one paint before
      // capturePage yields non-blank pixels.
      await ctx.delay(300)
      const cap = await ctx.dbg.captureView(browserId)
      browserOk = cap.attached && !cap.empty
      capDetail = `attached=${cap.attached} empty=${cap.empty}`
    }
    ctx.ids.browserOk = browserOk // gesture + focus-detach gate on this verdict
    return { name: 'browser', ok: browserOk, detail: capDetail }
  }
}

// ── Occlusion fix (node-drag/resize detach): a node gesture must DETACH every live
// native view to its HTML snapshot — a native WebContentsView paints above all HTML,
// so without this a board dragged over a live Browser board is occluded by it. Drive
// previewStore.nodeGesture and assert the live flag drops on start, restores on end. ──
export const browserGesture: E2EProbe = {
  name: 'browser-gesture',
  async run(ctx) {
    const browserId = ctx.ids.browserId!
    const browserOk = ctx.ids.browserOk === true // the `browser` probe's capturePage verdict
    let gestureDetail = 'browser not live'
    let gestureOk = false
    if (browserOk) {
      await ctx.evalIn('window.__canvasE2E.setGesture(true)')
      const detached = await ctx.poll(async () => {
        const rt = await ctx.evalIn<{ live: boolean } | null>(
          `window.__canvasE2E.getRuntime(${JSON.stringify(browserId)})`
        )
        return rt?.live === false
      }, 5000)
      await ctx.evalIn('window.__canvasE2E.setGesture(false)')
      const reattached = await ctx.poll(async () => {
        const rt = await ctx.evalIn<{ live: boolean } | null>(
          `window.__canvasE2E.getRuntime(${JSON.stringify(browserId)})`
        )
        return rt?.live === true
      }, 8000)
      gestureOk = detached && reattached
      gestureDetail = `detached=${detached} reattached=${reattached}`
    }
    return { name: 'browser-gesture', ok: gestureOk, detail: gestureDetail }
  }
}

// ── Bug 2 (focus webview ghost): double-clicking a terminal focuses it (animated
// fitView). A live Browser elsewhere must DETACH cleanly for the focus (no native view
// left attached → the #43961 ghost) and REATTACH on unfocus. The compositor pixel isn't
// code-assertable, but the detach/reattach invariant the fix preserves is. ──
export const focusDetach: E2EProbe = {
  name: 'focus-detach',
  async run(ctx) {
    const browserId = ctx.ids.browserId!
    const termId = ctx.ids.termId!
    const browserOk = ctx.ids.browserOk === true
    let focusOk = false
    let focusDetail = 'browser not live before focus'
    if (browserOk) {
      await ctx.evalIn(`window.__canvasE2E.fitView(${JSON.stringify(browserId)})`)
      await ctx.poll(async () => {
        const rt = await ctx.evalIn<{ live: boolean } | null>(
          `window.__canvasE2E.getRuntime(${JSON.stringify(browserId)})`
        )
        return rt?.live === true
      }, 5000)
      await ctx.evalIn(`window.__canvasE2E.setFocus(${JSON.stringify(termId)})`) // focus the terminal
      await ctx.delay(500) // focus effect → applyLiveness demotes the non-focused browser
      const capFocused = await ctx.dbg.captureView(browserId)
      const detachedOnFocus = !capFocused.attached
      await ctx.evalIn('window.__canvasE2E.setFocus(null)') // clear focus → browser reattaches
      await ctx.evalIn(`window.__canvasE2E.fitView(${JSON.stringify(browserId)})`)
      const reattached = await ctx.poll(async () => {
        const rt = await ctx.evalIn<{ live: boolean } | null>(
          `window.__canvasE2E.getRuntime(${JSON.stringify(browserId)})`
        )
        return rt?.live === true
      }, 8000)
      focusOk = detachedOnFocus && reattached
      focusDetail = `detachedOnFocus=${detachedOnFocus} reattached=${reattached}`
    }
    return {
      name: 'focus-detach',
      ok: focusOk,
      detail: focusOk ? 'browser detached on terminal focus, reattached on unfocus' : focusDetail
    }
  }
}

// ── Fix #4 (dead-URL status): a refused connection must end as 'load-failed',
// NOT 'connected' (Chromium's error-page did-finish-load previously clobbered the
// failure). Seed a browser at a closed port and assert the runtime status. ──
export const browserDeadUrl: E2EProbe = {
  name: 'browser-deadurl',
  async run(ctx) {
    const deadUrl = 'http://127.0.0.1:59999/' // nothing listens → connection refused
    const deadId = await ctx.evalIn<string>(
      `window.__canvasE2E.seedBoard('browser', { url: ${JSON.stringify(deadUrl)} })`
    )
    ctx.ids.deadId = deadId
    await ctx.delay(150)
    await ctx.evalIn(`window.__canvasE2E.fitView(${JSON.stringify(deadId)})`)
    const failedOk = await ctx.poll(async () => {
      const rt = await ctx.evalIn<{ status: string; live: boolean } | null>(
        `window.__canvasE2E.getRuntime(${JSON.stringify(deadId)})`
      )
      return rt?.status === 'load-failed'
    }, 12000)
    return {
      name: 'browser-deadurl',
      ok: failedOk,
      detail: failedOk ? 'refused URL → load-failed' : `did not reach load-failed`
    }
  }
}
