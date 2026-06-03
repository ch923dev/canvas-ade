/**
 * Board ⋯-menu probes: the popover portals to <body> (not clipped by the frame's
 * overflow:hidden) and Duplicate/Delete fire through a real pointerdown→click; the ⋯
 * trigger stays within the title bar and clamps on-screen near the window edge and reads
 * at rest; and an open menu detaches live previews so the always-above native layer
 * doesn't paint over the popover.
 */
import type { E2EProbe } from '../types'

// ── Bugs 13/14 (board ⋯ menu chrome). Narrow the terminal so its title-bar action
// cluster would overflow the frame, then assert the ⋯ trigger stays WITHIN the title
// bar's right edge (13). Then pan the trigger PAST the window's right edge and open the
// menu: the popover must clamp back inside the viewport (14). ──
export const menuChrome: E2EProbe = {
  name: 'menu-chrome',
  async run(ctx) {
    const termId = ctx.ids.termId!
    await ctx.evalIn(`window.__canvasE2E.patchBoard(${JSON.stringify(termId)}, { w: 150 })`)
    await ctx.evalIn(`window.__canvasE2E.fitView(${JSON.stringify(termId)})`)
    await ctx.evalIn('window.__canvasE2E.setZoom(1)')
    await ctx.delay(150)
    // SLIVER (T3): only the REAL-LAYOUT assertions remain. The item list and the ⋯
    // stroke-width migrated to BoardMenu.integration.test.tsx; what's left needs a real
    // instance — title-bar containment + viewport clamp (jsdom rects are 0) and the rest
    // colour (a CSS-var computed style jsdom does not resolve).
    const chrome = await ctx.evalIn<{
      found: boolean
      triggerInBar: boolean
      restColor: string
      inViewport: boolean
    }>(
      `(async () => {
         const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
         const sel = (s, root) => (root || document).querySelector(s);
         const node = sel('.react-flow__node[data-id=' + JSON.stringify(${JSON.stringify(termId)}) + ']');
         const bar = node && sel('.board-titlebar', node);
         const more = node && sel('button[title="More"]', node);
         if (!bar || !more) return { found: false, triggerInBar: false, restColor: '', inViewport: false };
         const b = bar.getBoundingClientRect();
         const t = more.getBoundingClientRect();
         const triggerInBar = t.width > 0 && t.left >= b.left - 0.5 && t.right <= b.right + 0.5;
         const svg = more.querySelector('svg');
         const restColor = svg ? getComputedStyle(svg).color : '';
         const overshoot = (window.innerWidth - t.right) + 40;
         window.__canvasE2E.panBy(overshoot, 0);
         await sleep(80);
         const more2 = sel('button[title="More"]', node);
         more2.click(); await sleep(80);
         const menu = sel('.board-menu');
         const m = menu && menu.getBoundingClientRect();
         const inViewport = !!m && m.left >= 0 && m.top >= 0 && m.right <= window.innerWidth && m.bottom <= window.innerHeight;
         more2.click(); await sleep(40);            // close the menu
         window.__canvasE2E.panBy(-overshoot, 0);   // restore the camera
         return { found: true, triggerInBar, restColor, inViewport };
       })()`
    )
    const restVisible = chrome.restColor === 'rgb(155, 155, 161)'
    const chromeOk = chrome.found && chrome.triggerInBar && chrome.inViewport && restVisible
    return {
      name: 'menu-chrome',
      ok: chromeOk,
      detail: chromeOk
        ? '⋯ within bar (13) + on-screen near edge (14) + visible at rest (text-2)'
        : JSON.stringify(chrome)
    }
  }
}

// ── Menu-over-preview occlusion: a native WebContentsView paints above ALL HTML, even
// the body-portaled ⋯ popover, so a menu over a live Browser stage renders UNDER the
// preview. Fix: while a board ⋯ menu is open the preview layer detaches live views →
// HTML snapshot (z-ordered), then reattaches on close. Assert live→detached→reattached. ──
export const menuPreviewDetach: E2EProbe = {
  name: 'menu-preview-detach',
  async run(ctx) {
    const browserId = ctx.ids.browserId!
    await ctx.evalIn(`window.__canvasE2E.fitView(${JSON.stringify(browserId)})`)
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
         const id = ${JSON.stringify(browserId)};
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
