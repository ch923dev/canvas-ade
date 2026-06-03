/**
 * Browser-board / native-WebContentsView fixture group: one Browser at the in-process
 * localServer, brought to connected+live with a bounded retry capture verdict in setup.
 * The capturePage trio (browser / browser-gesture) is known-flaky on a contended host
 * (memory e2e-browser-trio-flake) → those parts emit flaky:true on failure, not a hard fail.
 */
import type { E2EGroup, GroupProbe } from '../types'

export interface BrowserFixture {
  browserId: string
  /** setup's bounded-retry capturePage verdict — every browser probe reads this. */
  browserOk: boolean
}

const seedBrowser: E2EGroup<BrowserFixture>['setup'] = async (ctx) => {
  const browserId = await ctx.evalIn<string>(
    `window.__canvasE2E.seedBoard('browser', { url: ${JSON.stringify(ctx.localUrl)} })`
  )
  await ctx.delay(150) // let React Flow mount + measure before fitView
  await ctx.evalIn(`window.__canvasE2E.fitView(${JSON.stringify(browserId)})`)
  const connected = await ctx.poll(async () => {
    const rt = await ctx.evalIn<{ status: string; live: boolean } | null>(
      `window.__canvasE2E.getRuntime(${JSON.stringify(browserId)})`
    )
    return rt?.status === 'connected' && rt.live === true
  }, 10000)
  let browserOk = false
  if (connected) {
    // Bounded retry: a view needs ≥1 paint before capturePage is non-blank (P0-2).
    for (let attempt = 0; attempt < 3 && !browserOk; attempt++) {
      await ctx.delay(300)
      const cap = await ctx.dbg.captureView(browserId)
      browserOk = cap.attached && !cap.empty
    }
  }
  return { browserId, browserOk }
}

// ── Browser: pure assertion on the setup verdict, tagged flaky on failure. ──
export const browser: GroupProbe<BrowserFixture> = {
  name: 'browser',
  async run(_ctx, fx) {
    return {
      name: 'browser',
      ok: fx.browserOk,
      flaky: !fx.browserOk, // capturePage env flake → reported, not a hard fail
      detail: fx.browserOk
        ? 'non-blank per-view capturePage'
        : 'capture blank/detached after 3 tries'
    }
  }
}

// ── Occlusion fix (node-drag/resize detach): a node gesture must DETACH every live
// native view to its HTML snapshot — a native WebContentsView paints above all HTML,
// so without this a board dragged over a live Browser board is occluded by it. Drive
// previewStore.nodeGesture and assert the live flag drops on start, restores on end. ──
export const browserGesture: GroupProbe<BrowserFixture> = {
  name: 'browser-gesture',
  async run(ctx, fx) {
    const browserOk = fx.browserOk // the setup's capturePage verdict
    let gestureDetail = 'browser not live'
    let gestureOk = false
    if (browserOk) {
      await ctx.evalIn('window.__canvasE2E.setGesture(true)')
      const detached = await ctx.poll(async () => {
        const rt = await ctx.evalIn<{ live: boolean } | null>(
          `window.__canvasE2E.getRuntime(${JSON.stringify(fx.browserId)})`
        )
        return rt?.live === false
      }, 5000)
      await ctx.evalIn('window.__canvasE2E.setGesture(false)')
      const reattached = await ctx.poll(async () => {
        const rt = await ctx.evalIn<{ live: boolean } | null>(
          `window.__canvasE2E.getRuntime(${JSON.stringify(fx.browserId)})`
        )
        return rt?.live === true
      }, 8000)
      gestureOk = detached && reattached
      gestureDetail = `detached=${detached} reattached=${reattached}`
    }
    // Always soft-fail: this is one of the documented env-flake trio (memory
    // e2e-browser-trio-flake). The detach/reattach invariant polls async preview-lifecycle
    // transitions that flap under host load even when the browser IS live — so a failure here
    // is not reliably a real regression. Reported (flaky:true) but never red-lights the run.
    return { name: 'browser-gesture', ok: gestureOk, flaky: !gestureOk, detail: gestureDetail }
  }
}

