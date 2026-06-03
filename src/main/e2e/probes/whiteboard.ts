/**
 * Whiteboard (Planning) interaction probes — W1 (eraser + letter shortcuts) and
 * W2 (selection core: multi-select + snapping). Both drive the REAL DOM on the
 * planning board's `.pl-well` and assert EFFECTS via getBoards() (selection/tool are
 * ephemeral component state, never serialized) so the checks are deterministic.
 *
 * Order-bound: both read `ctx.ids.planId`, which the `planning` probe seeds earlier in
 * the playlist. They run late (after `tidy`/`tile`, before `seed`) — mutating only the
 * planning board's `elements`, never the board COUNT the final `seed` probe asserts.
 *
 * Lifted verbatim (W1 #16, W2 #19) out of the former monolithic e2eSmoke.ts when it was
 * split into this themed e2e/ folder (#24): `evalIn(win, …)` → `ctx.evalIn(…)`,
 * `delay(…)` → `ctx.delay(…)`, `parts.push(…)` → a returned E2EPart[].
 */
import { clipboard, nativeImage } from 'electron'
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  createProject,
  setCurrentDir,
  readProject,
  writeProject,
  collectAssetIds,
  gcAssets
} from '../../projectStore'
import type { E2EProbe, E2EPart } from '../types'

// ── W1.1 Eraser + W1.2 letter shortcuts (whiteboard slice 1). Drive the REAL DOM:
// seed a single note on the planning board, focus the well, press 'e' (the erase
// shortcut — proves W1.2 sets the tool), then "tap" the note's computed screen point.
// The erase pointer-down hit-tests the note → pointer-up commits its removal as ONE
// undo step (W1.1); undo must restore it. Then press 'n' and tap an empty spot — the
// note tool creates a fresh note, proving a second shortcut routes through. All
// assertions read element counts off the store (deterministic; no component-state peek).
export const whiteboardErase: E2EProbe = {
  name: 'whiteboard-erase',
  async run(ctx): Promise<E2EPart[]> {
    const planId = ctx.ids.planId
    if (!planId)
      return [{ name: 'whiteboard-erase', ok: false, detail: 'planId not seeded (planning probe)' }]

    await ctx.evalIn(
      `window.__canvasE2E.patchBoard(${JSON.stringify(planId)}, { elements: [{ id: 'e2e-erase-note', kind: 'note', x: 40, y: 40, w: 156, h: 96, tint: 'yellow', text: '', rotation: 0 }] })`
    )
    await ctx.evalIn(`window.__canvasE2E.fitView(${JSON.stringify(planId)})`)
    await ctx.delay(200) // node measured + well laid out + above LOD
    const wb = await ctx.evalIn<{
      start: number
      afterErase: number
      afterUndo: number
      afterCreate: number
    }>(
      `(async () => {
         const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
         const id = ${JSON.stringify(planId)};
         const elems = () => {
           const b = window.__canvasE2E.getBoards().find((x) => x.id === id);
           return b && b.type === 'planning' ? b.elements.length : -1;
         };
         const node = document.querySelector('.react-flow__node[data-id=' + JSON.stringify(id) + ']');
         const well = node && node.querySelector('.pl-well');
         if (!well) return { start: -1, afterErase: -1, afterUndo: -1, afterCreate: -1 };
         const r = well.getBoundingClientRect();
         const scale = well.offsetWidth > 0 ? r.width / well.offsetWidth : 1; // board-local → screen
         const at = (bx, by) => ({ x: r.left + bx * scale, y: r.top + by * scale });
         const press = (k) => { well.focus(); well.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })); };
         const tap = (p) => {
           for (const t of ['pointerdown', 'pointerup']) {
             try { well.dispatchEvent(new PointerEvent(t, { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, clientX: p.x, clientY: p.y })); } catch (e) {}
           }
         };
         const start = elems();
         // W1.2: 'e' selects the eraser. W1.1: tap the note (board-local centre 118,88) → removed.
         press('e'); await sleep(40);
         tap(at(118, 88)); await sleep(80);
         const afterErase = elems();
         window.__canvasE2E.undo(); await sleep(80);     // one undo step restores the swipe
         const afterUndo = elems();
         // W1.2: 'n' selects the note tool → a tap on an empty spot creates a note.
         press('n'); await sleep(40);
         tap(at(230, 210)); await sleep(80);
         const afterCreate = elems();
         return { start, afterErase, afterUndo, afterCreate };
       })()`
    )
    const eraseOk = wb.start === 1 && wb.afterErase === 0 && wb.afterUndo === 1
    const shortcutOk = wb.afterUndo === 1 && wb.afterCreate === 2
    return [
      {
        name: 'whiteboard-erase',
        ok: eraseOk,
        detail: eraseOk
          ? "'e' erases the note on tap; undo restores it in one step"
          : JSON.stringify(wb)
      },
      {
        name: 'whiteboard-shortcut',
        ok: shortcutOk,
        detail: shortcutOk ? "'n' selects the note tool → tap creates a note" : JSON.stringify(wb)
      }
    ]
  }
}

