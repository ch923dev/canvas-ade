/**
 * Planning-board fixture group: one planning board. Asserts a checklist element persists
 * and the whole canvas round-trips through the schema (persistence-readiness).
 */
import type { E2EGroup, GroupProbe } from '../types'

export interface PlanningFixture {
  planId: string
}

const seedPlanning: E2EGroup<PlanningFixture>['setup'] = async (ctx) => {
  const planId = await ctx.evalIn<string>("window.__canvasE2E.seedBoard('planning')")
  return { planId }
}

export const planning: GroupProbe<PlanningFixture> = {
  name: 'planning',
  async run(ctx, fx) {
    await ctx.evalIn(`window.__canvasE2E.addChecklist(${JSON.stringify(fx.planId)})`)
    const planProbe = await ctx.evalIn<{ kinds: string[]; roundTrip: boolean }>(
      `(() => {
         const b = window.__canvasE2E.getBoards().find((x) => x.id === ${JSON.stringify(fx.planId)});
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

export const planningGroup: E2EGroup<PlanningFixture> = {
  name: 'planning',
  setup: seedPlanning,
  probes: [planning],
  teardown: async (ctx) => {
    await ctx.evalIn('window.__canvasE2E.clearAllBoards()')
  }
}
