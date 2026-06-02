/**
 * Board ⋯-menu probes: the popover portals to <body> (not clipped by the frame's
 * overflow:hidden) and Duplicate/Delete fire through a real pointerdown→click; the ⋯
 * trigger stays within the title bar and clamps on-screen near the window edge and reads
 * at rest; and an open menu detaches live previews so the always-above native layer
 * doesn't paint over the popover.
 */
import type { E2EProbe } from '../types'

// ── Bugs 8/9 + 11/12 (board ⋯ menu): drive the REAL menu through the DOM. Open the
// planning board's menu, Duplicate (count +1) then Delete the clone (count back). ──
export const boardMenu: E2EProbe = {
  name: 'board-menu',
  async run(ctx) {
    const planId = ctx.ids.planId!
    await ctx.evalIn(`window.__canvasE2E.fitView(${JSON.stringify(planId)})`)
    await ctx.evalIn('window.__canvasE2E.setZoom(1)')
    await ctx.delay(150)
    const menuProbe = await ctx.evalIn<{
      portaled: boolean
      base: number
      afterDup: number
      afterDel: number
    }>(
      `(async () => {
         const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
         const sel = (s, root) => (root || document).querySelector(s);
         const base = window.__canvasE2E.getBoards().length;
         const node = sel('.react-flow__node[data-id=' + JSON.stringify(${JSON.stringify(planId)}) + ']');
         const more = node && sel('button[title="More"]', node);
         if (!more) return { portaled: false, base, afterDup: -1, afterDel: -1 };
         more.click(); await sleep(80);
         const menu = sel('.board-menu');
         const portaled = !!menu && menu.parentElement === document.body && !sel('.bb-frame .board-menu');
         const dup = menu && [...menu.querySelectorAll('.board-menu-item')].find((b) => b.textContent.trim() === 'Duplicate');
         if (dup) { dup.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); dup.click(); }
         await sleep(150);
         const afterDup = window.__canvasE2E.getBoards().length;
         const dupId = window.__canvasE2E.getBoards().slice(-1)[0] && window.__canvasE2E.getBoards().slice(-1)[0].id;
         const dupNode = dupId && sel('.react-flow__node[data-id=' + JSON.stringify(dupId) + ']');
         const more2 = dupNode && sel('button[title="More"]', dupNode);
         if (more2) {
           more2.click(); await sleep(80);
           const menu2 = sel('.board-menu');
           const del = menu2 && [...menu2.querySelectorAll('.board-menu-item')].find((b) => b.textContent.trim() === 'Delete');
           if (del) { del.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); del.click(); }
         }
         await sleep(150);
         const afterDel = window.__canvasE2E.getBoards().length;
         return { portaled, base, afterDup, afterDel };
       })()`
    )
    const menuOk =
      menuProbe.portaled &&
      menuProbe.afterDup === menuProbe.base + 1 &&
      menuProbe.afterDel === menuProbe.base
    return {
      name: 'board-menu',
      ok: menuOk,
      detail: menuOk ? 'portaled to body + Duplicate/Delete fire' : JSON.stringify(menuProbe)
    }
  }
}

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
    const chrome = await ctx.evalIn<{
      found: boolean
      triggerInBar: boolean
      restColor: string
      strokeWidth: string
      inViewport: boolean
      items: string[]
    }>(
      `(async () => {
         const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
         const sel = (s, root) => (root || document).querySelector(s);
         const node = sel('.react-flow__node[data-id=' + JSON.stringify(${JSON.stringify(termId)}) + ']');
         const bar = node && sel('.board-titlebar', node);
         const more = node && sel('button[title="More"]', node);
         if (!bar || !more) return { found: false, triggerInBar: false, restColor: '', strokeWidth: '', inViewport: false, items: [] };
         const b = bar.getBoundingClientRect();
         const t = more.getBoundingClientRect();
         const triggerInBar = t.width > 0 && t.left >= b.left - 0.5 && t.right <= b.right + 0.5;
         const svg = more.querySelector('svg');
         const restColor = svg ? getComputedStyle(svg).color : '';
         const strokeWidth = svg ? (svg.getAttribute('stroke-width') || '') : '';
         const overshoot = (window.innerWidth - t.right) + 40;
         window.__canvasE2E.panBy(overshoot, 0);
         await sleep(80);
         const more2 = sel('button[title="More"]', node);
         more2.click(); await sleep(80);
         const menu = sel('.board-menu');
         const m = menu && menu.getBoundingClientRect();
         const items = menu ? [...menu.querySelectorAll('.board-menu-item')].map((x) => x.textContent.trim()) : [];
         const inViewport = !!m && m.left >= 0 && m.top >= 0 && m.right <= window.innerWidth && m.bottom <= window.innerHeight;
         more2.click(); await sleep(40);            // close the menu
         window.__canvasE2E.panBy(-overshoot, 0);   // restore the camera
         return { found: true, triggerInBar, restColor, strokeWidth, inViewport, items };
       })()`
    )
    const wantItems = ['Full view', 'Duplicate', 'Delete']
    const restVisible =
      chrome.restColor === 'rgb(155, 155, 161)' && parseFloat(chrome.strokeWidth) >= 2
    const chromeOk =
      chrome.found &&
      chrome.triggerInBar &&
      chrome.inViewport &&
      restVisible &&
      wantItems.every((l) => chrome.items.includes(l))
    return {
      name: 'menu-chrome',
      ok: chromeOk,
      detail: chromeOk
        ? '⋯ within bar (13) + on-screen near edge (14) + visible at rest (text-2, sw≥2)'
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
