/**
 * M2 spatial-connector probe (T2.1). Drives the store's connector model end-to-end
 * through the same path the renderer uses: add an orchestration connector between the
 * seeded terminal and browser, assert it lands in the live store, survives a
 * toObject→fromObject round-trip, and that removing it restores the baseline (so the
 * connectors array is empty for later probes). Pure store/state — no native layer.
 */
import type { E2EProbe } from '../types'

// ── Draw + delete (T2.2): arm a connector from the terminal, complete it at the browser
// board's center through the SAME resolution path the pointer gesture uses
// (resolveConnectTarget → addConnector); delete it via the edge ✕; and prove removeBoard
// drops an incident connector that undo restores alongside the board. Restores baseline. ──
export const connectorDrawDelete: E2EProbe = {
  name: 'connector-draw-delete',
  async run(ctx) {
    const termId = ctx.ids.termId!
    const browserId = ctx.ids.browserId!
    const r = await ctx.evalIn<{
      drawn: boolean
      btnVisible: boolean
      afterX: number
      before: number
      boardGone: boolean
      connGone: boolean
      boardBack: boolean
      connBack: boolean
      finalConn: number
      finalBoards: number
    }>(
      `(async () => {
         const E = window.__canvasE2E;
         const T = ${JSON.stringify(termId)}, B = ${JSON.stringify(browserId)};
         const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
         const browser = E.getBoards().find((b) => b.id === B);
         const cx = browser.x + browser.w / 2, cy = browser.y + browser.h / 2;

         // 1) DRAW: arm from the terminal, drop on the browser → orchestration connector.
         E.startConnect(T);
         const id1 = E.completeConnectAt(cx, cy);
         const drawn = E.getConnectors().some(
           (c) => c.id === id1 && c.kind === 'orchestration' && c.sourceId === T && c.targetId === B
         );

         // 2) ✕-DELETE: select → the midpoint ✕ becomes visible → click removes it.
         E.selectConnector(id1);
         await sleep(100);
         const btn = document.querySelector('.ca-connector-delete[data-connector="' + id1 + '"]');
         const btnVisible = !!btn && getComputedStyle(btn).display !== 'none';
         if (btn) btn.click();
         await sleep(80);
         const afterX = E.getConnectors().length;
         E.selectConnector(null);

         // 3) DELETE-BOARD CLEANUP + UNDO restores both, in one step.
         E.startConnect(T);
         E.completeConnectAt(cx, cy);
         const before = E.getConnectors().length;          // 1
         E.deleteBoard(B);
         const boardGone = !E.getBoards().some((b) => b.id === B);
         const connGone = E.getConnectors().length === 0;
         E.undo();
         await sleep(80);
         const boardBack = E.getBoards().some((b) => b.id === B);
         const connBack = E.getConnectors().length === 1;

         // Restore baseline for later probes: drop the restored connector (board stays).
         const restored = (E.getConnectors()[0] || {}).id;
         if (restored) E.removeConnector(restored);
         const finalConn = E.getConnectors().length;
         const finalBoards = E.getBoards().length;
         return { drawn, btnVisible, afterX, before, boardGone, connGone, boardBack, connBack, finalConn, finalBoards };
       })()`
    )
    const ok =
      r.drawn &&
      r.btnVisible &&
      r.afterX === 0 &&
      r.before === 1 &&
      r.boardGone &&
      r.connGone &&
      r.boardBack &&
      r.connBack &&
      r.finalConn === 0 &&
      r.finalBoards === 4
    return {
      name: 'connector-draw-delete',
      ok,
      detail: ok
        ? 'draw via resolveConnectTarget → ✕ deletes → removeBoard drops incident cable → undo restores board + cable'
        : JSON.stringify(r)
    }
  }
}

export const connectorRoundtrip: E2EProbe = {
  name: 'connector-roundtrip',
  async run(ctx) {
    const termId = ctx.ids.termId!
    const browserId = ctx.ids.browserId!
    const r = await ctx.evalIn<{
      before: number
      added: string | null
      reflected: boolean
      survives: number
      roundTripOk: boolean
      afterRemove: number
    }>(
      `(() => {
         const E = window.__canvasE2E;
         const before = E.getConnectors().length;
         const id = E.addConnector(${JSON.stringify(termId)}, ${JSON.stringify(browserId)}, 'orchestration');
         const reflected = E.getConnectors().some((c) => c.id === id && c.kind === 'orchestration' && c.sourceId === ${JSON.stringify(termId)} && c.targetId === ${JSON.stringify(browserId)});
         const survives = E.serializedConnectorCount();
         const roundTripOk = E.roundTripOk();
         if (id) E.removeConnector(id);            // restore baseline (no count change, but keep state clean)
         const afterRemove = E.getConnectors().length;
         return { before, added: id, reflected, survives, roundTripOk, afterRemove };
       })()`
    )
    const ok =
      r.before === 0 &&
      !!r.added &&
      r.reflected &&
      r.survives >= 1 &&
      r.roundTripOk &&
      r.afterRemove === 0
    return {
      name: 'connector-roundtrip',
      ok,
      detail: ok
        ? 'addConnector lands in store + survives serialize round-trip; removeConnector restores baseline'
        : JSON.stringify(r)
    }
  }
}