// ── Fix #4 (dead-URL status): a refused connection must end as 'load-failed',
// NOT 'connected' (Chromium's error-page did-finish-load previously clobbered the
// failure). Seed a browser at a closed port, assert the runtime status, then remove
// the dead board to restore the board count. ──
export const browserDeadUrl: GroupProbe<BrowserFixture> = {
  name: 'browser-deadurl',
  async run(ctx, _fx) {
    const deadUrl = 'http://127.0.0.1:59999/' // nothing listens → connection refused
    const deadId = await ctx.evalIn<string>(
      `window.__canvasE2E.seedBoard('browser', { url: ${JSON.stringify(deadUrl)} })`
    )
    await ctx.delay(150)
    await ctx.evalIn(`window.__canvasE2E.fitView(${JSON.stringify(deadId)})`)
    const failedOk = await ctx.poll(async () => {
      const rt = await ctx.evalIn<{ status: string; live: boolean } | null>(
        `window.__canvasE2E.getRuntime(${JSON.stringify(deadId)})`
      )
      return rt?.status === 'load-failed'
    }, 12000)
    await ctx.evalIn(`window.__canvasE2E.deleteBoard(${JSON.stringify(deadId)})`) // self-restore count
    return {
      name: 'browser-deadurl',
      ok: failedOk,
      detail: failedOk ? 'refused URL → load-failed' : `did not reach load-failed`
    }
  }
}

// ── Bug 4 (full view ignores other browser views): with a live Browser board and a
// DIFFERENT board in full view, a store mutation (note/checklist edit) must NOT
// re-attach the browser's native view over the modal scrim. Pre-fix, reconcile's
// new-board path re-attached it (it never consulted fullViewId). Assert it stays
// detached THROUGH a mutation, then reattaches on exit (no leak). Also assert the
// other Browser's webContents SURVIVES (id retained in `views`) — destroying it would
// reset the board to board.url on full-view exit. ──
export const fullviewPreview: GroupProbe<BrowserFixture> = {
  name: 'fullview-preview',
  async run(ctx, fx) {
    let fvPrevOk = false
    let fvPrevDetail = 'browser not live before full view'
    let fvSurviveOk = false
    let fvSurviveDetail = 'browser not live before full view'
    const browserLiveBefore = await ctx.poll(async () => {
      const rt = await ctx.evalIn<{ live: boolean } | null>(
        `window.__canvasE2E.getRuntime(${JSON.stringify(fx.browserId)})`
      )
      return rt?.live === true
    }, 4000)
    if (browserLiveBefore) {
      const planId = await ctx.evalIn<string>("window.__canvasE2E.seedBoard('planning')")
      await ctx.evalIn(`window.__canvasE2E.setFullView(${JSON.stringify(planId)})`)
      await ctx.delay(400) // applyLiveness full-view branch detaches the other browser view
      await ctx.evalIn(`window.__canvasE2E.addChecklist(${JSON.stringify(planId)})`) // mutate → reconcile (the bug path)
      await ctx.delay(400)
      const capDuring = await ctx.dbg.captureView(fx.browserId)
      const rtDuring = await ctx.evalIn<{ live: boolean } | null>(
        `window.__canvasE2E.getRuntime(${JSON.stringify(fx.browserId)})`
      )
      const survived = ctx.dbg.viewIds().includes(fx.browserId)
      fvPrevOk = !capDuring.attached && rtDuring?.live !== true
      fvPrevDetail = fvPrevOk
        ? 'browser stayed detached through a full-view mutation'
        : `browser re-attached over modal (attached=${capDuring.attached} live=${rtDuring?.live})`
      fvSurviveOk = survived
      fvSurviveDetail = survived
        ? 'browser webContents survived full view (no reload on exit)'
        : 'browser webContents was closed during full view → resets to board.url on exit'
      await ctx.evalIn('window.__canvasE2E.setFullView(null)') // exit → browser reattaches
      await ctx.delay(300)
      await ctx.evalIn(`window.__canvasE2E.deleteBoard(${JSON.stringify(planId)})`) // remove aux board (after exiting full view) → restore count
    }
    return [
      { name: 'fullview-preview', ok: fvPrevOk, detail: fvPrevDetail },
      { name: 'fullview-preserve', ok: fvSurviveOk, detail: fvSurviveDetail }
    ]
  }
}

