/**
 * Terminal→Browser preview-link SLIVER (post-T3): the terminal globe routes by gesture —
 * tap refreshes, hold / right-click open the multi-select connect picker. This needs a
 * REAL instance (live port-detection IPC + a long-press timer + the actual dev-server URL
 * echoed into a node-pty terminal), so it stays in the harness. The edge-stale styling
 * migrated to PreviewEdge.test.tsx and duplicate-keeps-link to canvasStore.test.ts (T3).
 *
 * Order-bound: widens the terminal back to w:360 (menu-chrome narrowed it to w:150), so the
 * final `seed` probe sees the board count/size restored.
 */
import type { E2EProbe } from '../types'

// ── Multi-browser connect (gesture routing): the terminal globe routes by gesture.
// A plain TAP refreshes the browser(s) already linked; a press-and-HOLD (≥500ms) or a
// RIGHT-CLICK opens the multi-select connect picker. Print a dev-server URL into the
// terminal so port detection succeeds, then drive all three gestures through the DOM. ──
export const previewConnectGesture: E2EProbe = {
  name: 'preview-connect-gesture',
  async run(ctx) {
    const termId = ctx.ids.termId!
    const browserId = ctx.ids.browserId!
    await ctx.evalIn(`window.__canvasE2E.patchBoard(${JSON.stringify(termId)}, { w: 360 })`) // menu-chrome narrowed it; widen so the globe is clickable
    await ctx.evalIn(`window.__canvasE2E.fitView(${JSON.stringify(termId)})`)
    await ctx.evalIn('window.__canvasE2E.setZoom(1)')
    ctx.dbg.writeTerminal(termId, 'echo http://localhost:3000/\r')
    const urlSeen = await ctx.poll(async () => {
      const t = await ctx.evalIn<string | null>(
        `window.__canvasE2E.readTerminal(${JSON.stringify(termId)})`
      )
      return typeof t === 'string' && t.includes('localhost:3000')
    }, 8000)
    const gesture = await ctx.evalIn<{
      detected: string[]
      holdOpened: boolean
      holdTitle: boolean
      holdCount: number
      rightOpened: boolean
      tapOpened: boolean
    }>(
      `(async () => {
         const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
         const detected = (await window.api.detectPorts(${JSON.stringify(termId)})).map((u) => u.url);
         const node = document.querySelector('.react-flow__node[data-id=' + JSON.stringify(${JSON.stringify(termId)}) + ']');
         const globe = node && node.querySelector('button[title*="choose browser"]');
         const picker = () => node.querySelector('.ca-port-picker');
         const pickerHas = (txt) => { const p = picker(); return !!p && p.textContent.includes(txt); };
         if (!globe) return { detected, holdOpened: false, holdTitle: false, holdCount: 0, rightOpened: false, tapOpened: false };

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
           const connect = picker().querySelector('.ca-browser-connect');
           if (connect) connect.click();
         }
         await sleep(200);

         // (3) TAP: a plain click now refreshes the just-linked browser — NO picker opens.
         globe.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
         globe.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
         globe.dispatchEvent(new MouseEvent('click', { bubbles: true }));
         await sleep(700);
         const tapOpened = !!picker();
         return { detected, holdOpened, holdTitle, holdCount, rightOpened, tapOpened };
       })()`
    )
    await ctx.delay(150)
    const linkAfter = await ctx.evalIn<{ source: string | null; url: string }>(
      `(() => {
         const b = window.__canvasE2E.getBoards().find((x) => x.id === ${JSON.stringify(browserId)});
         return { source: (b && b.type === 'browser' ? (b.previewSourceId ?? null) : null), url: (b && b.type === 'browser' ? b.url : '') };
       })()`
    )
    await ctx.evalIn(
      `window.__canvasE2E.patchBoard(${JSON.stringify(browserId)}, { previewSourceId: undefined })`
    ) // restore baseline (unlink)
    const connectedOk = linkAfter.source === termId && linkAfter.url === ctx.DETECTED_URL
    const connectGestureOk =
      urlSeen &&
      gesture.holdOpened &&
      gesture.holdTitle &&
      gesture.holdCount >= 2 &&
      gesture.rightOpened &&
      connectedOk &&
      !gesture.tapOpened
    return {
      name: 'preview-connect-gesture',
      ok: connectGestureOk,
      detail: connectGestureOk
        ? 'hold + right-click open the connect picker; Connect links the browser; tap refreshes (no picker)'
        : JSON.stringify({ urlSeen, ...gesture, ...linkAfter })
    }
  }
}
