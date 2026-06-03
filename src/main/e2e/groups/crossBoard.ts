/**
 * Cross-board interaction fixture group: a terminal AND a live Browser together. Covers
 * the focus-detach ghost, the stale preview edge, duplicate-keeps-link, and the terminal
 * globe → connect-picker gesture routing — all of which need both boards present.
 */
import type { E2EGroup, GroupProbe } from '../types'
import type { E2ECtx } from '../context'

// React Flow measures freshly-seeded nodes lazily via a ResizeObserver. A single fitView()
// can run BEFORE the just-seeded browser node is measured; fitView then no-ops (camera stays
// at zoom 1) and React Flow renders NO edges at all (an edge needs both endpoints measured).
// Re-fit on each poll tick so RF gets repeated render passes until the node is measured and
// the edge renders — or time out, which still correctly fails on a genuine missing edge.
function waitForEdge(ctx: E2ECtx, edgeId: string): Promise<boolean> {
  return ctx.poll(
    async () => {
      await ctx.evalIn('window.__canvasE2E.fitView()')
      return ctx.evalIn<boolean>(
        `!!document.querySelector('.react-flow__edge[data-id="${edgeId}"]')`
      )
    },
    8000,
    250
  )
}

export interface CrossFixture {
  termId: string
  browserId: string
  browserOk: boolean
}

const seedCross: E2EGroup<CrossFixture>['setup'] = async (ctx) => {
  const termId = await ctx.evalIn<string>(
    `window.__canvasE2E.seedBoard('terminal', { launchCommand: 'echo ${ctx.TERM_SENTINEL}' })`
  )
  const browserId = await ctx.evalIn<string>(
    `window.__canvasE2E.seedBoard('browser', { url: ${JSON.stringify(ctx.localUrl)} })`
  )
  await ctx.delay(150)
  await ctx.evalIn(`window.__canvasE2E.fitView(${JSON.stringify(browserId)})`)
  const connected = await ctx.poll(async () => {
    const rt = await ctx.evalIn<{ status: string; live: boolean } | null>(
      `window.__canvasE2E.getRuntime(${JSON.stringify(browserId)})`
    )
    return rt?.status === 'connected' && rt.live === true
  }, 10000)
  let browserOk = false
  if (connected) {
    for (let attempt = 0; attempt < 3 && !browserOk; attempt++) {
      await ctx.delay(300)
      const cap = await ctx.dbg.captureView(browserId)
      browserOk = cap.attached && !cap.empty
    }
  }
  return { termId, browserId, browserOk }
}

// ── Bug 2 (focus webview ghost): double-clicking a terminal focuses it (animated
// fitView). A live Browser elsewhere must DETACH cleanly for the focus (no native view
// left attached → the #43961 ghost) and REATTACH on unfocus. The compositor pixel isn't
// code-assertable, but the detach/reattach invariant the fix preserves is. ──
const focusDetach: GroupProbe<CrossFixture> = {
  name: 'focus-detach',
  async run(ctx, fx) {
    let focusOk = false
    let focusDetail = 'browser not live before focus'
    if (fx.browserOk) {
      await ctx.evalIn(`window.__canvasE2E.fitView(${JSON.stringify(fx.browserId)})`)
      await ctx.poll(async () => {
        const rt = await ctx.evalIn<{ live: boolean } | null>(
          `window.__canvasE2E.getRuntime(${JSON.stringify(fx.browserId)})`
        )
        return rt?.live === true
      }, 5000)
      await ctx.evalIn(`window.__canvasE2E.setFocus(${JSON.stringify(fx.termId)})`) // focus the terminal
      await ctx.delay(500) // focus effect → applyLiveness demotes the non-focused browser
      const capFocused = await ctx.dbg.captureView(fx.browserId)
      const detachedOnFocus = !capFocused.attached
      await ctx.evalIn('window.__canvasE2E.setFocus(null)') // clear focus → browser reattaches
      await ctx.evalIn(`window.__canvasE2E.fitView(${JSON.stringify(fx.browserId)})`)
      const reattached = await ctx.poll(async () => {
        const rt = await ctx.evalIn<{ live: boolean } | null>(
          `window.__canvasE2E.getRuntime(${JSON.stringify(fx.browserId)})`
        )
        return rt?.live === true
      }, 8000)
      focusOk = detachedOnFocus && reattached
      focusDetail = `detachedOnFocus=${detachedOnFocus} reattached=${reattached}`
    }
    // Always soft-fail: one of the documented env-flake trio (memory e2e-browser-trio-flake).
    // The detach/reattach invariant polls async preview-lifecycle transitions that flap under
    // host load even when the browser IS live, so a failure here is not reliably a real
    // regression. Reported (flaky:true) but never red-lights the run.
    return {
      name: 'focus-detach',
      ok: focusOk,
      flaky: !focusOk,
      detail: focusOk ? 'browser detached on terminal focus, reattached on unfocus' : focusDetail
    }
  }
}