// ── W2 selection core (multi-select + snapping). Seed two notes, drive the REAL
// DOM on .pl-well, and assert the EFFECTS via getBoards() (selection is ephemeral
// component state). A marquee that selects both is proven by the group it then
// deletes / drags; snapping is proven by the committed coordinate.
export const whiteboardSelection: E2EProbe = {
  name: 'whiteboard-selection',
  async run(ctx): Promise<E2EPart[]> {
    const planId = ctx.ids.planId
    if (!planId)
      return [
        { name: 'whiteboard-group-delete', ok: false, detail: 'planId not seeded (planning probe)' }
      ]

    await ctx.evalIn(
      `window.__canvasE2E.patchBoard(${JSON.stringify(planId)}, { elements: [
         { id: 'w2-a', kind: 'note', x: 40, y: 40, w: 156, h: 96, tint: 'yellow', text: 'A', rotation: 0 },
         { id: 'w2-b', kind: 'note', x: 260, y: 40, w: 156, h: 96, tint: 'blue', text: 'B', rotation: 0 }
       ] })`
    )
    await ctx.evalIn(`window.__canvasE2E.fitView(${JSON.stringify(planId)})`)
    await ctx.delay(200)
    const w2 = await ctx.evalIn<{
      stage: string
      ids: string
      marqueeDel: number
      afterDelUndo: number
      multiMovedBoth: boolean
      afterMoveUndo: boolean
      shiftAddMoved: boolean
      snapX: number
    }>(
      `(async () => {
         const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
         const id = ${JSON.stringify(planId)};
         const board = () => window.__canvasE2E.getBoards().find((x) => x.id === id);
         const els = () => { const b = board(); return b && b.type === 'planning' ? b.elements : []; };
         const note = (nid) => els().find((e) => e.id === nid);
         const count = () => els().length;
         const node = document.querySelector('.react-flow__node[data-id=' + JSON.stringify(id) + ']');
         const well = node && node.querySelector('.pl-well');
         if (!well) return { stage: 'no-well', ids: '', marqueeDel: -1, afterDelUndo: -1, multiMovedBoth: false, afterMoveUndo: false, shiftAddMoved: false, snapX: -1 };
         const r = well.getBoundingClientRect();
         const scale = well.offsetWidth > 0 ? r.width / well.offsetWidth : 1;
         const at = (bx, by) => ({ x: r.left + bx * scale, y: r.top + by * scale });
         // A board-local drag STARTS from the note's grip ring (.pl-note-grip), not the
         // outer .pl-note (which only stops propagation). Press the grip to begin a move.
         const grip = (i) => node.querySelectorAll('.pl-note-grip')[i];
         const ev = (target, type, p, shift) => {
           try { target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, clientX: p.x, clientY: p.y, shiftKey: !!shift })); } catch (e) {}
         };
         // down on downTarget, then N moves + up on the WELL (it owns pointer capture).
         const drag = async (from, to, opts) => {
           const o = opts || {};
           const downT = o.downTarget || well;
           ev(downT, 'pointerdown', from, o.shift); await sleep(20);
           const steps = 4;
           for (let i = 1; i <= steps; i++) {
             const t = i / steps;
             ev(well, 'pointermove', { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t }, o.shift);
             await sleep(15);
           }
           ev(well, 'pointerup', to, o.shift); await sleep(40);
         };
         const press = (k) => { well.focus(); well.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })); };

         // Crash-safe x reader + stage tracker: a probe bug must surface as a diagnostic
         // (which stage, which elements survive), never an uncaught throw that aborts the
         // whole harness before any E2E_ line prints.
         const nx = (nid) => { const n = note(nid); return n ? n.x : -999999; };
         const idsNow = () => els().map((e) => e.id).join('|');
         // Each sub-test RE-SEEDS two fresh notes + clears selection so it is INDEPENDENT:
         // a chained undo→edit across tests hits the lastRecorded dedup edge (the documented
         // undo-lastrecorded-phantom / D1.1 class) which churns shared state. Re-seeding sets
         // a fresh boards array, so the next deferred beginChange always records its checkpoint.
         // Notes carry text so a no-move grip click never triggers the empty-note prune.
         const seedEls = () => window.__canvasE2E.patchBoard(id, { elements: [
           { id: 'w2-a', kind: 'note', x: 40, y: 40, w: 156, h: 96, tint: 'yellow', text: 'A', rotation: 0 },
           { id: 'w2-b', kind: 'note', x: 260, y: 40, w: 156, h: 96, tint: 'blue', text: 'B', rotation: 0 }
         ] });
         const clearSel = () => { ev(well, 'pointerdown', at(560, 300)); ev(well, 'pointerup', at(560, 300)); };
         const fresh = async () => { seedEls(); await sleep(140); clearSel(); await sleep(40); well.focus(); await sleep(20); };
         let stage = 'start';
         try {
           // (1) group-delete: marquee both → Delete → 0; undo restores both in ONE step.
           stage = 'group-delete';
           await fresh();
           await drag(at(10, 10), at(440, 150)); // marquee covers w2-a + w2-b
           press('Delete'); await sleep(60);
           const marqueeDel = count();
           window.__canvasE2E.undo(); await sleep(60);
           const afterDelUndo = count();

           // (2) multidrag: marquee both → drag one's grip +40,+40 → BOTH move; undo restores both.
           stage = 'multidrag';
           await fresh();
           await drag(at(10, 10), at(440, 150)); await sleep(20); // select both
           const ax0 = nx('w2-a'), bx0 = nx('w2-b');
           await drag(at(118, 88), at(158, 128), { downTarget: grip(0) });
           const multiMovedBoth = nx('w2-a') - ax0 >= 30 && nx('w2-b') - bx0 >= 30;
           window.__canvasE2E.undo(); await sleep(60);
           const afterMoveUndo = nx('w2-a') === ax0 && nx('w2-b') === bx0;

           // (3) shift-add: click A (grip, no move → selects A), Shift-click B (toggle-add),
           // then drag A → BOTH move. Proves additive ELEMENT selection (selectOnPress/toggle).
           stage = 'shift-add';
           await fresh();
           ev(grip(0), 'pointerdown', at(60, 60)); ev(well, 'pointerup', at(60, 60)); await sleep(40); // click A -> {A}
           ev(grip(1), 'pointerdown', at(280, 60), true); ev(well, 'pointerup', at(280, 60), true); await sleep(40); // Shift-click B -> {A,B}
           const sa0 = nx('w2-a'), sb0 = nx('w2-b');
           await drag(at(60, 60), at(100, 60), { downTarget: grip(0) });
           const shiftAddMoved = nx('w2-a') - sa0 >= 30 && nx('w2-b') - sb0 >= 30;

           // (4) snap: press B alone (unselected) and drag its left edge to within tol of A's
           // left (x=40) → committed B.x snaps to 40 (A is the static neighbor).
           stage = 'snap';
           await fresh();
           await drag(at(338, 88), at(122, 88), { downTarget: grip(1) });
           const snapX = nx('w2-b');

           return { stage: 'done', ids: idsNow(), marqueeDel, afterDelUndo, multiMovedBoth, afterMoveUndo, shiftAddMoved, snapX };
         } catch (err) {
           return { stage: 'ERR@' + stage + ':' + String((err && err.message) || err), ids: idsNow(), marqueeDel: -9, afterDelUndo: -9, multiMovedBoth: false, afterMoveUndo: false, shiftAddMoved: false, snapX: -9 };
         }
       })()`
    )
    const groupDeleteOk = w2.marqueeDel === 0 && w2.afterDelUndo === 2
    const multidragOk = w2.multiMovedBoth && w2.afterMoveUndo
    const shiftAddOk = w2.shiftAddMoved
    const snapOk = Math.abs(w2.snapX - 40) <= 1
    return [
      {
        name: 'whiteboard-group-delete',
        ok: groupDeleteOk,
        detail: groupDeleteOk
          ? 'marquee selects 2 → Delete removes both; undo restores both in one step'
          : JSON.stringify(w2)
      },
      {
        name: 'whiteboard-multidrag',
        ok: multidragOk,
        detail: multidragOk
          ? 'marquee 2 → drag one moves both; undo restores both in one step'
          : JSON.stringify(w2)
      },
      {
        name: 'whiteboard-shift-add',
        ok: shiftAddOk,
        detail: shiftAddOk
          ? 'click A + Shift-click B selects both; dragging A moves both'
          : JSON.stringify(w2)
      },
      {
        name: 'whiteboard-snap',
        ok: snapOk,
        detail: snapOk ? "drag aligns B's left edge to neighbor (x=40)" : JSON.stringify(w2)
      }
    ]
  }
}

