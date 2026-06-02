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
    // Enter camera full view (Option A) and let the fit animation settle.
    await ctx.evalIn(`window.__canvasE2E.enterCameraFullView(${JSON.stringify(planId)})`)
    await ctx.delay(400)

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
