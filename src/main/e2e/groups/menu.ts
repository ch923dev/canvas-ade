/**
 * Board ⋯-menu fixture group: a terminal + a planning board. Asserts the popover portals
 * to <body> and Duplicate/Delete fire through REAL OS clicks (was synthetic pointerdown),
 * and the ⋯ trigger stays within the title bar + clamps on-screen near the window edge.
 */
import type { E2EGroup, GroupProbe } from '../types'

export interface MenuFixture {
  termId: string
  planId: string
}

const seedMenu: E2EGroup<MenuFixture>['setup'] = async (ctx) => {
  const termId = await ctx.evalIn<string>("window.__canvasE2E.seedBoard('terminal')")
  const planId = await ctx.evalIn<string>("window.__canvasE2E.seedBoard('planning')")
  return { termId, planId }
}

export const boardMenu: GroupProbe<MenuFixture> = {
  name: 'board-menu',
  async run(ctx, fx) {
    await ctx.evalIn(`window.__canvasE2E.fitView(${JSON.stringify(fx.planId)})`)
    await ctx.evalIn('window.__canvasE2E.setZoom(1)')
    await ctx.delay(150)
    const base = await ctx.evalIn<number>('window.__canvasE2E.getBoards().length')

    // Open the planning board's ⋯ menu (opening is not transform-sensitive at zoom 1).
    const portaled = await ctx.evalIn<boolean>(
      `(async () => {
         const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
         const node = document.querySelector('.react-flow__node[data-id=' + JSON.stringify(${JSON.stringify(fx.planId)}) + ']');
         const more = node && node.querySelector('button[title="More"]');
         if (!more) return false;
         more.click(); await sleep(80);
         const menu = document.querySelector('.board-menu');
         return !!menu && menu.parentElement === document.body && !document.querySelector('.bb-frame .board-menu');
       })()`
    )
    // Real-click Duplicate (a body-portaled item — resolve by text, click its center via OS input).
    await realClickMenuItem(ctx, 'Duplicate')
    await ctx.delay(150)
    const afterDup = await ctx.evalIn<number>('window.__canvasE2E.getBoards().length')

    // Open the clone's ⋯ menu and real-click Delete.
    await ctx.evalIn(
      `(async () => {
         const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
         const boards = window.__canvasE2E.getBoards();
         const dupId = boards.slice(-1)[0] && boards.slice(-1)[0].id;
         const dupNode = dupId && document.querySelector('.react-flow__node[data-id=' + JSON.stringify(dupId) + ']');
         const more = dupNode && dupNode.querySelector('button[title="More"]');
         if (more) { more.click(); await sleep(80); }
       })()`
    )
    await realClickMenuItem(ctx, 'Delete')
    await ctx.delay(150)
    const afterDel = await ctx.evalIn<number>('window.__canvasE2E.getBoards().length')

    const ok = portaled && afterDup === base + 1 && afterDel === base
    return {
      name: 'board-menu',
      ok,
      detail: ok
        ? 'portaled to body + real-click Duplicate/Delete fire'
        : JSON.stringify({ portaled, base, afterDup, afterDel })
    }
  }
}

/** Real OS click on a body-portaled .board-menu-item matched by trimmed text. */
async function realClickMenuItem(ctx: import('../context').E2ECtx, label: string): Promise<boolean> {
  const at = await ctx.evalIn<{ x: number; y: number } | null>(
    `(() => {
       const item = [...document.querySelectorAll('.board-menu .board-menu-item')]
         .find((b) => b.textContent.trim() === ${JSON.stringify(label)});
       if (!item) return null;
       const r = item.getBoundingClientRect();
       return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
     })()`
  )
  if (!at) return false
  await ctx.ensureFocus() // sendInputEvent only delivers to a focused window
  ctx.win.webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(at.x), y: Math.round(at.y), button: 'left', clickCount: 1 })
  ctx.win.webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(at.x), y: Math.round(at.y), button: 'left', clickCount: 1 })
  return true
}

// ── Bugs 13/14 (board ⋯ menu chrome). Narrow the terminal so its title-bar action
// cluster would overflow the frame, then assert the ⋯ trigger stays WITHIN the title
// bar's right edge (13). Then pan the trigger PAST the window's right edge and open the
// menu: the popover must clamp back inside the viewport (14). ──
export const menuChrome: GroupProbe<MenuFixture> = {
  name: 'menu-chrome',
  async run(ctx, fx) {
    const termId = fx.termId
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

export const menuGroup: E2EGroup<MenuFixture> = {
  name: 'menu',
  setup: seedMenu,
  probes: [boardMenu, menuChrome],
  teardown: async (ctx) => {
    await ctx.evalIn('window.__canvasE2E.clearAllBoards()')
  }
}