// ── Planning camera-full-view add-note (Option A regression guard). The bug this locks:
// full-view used to portal the board + apply a 2nd CSS transform, so a click mapped to a
// board-local point FAR outside board bounds (e.g. x=1469 on a 520-wide board) → the note
// was clipped/lost. Now full view is a CAMERA fit (one transform), so a click lands in
// bounds under the cursor. MUST use REAL OS input (win.webContents.sendInputEvent) — a
// synthetic dispatchEvent bypasses the transform hit-testing and false-greens this exact
// bug (memory e2e-sendinputevent-vs-dispatchevent).
export const whiteboardFullviewAdd: E2EProbe = {
  name: 'whiteboard-fullview-add',
  async run(ctx): Promise<E2EPart> {
    const planId = ctx.ids.planId
    if (!planId)
      return {
        name: 'whiteboard-fullview-add',
        ok: false,
        detail: 'planId not seeded (planning probe)'
      }

    // Deterministic board: known size + two notes (non-empty → not the empty-board path).
    await ctx.evalIn(
      `window.__canvasE2E.patchBoard(${JSON.stringify(planId)}, { w: 520, h: 500, elements: [
         { id: 'fv-a', kind: 'note', x: 40, y: 40, w: 156, h: 96, tint: 'yellow', text: 'A', rotation: 0 },
         { id: 'fv-b', kind: 'note', x: 300, y: 320, w: 156, h: 96, tint: 'blue', text: 'B', rotation: 0 }
       ] })`
    )
    // Let React Flow apply the new 520x500 node size before fitting the camera to it.
    await ctx.delay(180)
    // Enter camera full view (Option A) — the real path under test.
    await ctx.evalIn(`window.__canvasE2E.enterCameraFullView(${JSON.stringify(planId)})`)
    // Poll until the camera has actually fitted onto the board (rendered scale > 1.3) so
    // the board is in the viewport and the click hits it — robust to the animated-fit
    // timing on a sluggish/contended host (a fixed delay flaked: camera still at zoom 1 →
    // board off-screen → click missed → no note).
    const fitted = await ctx.poll(
      () =>
        ctx.evalIn<boolean>(
          `(() => {
             const id = ${JSON.stringify(planId)};
             const node = document.querySelector('.react-flow__node[data-id=' + JSON.stringify(id) + ']');
             const well = node && node.querySelector('.pl-well');
             if (!well || !(well.offsetWidth > 0)) return false;
             const r = well.getBoundingClientRect();
             return r.width / well.offsetWidth > 1.3;
           })()`
        ),
      4000
    )
    if (!fitted) {
      await ctx.evalIn(`window.__canvasE2E.exitCameraFullView()`)
      return {
        name: 'whiteboard-fullview-add',
        ok: false,
        detail: 'camera did not fit the board in full view (zoom stayed ~1)'
      }
    }
    await ctx.delay(60) // settle the final fitted frame before reading the rect

    // Compute the well's on-screen rect → the screen point for board-local (260, 250).
    const t = await ctx.evalIn<{
      found: boolean
      sx: number
      sy: number
      scale: number
      bx: number
      by: number
    }>(
      `(() => {
         const id = ${JSON.stringify(planId)};
         const node = document.querySelector('.react-flow__node[data-id=' + JSON.stringify(id) + ']');
         const well = node && node.querySelector('.pl-well');
         if (!well) return { found: false, sx: 0, sy: 0, scale: 0, bx: 0, by: 0 };
         const r = well.getBoundingClientRect();
         const scale = well.offsetWidth > 0 ? r.width / well.offsetWidth : 1;
         const bx = 260, by = 250;                    // board-local target (~center of 520x500)
         return { found: true, sx: r.left + bx * scale, sy: r.top + by * scale, scale, bx, by };
       })()`
    )
    if (!t.found) {
      await ctx.evalIn(`window.__canvasE2E.exitCameraFullView()`)
      return { name: 'whiteboard-fullview-add', ok: false, detail: 'no .pl-well in full view' }
    }

    // Select the note tool — synthetic key is fine (no coordinate mapping involved).
    await ctx.evalIn(
      `(() => {
         const id = ${JSON.stringify(planId)};
         const node = document.querySelector('.react-flow__node[data-id=' + JSON.stringify(id) + ']');
         const well = node && node.querySelector('.pl-well');
         if (well) { well.focus(); well.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', bubbles: true })); }
       })()`
    )
    await ctx.delay(60)

    // REAL OS click — exercises toBoard under the live camera transform.
    const x = Math.round(t.sx)
    const y = Math.round(t.sy)
    ctx.win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
    ctx.win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
    await ctx.delay(140)

    // Read the freshly added note (the non-seed note) + board size.
    const res = await ctx.evalIn<{
      count: number
      nx: number
      ny: number
      nw: number
      bw: number
      bh: number
    }>(
      `(() => {
         const id = ${JSON.stringify(planId)};
         const b = window.__canvasE2E.getBoards().find((x) => x.id === id);
         const els = b && b.type === 'planning' ? b.elements : [];
         const added = els.filter((e) => e.kind === 'note' && e.id !== 'fv-a' && e.id !== 'fv-b').pop();
         return {
           count: els.length,
           nx: added ? added.x : -999999,
           ny: added ? added.y : -999999,
           nw: added ? added.w : 0,
           bw: b ? b.w : 0,
           bh: b ? b.h : 0
         };
       })()`
    )
    // Restore the viewport so later probes aren't disturbed.
    await ctx.evalIn(`window.__canvasE2E.exitCameraFullView()`)
    await ctx.delay(60)

    // makeNote centers x on the click and offsets y by 20 → reconstruct the click point.
    const clickX = res.nx + res.nw / 2
    const clickY = res.ny + 20
    const inBounds = res.nx >= 0 && res.nx <= res.bw && res.ny >= 0 && res.ny <= res.bh
    const nearClick = Math.abs(clickX - t.bx) <= 10 && Math.abs(clickY - t.by) <= 10
    const ok = res.count === 3 && inBounds && nearClick
    return {
      name: 'whiteboard-fullview-add',
      ok,
      detail: ok
        ? `real click lands in-bounds at board-local ~(${Math.round(clickX)},${Math.round(clickY)}) on ${res.bw}x${res.bh}`
        : JSON.stringify({ ...res, target: { bx: t.bx, by: t.by, scale: t.scale } })
    }
  }
}