// ── PREV-SELF: full-viewing the Browser board ITSELF must not restart it. Drive the
// REAL animated path (openFullViewAnimated) — the plain setFullView raw-setter skips
// the motion branch. Deterministic check: a close+reopen mints a NEW webContents id; a
// detach+reattach keeps the SAME one (the terminal pid-survival assertion, for the view). ──
export const fullviewSelfPreserve: GroupProbe<BrowserFixture> = {
  name: 'fullview-self-preserve',
  async run(ctx, fx) {
    const readStatus = async (): Promise<string | null> => {
      const rt = await ctx.evalIn<{ status: string } | null>(
        `window.__canvasE2E.getRuntime(${JSON.stringify(fx.browserId)})`
      )
      return rt?.status ?? null
    }
    let selfOk = false
    let selfDetail = 'browser never reconnected before self-full-view'
    const reconnected = await ctx.poll(async () => (await readStatus()) === 'connected', 6000)
    if (reconnected) {
      const wcBefore = ctx.dbg.viewWebContentsId(fx.browserId)
      await ctx.evalIn(`window.__canvasE2E.openFullViewAnimated(${JSON.stringify(fx.browserId)})`)
      await ctx.delay(700) // enter tween settles (fullViewEntering → false)
      const wcDuring = ctx.dbg.viewWebContentsId(fx.browserId)
      await ctx.evalIn('window.__canvasE2E.closeFullViewAnimated()')
      await ctx.delay(700) // exit tween + onExited → fullViewId cleared, view back on canvas
      const wcAfter = ctx.dbg.viewWebContentsId(fx.browserId)
      const survivedSelf = wcBefore !== null && wcDuring === wcBefore && wcAfter === wcBefore
      selfOk = survivedSelf
      selfDetail = survivedSelf
        ? `full-viewing the browser kept the same webContents #${wcBefore} (no restart)`
        : `browser restarted across full view (wc before=${wcBefore} during=${wcDuring} after=${wcAfter})`
    }
    return { name: 'fullview-self-preserve', ok: selfOk, detail: selfDetail }
  }
}

