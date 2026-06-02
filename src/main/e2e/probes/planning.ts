/**
 * Planning-board probe: seed it, add a checklist element, and assert the element
 * persisted AND the whole canvas round-trips through the schema (persistence-readiness).
 */
import type { E2EProbe } from '../types'

export const planning: E2EProbe = {
  name: 'planning',
  async run(ctx) {
    const planId = await ctx.evalIn<string>("window.__canvasE2E.seedBoard('planning')")
    ctx.ids.planId = planId
    await ctx.evalIn(`window.__canvasE2E.addChecklist(${JSON.stringify(planId)})`)
    const planProbe = await ctx.evalIn<{ kinds: string[]; roundTrip: boolean }>(
      `(() => {
         const b = window.__canvasE2E.getBoards().find((x) => x.id === ${JSON.stringify(planId)});
         const kinds = b && b.type === 'planning' ? b.elements.map((e) => e.kind) : [];
         return { kinds, roundTrip: window.__canvasE2E.roundTripOk() };
       })()`
    )
    const planOk = planProbe.kinds.includes('checklist') && planProbe.roundTrip
    return {
      name: 'planning',
      ok: planOk,
      detail: `elements=[${planProbe.kinds.join(',')}] roundTrip=${planProbe.roundTrip}`
    }
  }
}