// ── W3 selection follow-ons. alt-dup uses REAL OS input (transform-dependent);
// align/lock/group drive the real HTML context menu (transform-free) after a synthetic
// selection. All effects read off getBoards() (selection is ephemeral). Order-bound:
// read ctx.ids.planId, run before `seed`, mutate only the planning board's elements.

export const whiteboardAltDup: E2EProbe = {
  name: 'whiteboard-alt-dup',
  async run(ctx): Promise<E2EPart> {
    const planId = ctx.ids.planId
    if (!planId) return { name: 'whiteboard-alt-dup', ok: false, detail: 'planId not seeded' }
    await ctx.evalIn(
      `window.__canvasE2E.patchBoard(${JSON.stringify(planId)}, { w: 520, h: 460, elements: [
         { id: 'ad-a', kind: 'note', x: 60, y: 60, w: 156, h: 96, tint: 'yellow', text: 'A', rotation: 0 }
       ] })`
    )
    await ctx.evalIn(`window.__canvasE2E.fitView(${JSON.stringify(planId)})`)
    await ctx.delay(240)
    // Synthetic alt-drag of the note's GRIP RING (.pl-note-grip — a drag only starts there;
    // the note body just stops propagation). Electron's sendInputEvent mouse `modifiers:['alt']`
    // does NOT surface as e.altKey on this stack, so — exactly like the passing W2 multidrag /
    // shift-add probes — we dispatch synthetic PointerEvents carrying altKey:true (React reads
    // the flag straight off the event) with coords mapped board-local→screen via the well
    // rect×scale so toBoard maps correctly. The duplicate EFFECT is read off getBoards():
    // count+1, the copy offset matches the screen→board delta, the ORIGINAL is unmoved, and
    // undo removes the copy — a broken dup/alt path fails (a plain move would leave count=1),
    // so this is not a false green.
    const res = await ctx.evalIn<{
      stage: string
      start: number
      scale: number
      afterDup: number
      origMoved: number
      copyDx: number
      copyDy: number
      afterUndo: number
    }>(
      `(async () => {
         const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
         const id = ${JSON.stringify(planId)};
         const els = () => window.__canvasE2E.getBoards().find((x) => x.id === id).elements;
         const n = document.querySelector('.react-flow__node[data-id=' + JSON.stringify(id) + ']');
         const w = n.querySelector('.pl-well');
         const g = n.querySelector('.pl-note-grip');
         const wr = w.getBoundingClientRect();
         const s = wr.width / w.offsetWidth;
         const gr = g.getBoundingClientRect();
         const fx = gr.left + gr.width / 2, fy = gr.top + gr.height / 2;
         const dScreen = 60;
         const ev = (t, type, x, y) => { try { t.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, altKey: true, clientX: x, clientY: y })); } catch (e) {} };
         const orig = () => els().find((e) => e.id === 'ad-a');
         const start = els().length;
         const ox = orig().x, oy = orig().y;
         ev(g, 'pointerdown', fx, fy); await sleep(20);
         for (let i = 1; i <= 4; i++) { ev(w, 'pointermove', fx + (dScreen * i) / 4, fy + (dScreen * i) / 4); await sleep(15); }
         ev(w, 'pointerup', fx + dScreen, fy + dScreen); await sleep(70);
         const after = els();
         const afterDup = after.length;
         const o = after.find((e) => e.id === 'ad-a');
         const origMoved = o ? Math.abs(o.x - ox) + Math.abs(o.y - oy) : -1;
         const copy = after.find((e) => e.id !== 'ad-a' && e.kind === 'note');
         const copyDx = copy ? copy.x - ox : -999;
         const copyDy = copy ? copy.y - oy : -999;
         window.__canvasE2E.undo(); await sleep(70);
         const afterUndo = els().length;
         return { stage: 'done', start, scale: s, afterDup, origMoved, copyDx, copyDy, afterUndo };
       })()`
    )
    // Expected copy offset = 60 screen px ÷ scale (board-local), with snapping inert (one note,
    // no static neighbours). Assert the copy lands down-right at ~that delta, original unmoved.
    const expected = res.scale > 0 ? 60 / res.scale : 60
    const offsetOk = Math.abs(res.copyDx - expected) <= 8 && Math.abs(res.copyDy - expected) <= 8
    const ok =
      res.afterDup === res.start + 1 &&
      res.origMoved === 0 &&
      offsetOk &&
      res.afterUndo === res.start
    return {
      name: 'whiteboard-alt-dup',
      ok,
      detail: ok
        ? `alt-drag duplicates the note at board-local +(${Math.round(res.copyDx)},${Math.round(res.copyDy)}); original unmoved; one undo removes the copy`
        : JSON.stringify(res)
    }
  }
}