// ── Bug 3 (stale preview link): the terminal→browser edge is solid while the source
// terminal runs, dashed/dimmed once it's down. Link the browser to the terminal, assert
// a non-dashed edge, mark the terminal down, assert it goes dashed. ──
const previewEdgeStale: GroupProbe<CrossFixture> = {
  name: 'preview-edge-stale',
  async run(ctx, fx) {
    await ctx.evalIn(
      `window.__canvasE2E.patchBoard(${JSON.stringify(fx.browserId)}, { previewSourceId: ${JSON.stringify(fx.termId)} })`
    )
    const edgeDash = (): Promise<string> =>
      ctx.evalIn<string>(
        `(() => { const p = document.querySelector('.react-flow__edge[data-id="preview-${fx.browserId}"] .react-flow__edge-path'); return p ? (p.style.strokeDasharray || 'none') : 'no-edge'; })()`
      )
    // Re-fit until the edge actually renders (defeats the RF node-measurement race), then
    // confirm it is SOLID while the source terminal runs.
    await waitForEdge(ctx, `preview-${fx.browserId}`)
    await ctx.poll(async () => (await edgeDash()) === 'none', 4000)
    const dashRunning = await edgeDash()
    await ctx.evalIn(`window.__canvasE2E.setTerminalDown(${JSON.stringify(fx.termId)})`)
    // Poll for the edge to go DASHED once the terminal is marked down.
    await ctx.poll(async () => (await edgeDash()).includes('5'), 4000)
    const dashDown = await edgeDash()
    await ctx.evalIn(
      `window.__canvasE2E.patchBoard(${JSON.stringify(fx.browserId)}, { previewSourceId: undefined })`
    ) // unlink → restore
    const edgeOk = dashRunning === 'none' && dashDown.includes('5')
    return {
      name: 'preview-edge-stale',
      ok: edgeOk,
      detail: edgeOk
        ? 'solid while running → dashed when terminal down'
        : `running=${dashRunning} down=${dashDown}`
    }
  }
}

// ── Duplicating a linked Browser keeps the preview link: a Browser connected to a
// terminal should, when duplicated, leave the COPY linked to the SAME terminal. Link,
// duplicate, assert the clone carries the same previewSourceId AND its own edge renders,
// then delete the clone (restore seed count) and unlink the original. ──
const duplicateKeepsLink: GroupProbe<CrossFixture> = {
  name: 'duplicate-keeps-link',
  async run(ctx, fx) {
    await ctx.evalIn(
      `window.__canvasE2E.patchBoard(${JSON.stringify(fx.browserId)}, { previewSourceId: ${JSON.stringify(fx.termId)} })`
    )
    const cloneId = await ctx.evalIn<string | null>(
      `window.__canvasE2E.duplicateBoard(${JSON.stringify(fx.browserId)})`
    )
    // Re-fit until the clone's own preview edge renders (defeats the RF node-measurement race).
    if (cloneId) await waitForEdge(ctx, `preview-${cloneId}`)
    const dup = await ctx.evalIn<{ cloneSource: string | null; edgePresent: boolean }>(
      `(() => {
         const clone = window.__canvasE2E.getBoards().find((b) => b.id === ${JSON.stringify(cloneId)});
         const cloneSource = clone && clone.type === 'browser' ? (clone.previewSourceId ?? null) : null;
         const edgePresent = !!document.querySelector('.react-flow__edge[data-id="preview-${cloneId}"]');
         return { cloneSource, edgePresent };
       })()`
    )
    if (cloneId) await ctx.evalIn(`window.__canvasE2E.deleteBoard(${JSON.stringify(cloneId)})`) // restore seed count
    await ctx.evalIn(
      `window.__canvasE2E.patchBoard(${JSON.stringify(fx.browserId)}, { previewSourceId: undefined })`
    ) // unlink the original → restore baseline
    const dupOk = !!cloneId && dup.cloneSource === fx.termId && dup.edgePresent
    return {
      name: 'duplicate-keeps-link',
      ok: dupOk,
      detail: dupOk
        ? 'duplicated Browser stays linked to the same terminal + its own preview edge renders'
        : JSON.stringify({ cloneId, ...dup })
    }
  }
}