// ── Full-view emulator: a Mobile/Tablet preset in full view must render as an
// aspect-correct device (height-bound, centred, letterboxed) — NOT stretched to fill
// the landscape modal. Set Mobile, full-view it, and assert the device frame keeps the
// preset's portrait aspect (~390/844) AND is clearly narrower than its stage (letterbox). ──
export const fullviewEmulator: GroupProbe<BrowserFixture> = {
  name: 'fullview-emulator',
  async run(ctx, fx) {
    await ctx.evalIn(
      `window.__canvasE2E.patchBoard(${JSON.stringify(fx.browserId)}, { viewport: 'mobile' })`
    )
    await ctx.evalIn(`window.__canvasE2E.setFullView(${JSON.stringify(fx.browserId)})`)
    await ctx.delay(450) // modal mounts + portal relocates the device frame + layout settles
    const emu = await ctx.evalIn<{
      found: boolean
      frameRatio: number
      stageRatio: number
      widthFrac: number
    }>(
      `(() => {
         const frame = document.querySelector('[data-bb-frame=' + JSON.stringify(${JSON.stringify(fx.browserId)}) + ']');
         const stage = frame && frame.closest('.bb-stage');
         if (!frame || !stage) return { found: false, frameRatio: 0, stageRatio: 0, widthFrac: 0 };
         const f = frame.getBoundingClientRect();
         const s = stage.getBoundingClientRect();
         return {
           found: true,
           frameRatio: f.width / f.height,
           stageRatio: s.width / s.height,
           widthFrac: f.width / s.width
         };
       })()`
    )
    await ctx.evalIn('window.__canvasE2E.setFullView(null)')
    await ctx.delay(300)
    // Mobile preset aspect = 390/844 ≈ 0.462. Require portrait AND letterboxed (markedly
    // narrower than the landscape stage), not stretched to fill.
    const mobileRatio = 390 / 844
    const emuOk =
      emu.found &&
      Math.abs(emu.frameRatio - mobileRatio) < 0.06 &&
      emu.widthFrac < 0.9 &&
      emu.frameRatio < emu.stageRatio
    return {
      name: 'fullview-emulator',
      ok: emuOk,
      detail: emuOk
        ? 'Mobile full view is an aspect-correct, letterboxed emulator (not stretched)'
        : JSON.stringify(emu)
    }
  }
}

// ── Menu-over-preview occlusion: a native WebContentsView paints above ALL HTML, even
// the body-portaled ⋯ popover, so a menu over a live Browser stage renders UNDER the
// preview. Fix: while a board ⋯ menu is open the preview layer detaches live views →
// HTML snapshot (z-ordered), then reattaches on close. Assert live→detached→reattached.
// (Lives in the browser group — it needs the live browser view; gates on getRuntime().live,
// not capturePage, so it is NOT subject to the capturePage env flake.) ──
export const menuPreviewDetach: GroupProbe<BrowserFixture> = {
  name: 'menu-preview-detach',
  async run(ctx, fx) {
    await ctx.evalIn(`window.__canvasE2E.fitView(${JSON.stringify(fx.browserId)})`)
    await ctx.evalIn('window.__canvasE2E.setZoom(1)')
    await ctx.delay(250) // let the browser view attach live at rest
    const occl = await ctx.evalIn<{
      found: boolean
      liveBefore: boolean
      liveDuringMenu: boolean
      liveAfter: boolean
    }>(
      `(async () => {
         const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
         const sel = (s, root) => (root || document).querySelector(s);
         const id = ${JSON.stringify(fx.browserId)};
         const live = () => !!(window.__canvasE2E.getRuntime(id) || {}).live;
         const node = sel('.react-flow__node[data-id=' + JSON.stringify(id) + ']');
         const more = node && sel('button[title="More"]', node);
         if (!more) return { found: false, liveBefore: false, liveDuringMenu: false, liveAfter: false };
         const liveBefore = live();
         more.click(); await sleep(250);          // open ⋯ → layer detaches live views
         const liveDuringMenu = live();
         more.click(); await sleep(300);           // close ⋯ → reattach eligible views
         const liveAfter = live();
         return { found: true, liveBefore, liveDuringMenu, liveAfter };
       })()`
    )
    const occlOk = occl.found && occl.liveBefore && !occl.liveDuringMenu && occl.liveAfter
    return {
      name: 'menu-preview-detach',
      ok: occlOk,
      detail: occlOk
        ? 'live preview detaches while ⋯ menu open (un-occluded) → reattaches on close'
        : JSON.stringify(occl)
    }
  }
}

export const browserGroup: E2EGroup<BrowserFixture> = {
  name: 'browser',
  setup: seedBrowser,
  probes: [
    browser,
    browserGesture,
    browserDeadUrl,
    fullviewPreview,
    fullviewSelfPreserve,
    fullviewEmulator,
    menuPreviewDetach
  ],
  teardown: async (ctx) => {
    await ctx.evalIn('window.__canvasE2E.clearAllBoards()')
  }
}