export const whiteboardLock: E2EProbe = {
  name: 'whiteboard-lock',
  async run(ctx): Promise<E2EPart> {
    const planId = ctx.ids.planId
    if (!planId) return { name: 'whiteboard-lock', ok: false, detail: 'planId not seeded' }
    await ctx.evalIn(
      `window.__canvasE2E.patchBoard(${JSON.stringify(planId)}, { w: 520, h: 460, elements: [
         { id: 'lk-a', kind: 'note', x: 60, y: 60, w: 156, h: 96, tint: 'yellow', text: 'A', rotation: 0, locked: true }
       ] })`
    )
    await ctx.evalIn(`window.__canvasE2E.fitView(${JSON.stringify(planId)})`)
    await ctx.delay(220)
    const res = await ctx.evalIn<{
      stage: string
      movedX: number
      afterErase: number
      afterMenuDelete: number
      noDelBtn: boolean
    }>(
      `(async () => {
         const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
         const id = ${JSON.stringify(planId)};
         const board = () => window.__canvasE2E.getBoards().find((x) => x.id === id);
         const els = () => board().elements;
         const note = () => els().find((e) => e.id === 'lk-a');
         const n = document.querySelector('.react-flow__node[data-id=' + JSON.stringify(id) + ']');
         const w = n.querySelector('.pl-well');
         const r = w.getBoundingClientRect();
         const s = r.width / w.offsetWidth;
         const at = (bx, by) => ({ clientX: r.left + bx * s, clientY: r.top + by * s, bubbles: true, cancelable: true, pointerId: 1, isPrimary: true });
         const grip = n.querySelector('.pl-note-grip');
         const x0 = note().x;
         // (1) drag the locked note via its grip → must NOT move.
         try { grip.dispatchEvent(new PointerEvent('pointerdown', at(138, 108))); for (let i=1;i<=4;i++){ w.dispatchEvent(new PointerEvent('pointermove', at(138+20*i,108+20*i))); await sleep(12);} w.dispatchEvent(new PointerEvent('pointerup', at(218,188))); } catch(e){}
         await sleep(60);
         const movedX = note() ? note().x - x0 : -999;
         // (2) erase swipe over the locked note → count unchanged.
         w.focus(); w.dispatchEvent(new KeyboardEvent('keydown', { key: 'e', bubbles: true })); await sleep(30);
         try { w.dispatchEvent(new PointerEvent('pointerdown', at(138,108))); w.dispatchEvent(new PointerEvent('pointermove', at(140,110))); w.dispatchEvent(new PointerEvent('pointerup', at(140,110))); } catch(e){}
         await sleep(60);
         const afterErase = els().length;
         // (3) right-click → menu Delete on the locked note → must NOT remove it (lock
         // gate on the menu Delete path; the inline X affordance was removed in W3 so
         // deletion is menu/eraser-only, and lock resists the menu Delete too).
         w.dispatchEvent(new KeyboardEvent('keydown', { key: 's', bubbles: true })); await sleep(20);
         const noDelBtn = !n.querySelector('.pl-del'); // the inline X must be gone
         const cm = at(138, 108);
         w.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: cm.clientX, clientY: cm.clientY })); await sleep(90);
         const delItem = document.querySelector('[data-testid="w3-menu-delete"]');
         if (delItem) { try { delItem.dispatchEvent(new MouseEvent('click', { bubbles: true })); } catch(e){} }
         await sleep(60);
         const afterMenuDelete = els().length;
         return { stage: 'done', movedX, afterErase, afterMenuDelete, noDelBtn };
       })()`
    )
    const ok =
      Math.abs(res.movedX) < 1 && res.afterErase === 1 && res.afterMenuDelete === 1 && res.noDelBtn
    return {
      name: 'whiteboard-lock',
      ok,
      detail: ok
        ? 'locked note resists drag, erase, and menu Delete; inline X removed'
        : JSON.stringify(res)
    }
  }
}

