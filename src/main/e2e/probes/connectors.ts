/**
 * M2 spatial-connector probe (T2.1). Drives the store's connector model end-to-end
 * through the same path the renderer uses: add an orchestration connector between the
 * seeded terminal and browser, assert it lands in the live store, survives a
 * toObject→fromObject round-trip, and that removing it restores the baseline (so the
 * connectors array is empty for later probes). Pure store/state — no native layer.
 */
import type { E2EProbe } from '../types'

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