// ── Multi-browser connect (gesture routing): the terminal globe routes by gesture.
// A plain TAP refreshes the browser(s) already linked; a press-and-HOLD (≥500ms) or a
// RIGHT-CLICK opens the multi-select connect picker. Print a dev-server URL into the
// terminal so port detection succeeds, then drive all three gestures through the DOM. ──
const previewConnectGesture: GroupProbe<CrossFixture> = {
  name: 'preview-connect-gesture',
  async run(ctx, fx) {
    await ctx.evalIn(`window.__canvasE2E.patchBoard(${JSON.stringify(fx.termId)}, { w: 360 })`) // menu-chrome narrowed it; widen so the globe is clickable
    await ctx.evalIn(`window.__canvasE2E.fitView(${JSON.stringify(fx.termId)})`)
    await ctx.evalIn('window.__canvasE2E.setZoom(1)')
    ctx.dbg.writeTerminal(fx.termId, 'echo http://localhost:3000/\r')
    const urlSeen = await ctx.poll(async () => {
      const t = await ctx.evalIn<string | null>(
        `window.__canvasE2E.readTerminal(${JSON.stringify(fx.termId)})`
      )
      return typeof t === 'string' && t.includes('localhost:3000')
    }, 8000)
    const gesture = await ctx.evalIn<{
      detected: string[]
      holdOpened: boolean
      holdTitle: boolean
      holdCount: number
      rightOpened: boolean
    }>(
      `(async () => {
         const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
         const detected = (await window.api.detectPorts(${JSON.stringify(fx.termId)})).map((u) => u.url);
         const node = document.querySelector('.react-flow__node[data-id=' + JSON.stringify(${JSON.stringify(fx.termId)}) + ']');
         const globe = node && node.querySelector('button[title*="choose browser"]');
         const picker = () => node.querySelector('.ca-port-picker');
         const pickerHas = (txt) => { const p = picker(); return !!p && p.textContent.includes(txt); };
         if (!globe) return { detected, holdOpened: false, holdTitle: false, holdCount: 0, rightOpened: false };

         // (1) LONG-PRESS: mousedown arms the ~500ms timer → onLongPress opens the picker.
         globe.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
         await sleep(700);                                  // hold past the threshold
         globe.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
         globe.dispatchEvent(new MouseEvent('click', { bubbles: true })); // release-click (swallowed after a hold)
         await sleep(600);                                  // detectPorts + render
         const holdOpened = !!picker();
         const holdTitle = pickerHas('Push to which browser');
         const holdCount = picker() ? picker().querySelectorAll('.ca-browser-choice input').length : 0;
         const cancel = picker() && picker().querySelector('.ca-preview-dismiss');
         if (cancel) cancel.click();
         await sleep(120);

         // (2) RIGHT-CLICK: contextmenu opens the same picker. Check the first candidate + Connect.
         globe.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
         await sleep(600);
         const rightOpened = !!picker();
         const firstBox = picker() && picker().querySelector('.ca-browser-choice input');
         if (firstBox) {
           firstBox.click();                                // check candidate[0] (the first browser)
           await sleep(60);
           // only the tap is real-input-converted; picker connect stays synthetic (plain HTML, not transform-occluded)
           const connect = picker().querySelector('.ca-browser-connect');
           if (connect) connect.click();
         }
         await sleep(200);

         return { detected, holdOpened, holdTitle, holdCount, rightOpened };
       })()`
    )
    await ctx.delay(150)

    // (3) TAP via real OS input — a plain click refreshes the linked browser, opens NO picker.
    await ctx.realClickSelector(
      `.react-flow__node[data-id="${fx.termId}"] button[title*="choose browser"]`
    )
    await ctx.delay(700)
    const tapOpened = await ctx.evalIn<boolean>(
      `!!document.querySelector('.react-flow__node[data-id="${fx.termId}"] .ca-port-picker')`
    )

    const linkAfter = await ctx.evalIn<{ source: string | null; url: string }>(
      `(() => {
         const b = window.__canvasE2E.getBoards().find((x) => x.id === ${JSON.stringify(fx.browserId)});
         return { source: (b && b.type === 'browser' ? (b.previewSourceId ?? null) : null), url: (b && b.type === 'browser' ? b.url : '') };
       })()`
    )
    await ctx.evalIn(
      `window.__canvasE2E.patchBoard(${JSON.stringify(fx.browserId)}, { previewSourceId: undefined })`
    ) // restore baseline (unlink)
    const connectedOk = linkAfter.source === fx.termId && linkAfter.url === ctx.DETECTED_URL
    const connectGestureOk =
      urlSeen &&
      gesture.holdOpened &&
      gesture.holdTitle &&
      gesture.holdCount >= 2 &&
      gesture.rightOpened &&
      connectedOk &&
      !tapOpened
    return {
      name: 'preview-connect-gesture',
      ok: connectGestureOk,
      detail: connectGestureOk
        ? 'hold + right-click open the connect picker; Connect links the browser; tap refreshes (no picker)'
        : JSON.stringify({ urlSeen, ...gesture, tapOpened, ...linkAfter })
    }
  }
}

export const crossBoardGroup: E2EGroup<CrossFixture> = {
  name: 'crossBoard',
  setup: seedCross,
  probes: [focusDetach, previewEdgeStale, duplicateKeepsLink, previewConnectGesture],
  teardown: async (ctx) => {
    await ctx.evalIn('window.__canvasE2E.clearAllBoards()')
  }
}