export const whiteboardGroup: E2EProbe = {
  name: 'whiteboard-group',
  async run(ctx): Promise<E2EPart> {
    const planId = ctx.ids.planId
    if (!planId) return { name: 'whiteboard-group', ok: false, detail: 'planId not seeded' }
    await ctx.evalIn(
      `window.__canvasE2E.patchBoard(${JSON.stringify(planId)}, { w: 560, h: 460, elements: [
         { id: 'gp-a', kind: 'note', x: 40, y: 40, w: 156, h: 96, tint: 'yellow', text: 'A', rotation: 0 },
         { id: 'gp-b', kind: 'note', x: 300, y: 40, w: 156, h: 96, tint: 'blue', text: 'B', rotation: 0 }
       ] })`
    )
    await ctx.evalIn(`window.__canvasE2E.fitView(${JSON.stringify(planId)})`)
    await ctx.delay(220)
    const res = await ctx.evalIn<{
      stage: string
      grouped: boolean
      bMovedWithA: boolean
      deletedBoth: number
    }>(
      `(async () => {
         const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
         const id = ${JSON.stringify(planId)};
         const els = () => window.__canvasE2E.getBoards().find((x) => x.id === id).elements;
         const note = (nid) => els().find((e) => e.id === nid);
         const n = document.querySelector('.react-flow__node[data-id=' + JSON.stringify(id) + ']');
         const w = n.querySelector('.pl-well');
         const r = w.getBoundingClientRect();
         const s = r.width / w.offsetWidth;
         const at = (bx, by) => ({ x: r.left + bx * s, y: r.top + by * s });
         const ev = (t, type, p, extra) => { try { t.dispatchEvent(new PointerEvent(type, Object.assign({ bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, clientX: p.x, clientY: p.y }, extra || {}))); } catch(e){} };
         const drag = async (from, to, downT) => { ev(downT || w, 'pointerdown', from); for (let i=1;i<=4;i++){ ev(w,'pointermove',{x:from.x+(to.x-from.x)*i/4,y:from.y+(to.y-from.y)*i/4}); await sleep(12);} ev(w,'pointerup',to); await sleep(40); };
         const grip = (i) => n.querySelectorAll('.pl-note-grip')[i];
         const clickMenu = (testid) => { const el = document.querySelector('[data-testid=' + JSON.stringify(testid) + ']'); if (el) el.dispatchEvent(new MouseEvent('click', { bubbles: true })); };
         // select both via marquee, then right-click → Group.
         await drag(at(8, 8), at(470, 150));
         await sleep(30);
         w.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: at(118,88).x, clientY: at(118,88).y }));
         await sleep(60);
         clickMenu('w3-menu-group'); await sleep(60);
         const grouped = !!note('gp-a').groupId && note('gp-a').groupId === note('gp-b').groupId;
         // drag A's grip → B moves too (group move).
         const ax0 = note('gp-a').x, bx0 = note('gp-b').x;
         // press A first to select the group member, then drag.
         ev(grip(0), 'pointerdown', at(118, 88)); ev(w, 'pointerup', at(118, 88)); await sleep(30);
         await drag(at(118, 88), at(168, 88), grip(0));
         const bMovedWithA = (note('gp-b').x - bx0) >= 30 && (note('gp-a').x - ax0) >= 30;
         // delete one (selected) → both gone (group delete).
         ev(grip(0), 'pointerdown', at(168, 88)); ev(w, 'pointerup', at(168, 88)); await sleep(20);
         w.focus(); w.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true })); await sleep(60);
         const deletedBoth = els().length;
         return { stage: 'done', grouped, bMovedWithA, deletedBoth };
       })()`
    )
    const ok = res.grouped && res.bMovedWithA && res.deletedBoth === 0
    return {
      name: 'whiteboard-group',
      ok,
      detail: ok
        ? 'group via menu; dragging one moves both; deleting one deletes both'
        : JSON.stringify(res)
    }
  }
}

export const whiteboardAlign: E2EProbe = {
  name: 'whiteboard-align',
  async run(ctx): Promise<E2EPart> {
    const planId = ctx.ids.planId
    if (!planId) return { name: 'whiteboard-align', ok: false, detail: 'planId not seeded' }
    await ctx.evalIn(
      `window.__canvasE2E.patchBoard(${JSON.stringify(planId)}, { w: 560, h: 460, elements: [
         { id: 'al-a', kind: 'note', x: 40, y: 40, w: 156, h: 96, tint: 'yellow', text: 'A', rotation: 0 },
         { id: 'al-b', kind: 'note', x: 300, y: 220, w: 156, h: 96, tint: 'blue', text: 'B', rotation: 0 }
       ] })`
    )
    await ctx.evalIn(`window.__canvasE2E.fitView(${JSON.stringify(planId)})`)
    await ctx.delay(220)
    const res = await ctx.evalIn<{ stage: string; ax: number; bx: number; undoBx: number }>(
      `(async () => {
         const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
         const id = ${JSON.stringify(planId)};
         const els = () => window.__canvasE2E.getBoards().find((x) => x.id === id).elements;
         const note = (nid) => els().find((e) => e.id === nid);
         const n = document.querySelector('.react-flow__node[data-id=' + JSON.stringify(id) + ']');
         const w = n.querySelector('.pl-well');
         const r = w.getBoundingClientRect();
         const s = r.width / w.offsetWidth;
         const at = (bx, by) => ({ x: r.left + bx * s, y: r.top + by * s });
         const ev = (t, type, p) => { try { t.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, clientX: p.x, clientY: p.y })); } catch(e){} };
         const drag = async (from, to) => { ev(w, 'pointerdown', from); for (let i=1;i<=4;i++){ ev(w,'pointermove',{x:from.x+(to.x-from.x)*i/4,y:from.y+(to.y-from.y)*i/4}); await sleep(12);} ev(w,'pointerup',to); await sleep(40); };
         await drag(at(8, 8), at(470, 330)); // marquee both
         await sleep(30);
         w.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: at(118,88).x, clientY: at(118,88).y }));
         await sleep(60);
         const btn = document.querySelector('[data-testid="w3-menu-align-left"]');
         if (btn) btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
         await sleep(60);
         const ax = note('al-a').x, bx = note('al-b').x;
         window.__canvasE2E.undo(); await sleep(60);
         const undoBx = note('al-b').x;
         return { stage: 'done', ax, bx, undoBx };
       })()`
    )
    // New align model: align-left flushes both left edges to the board pad (12), not the
    // selection's min-left. One undo restores al-b's original x.
    const ok = res.ax === res.bx && res.ax === 12 && res.undoBx === 300
    return {
      name: 'whiteboard-align',
      ok,
      detail: ok
        ? 'align-left via menu flushes both to the board left edge (x=12); one undo restores'
        : JSON.stringify(res)
    }
  }
}

// ── W3 regression: align/distribute must work on a GROUP. The bug: right-clicking a
// single GROUPED element selected only that one, so Align/Distribute greyed out (sel<2)
// even though it belongs to a multi-element group. Fix: right-click expands through the
// group. This groups two notes, clears the selection, right-clicks ONE, and aligns —
// BOTH must move (proving the group was selected + aligned), not just the clicked one.
export const whiteboardGroupAlign: E2EProbe = {
  name: 'whiteboard-group-align',
  async run(ctx): Promise<E2EPart> {
    const planId = ctx.ids.planId
    if (!planId) return { name: 'whiteboard-group-align', ok: false, detail: 'planId not seeded' }
    await ctx.evalIn(
      `window.__canvasE2E.patchBoard(${JSON.stringify(planId)}, { w: 560, h: 460, elements: [
         { id: 'ga-a', kind: 'note', x: 40,  y: 40,  w: 156, h: 96, tint: 'yellow', text: 'A', rotation: 0 },
         { id: 'ga-b', kind: 'note', x: 300, y: 220, w: 156, h: 96, tint: 'blue',   text: 'B', rotation: 0 }
       ] })`
    )
    await ctx.evalIn(`window.__canvasE2E.fitView(${JSON.stringify(planId)})`)
    await ctx.delay(220)
    const res = await ctx.evalIn<{ stage: string; grouped: boolean; ax: number; bx: number }>(
      `(async () => {
         const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
         const id = ${JSON.stringify(planId)};
         const els = () => window.__canvasE2E.getBoards().find((x) => x.id === id).elements;
         const note = (nid) => els().find((e) => e.id === nid);
         const n = document.querySelector('.react-flow__node[data-id=' + JSON.stringify(id) + ']');
         const w = n.querySelector('.pl-well');
         const r = w.getBoundingClientRect();
         const s = w.offsetWidth > 0 ? r.width / w.offsetWidth : 1;
         const at = (bx, by) => ({ x: r.left + bx * s, y: r.top + by * s });
         const ev = (t, type, p) => { try { t.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, clientX: p.x, clientY: p.y })); } catch (e) {} };
         const drag = async (from, to) => { ev(w, 'pointerdown', from); for (let i=1;i<=4;i++){ ev(w,'pointermove',{x:from.x+(to.x-from.x)*i/4,y:from.y+(to.y-from.y)*i/4}); await sleep(12);} ev(w,'pointerup',to); await sleep(40); };
         const ctxAt = (p) => w.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: p.x, clientY: p.y }));
         const click = (testid) => { const el = document.querySelector('[data-testid=' + JSON.stringify(testid) + ']'); if (el) el.dispatchEvent(new MouseEvent('click', { bubbles: true })); };
         // 1) marquee both → Group via menu.
         await drag(at(8, 8), at(500, 360)); await sleep(30);
         ctxAt(at(118, 88)); await sleep(80);
         click('w3-menu-group'); await sleep(80);
         const grouped = !!note('ga-a').groupId && note('ga-a').groupId === note('ga-b').groupId;
         // 2) clear selection (click empty far corner), then right-click ONLY ga-b.
         ev(w, 'pointerdown', at(540, 440)); ev(w, 'pointerup', at(540, 440)); await sleep(40);
         ctxAt(at(378, 268)); await sleep(80); // ga-b centre (300+78, 220+48)
         // Align should be ENABLED (group expands to 2) → align-left moves BOTH to x=40.
         click('w3-menu-align-left'); await sleep(80);
         return { stage: 'done', grouped, ax: note('ga-a').x, bx: note('ga-b').x };
       })()`
    )
    // The fix: right-clicking grouped ga-b selects the whole group, so align-left flushes
    // BOTH to the board left edge (x=12). Pre-fix, only ga-b was selected → Align greyed.
    const ok = res.grouped && res.ax === 12 && res.bx === 12
    return {
      name: 'whiteboard-group-align',
      ok,
      detail: ok
        ? 'right-click a grouped element → align-left flushes the whole group to x=12'
        : JSON.stringify(res)
    }
  }
}

// ── W4 image paste: real clipboard paste persists a blob to assets/<sha1>, stores a
// RELATIVE path (not base64), survives a reload, dedups identical bytes to one file,
// and is swept by the open-time GC. MAIN-side: mints a temp project (e2e has no project
// dir), puts an image on the system clipboard, focuses the well, and drives a REAL
// Ctrl+V keystroke via webContents.sendInputEvent — the same path a user hits (memory
// e2e-sendinputevent-vs-dispatchevent: real OS input, not a synthetic ClipboardEvent
// which can't carry a file image item, and not webContents.paste() which is a no-op on
// the non-editable well).
export const whiteboardPasteImage: E2EProbe = {
  name: 'whiteboard-paste-image',
  async run(ctx): Promise<E2EPart[]> {
    const planId = ctx.ids.planId
    if (!planId) return [{ name: 'whiteboard-paste-image', ok: false, detail: 'planId not seeded' }]

    const tmp = mkdtempSync(join(tmpdir(), 'canvas-w4-'))
    const id = JSON.stringify(planId)
    const imageCount = async (): Promise<number> =>
      ctx.evalIn<number>(
        `(() => { const b = window.__canvasE2E.getBoards().find(x => x.id === ${id});
                  return b && b.type === 'planning' ? b.elements.filter(e => e.kind === 'image').length : -1; })()`
      )
    const firstAssetId = async (): Promise<string | null> =>
      ctx.evalIn<string | null>(
        `(() => { const b = window.__canvasE2E.getBoards().find(x => x.id === ${id});
                  const img = (b && b.type === 'planning' ? b.elements : []).find(e => e.kind === 'image');
                  return img ? img.assetId : null; })()`
      )
    // Focus the REAL well (the user surface) so a Ctrl+V keystroke targets the same
    // element a user pastes onto. The well is tabIndex=0 → focusable.
    const focusWell = async (): Promise<void> => {
      await ctx.evalIn(
        `(() => { const n = document.querySelector('.react-flow__node[data-id=' + ${JSON.stringify(
          id
        )} + ']'); const w = n && n.querySelector('.pl-well'); if (w) w.focus(); })()`
      )
    }
    // Drive a REAL Ctrl+V keystroke (OS input). Chromium dispatches the `paste` DOM event
    // to the focused well even though it is not editable; React's onPaste catches the
    // bubbled event — the exact path a real user hits. (webContents.paste() is NOT used:
    // it invokes the Paste *editing command*, a no-op on a non-editable element, so it
    // never fires a paste event there — the trap the earlier proxy contingency hit.)
    const pasteKey = (): void => {
      const wc = ctx.win.webContents
      wc.sendInputEvent({ type: 'keyDown', keyCode: 'V', modifiers: ['control'] })
      wc.sendInputEvent({ type: 'char', keyCode: 'V', modifiers: ['control'] })
      wc.sendInputEvent({ type: 'keyUp', keyCode: 'V', modifiers: ['control'] })
    }
    const parts: E2EPart[] = []
    try {
      await createProject(tmp, 'w4', {})
      setCurrentDir(tmp)
      await ctx.evalIn(`window.__canvasE2E.patchBoard(${id}, { elements: [] })`)
      await ctx.delay(80)

      // (1) PASTE — put a 10×10 opaque-red bitmap on the system clipboard, focus the well,
      // and drive a real Ctrl+V. createFromBitmap takes raw RGBA (4 bytes/pixel, no encoding).
      const width = 10
      const height = 10
      const bitmapBuf = Buffer.alloc(width * height * 4)
      for (let i = 0; i < width * height; i++) {
        bitmapBuf[i * 4] = 255 // R
        bitmapBuf[i * 4 + 1] = 0 // G
        bitmapBuf[i * 4 + 2] = 0 // B
        bitmapBuf[i * 4 + 3] = 255 // A
      }
      const ni = nativeImage.createFromBitmap(bitmapBuf, { width, height })
      clipboard.clear()
      clipboard.writeImage(ni)
      await focusWell()
      await ctx.delay(40)
      pasteKey()
      const pasted = await ctx.poll(async () => (await imageCount()) === 1, 4000)
      const assetId = await firstAssetId()
      const relOk =
        !!assetId && /^assets[/\\][0-9a-f]{40}\.png$/.test(assetId) && !assetId.startsWith('data:')
      const fileOk = !!assetId && existsSync(join(tmp, assetId))
      parts.push({
        name: 'whiteboard-paste-image',
        ok: pasted && relOk && fileOk,
        detail:
          pasted && relOk && fileOk
            ? `paste wrote ${assetId} (relative path, blob on disk)`
            : JSON.stringify({ pasted, assetId, relOk, fileOk })
      })

      // (2) RELOAD — write the doc, read it back, assert the image + assetId survive.
      const docStr = await ctx.evalIn<string>(
        `JSON.stringify({ schemaVersion: 4, viewport: null, boards: window.__canvasE2E.getBoards() })`
      )
      await writeProject(tmp, JSON.parse(docStr))
      const reread = readProject(tmp)
      const reImg =
        reread.ok &&
        collectAssetIds((reread as { doc: unknown }).doc).has(assetId ?? '__none__') &&
        !!assetId &&
        existsSync(join(tmp, assetId))
      parts.push({
        name: 'whiteboard-paste-reload',
        ok: !!reImg,
        detail: reImg
          ? 'image element + blob survive a write/read round-trip'
          : JSON.stringify({ reread: reread.ok })
      })

      // (3) DEDUP — paste the SAME image again → 2 elements, ONE blob file.
      await focusWell()
      await ctx.delay(40)
      pasteKey()
      const two = await ctx.poll(async () => (await imageCount()) === 2, 4000)
      const fileCount = existsSync(join(tmp, 'assets'))
        ? readdirSync(join(tmp, 'assets')).length
        : -1
      parts.push({
        name: 'whiteboard-asset-dedup',
        ok: two && fileCount === 1,
        detail:
          two && fileCount === 1
            ? '2 image elements share 1 blob'
            : JSON.stringify({ two, fileCount })
      })

      // (4) GC — clear elements, sweep, assert the orphan blob is gone.
      await ctx.evalIn(`window.__canvasE2E.patchBoard(${id}, { elements: [] })`)
      gcAssets(tmp, collectAssetIds({ boards: [] }))
      const swept =
        !existsSync(join(tmp, 'assets')) || readdirSync(join(tmp, 'assets')).length === 0
      parts.push({
        name: 'whiteboard-asset-gc',
        ok: swept,
        detail: swept
          ? 'orphan blob swept at GC'
          : JSON.stringify({ remaining: readdirSync(join(tmp, 'assets')) })
      })
    } catch (err) {
      parts.push({
        name: 'whiteboard-paste-image',
        ok: false,
        detail: 'ERR: ' + String((err as Error)?.message ?? err)
      })
    } finally {
      setCurrentDir(null)
      try {
        rmSync(tmp, { recursive: true, force: true })
      } catch {
        /* best-effort temp cleanup */
      }
    }
    return parts
  }
}
