import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { E2EProbe } from '../types'

/**
 * M-brain T-B3: the per-day call budget. Under CANVAS_SMOKE=e2e the provider is mocked
 * (no network). Default config sets NO cap → mock-seam enforcement is OFF, so this probe
 * opts in by lowering maxCallsPerDay to 1 via the real setConfig bridge, then drives
 * summarize past it. The FIRST call fills cap 1; the SECOND is deterministically over it
 * → budget-exceeded. Asserts: budget-exceeded surfaces, the app stays usable (status
 * resolves with a live provider + Tier-1 digest cards still render), and the spend counter
 * lives in CANVAS_E2E_LLM_DIR (a throwaway temp dir), never a project folder. Restores an
 * uncapped config at the end so nothing downstream is throttled.
 *
 * ORDER: must run AFTER contextBrain (the uncapped summarize round-trip) — this probe
 * mutates then restores the cap, so any uncapped probe must precede it.
 */
export const contextBudget: E2EProbe = {
  name: 'context-budget',
  async run(ctx) {
    // Opt in to enforcement under the mock seam: set an explicit cap of 1.
    await ctx.evalIn<string>(
      "window.api.llm.setConfig({ provider: 'openrouter', model: 'google/gemini-2.0-flash-001', maxCallsPerDay: 1 }).then((r) => JSON.stringify(r))"
    )

    // First call fills cap 1; second is over it.
    await ctx.evalIn<string>(
      "window.api.llm.summarize({ text: 'budget-1' }).then((r) => JSON.stringify(r))"
    )
    const second = await ctx.evalIn<string>(
      "window.api.llm.summarize({ text: 'budget-2' }).then((r) => JSON.stringify(r))"
    )

    // App still usable: status resolves with a live provider, and Tier-1 digest cards
    // (seeded + rendered by the earlier `context` probe) are still in the DOM.
    const status = await ctx.evalIn<string>(
      'window.api.llm.status().then((s) => JSON.stringify(s))'
    )
    const cards = await ctx.evalIn<number>(
      "document.querySelectorAll('[data-test=digest-card]').length"
    )

    // Restore an uncapped config (no maxCallsPerDay) so later behaviour isn't throttled.
    await ctx.evalIn<string>(
      "window.api.llm.setConfig({ provider: 'openrouter', model: 'google/gemini-2.0-flash-001' }).then((r) => JSON.stringify(r))"
    )

    // MAIN-side: the spend counter lives in the e2e temp userData dir, not a project folder.
    const dir = process.env.CANVAS_E2E_LLM_DIR
    const counterInTempDir = !!dir && existsSync(join(dir, 'llm-budget.json'))

    let exceeded = false
    let usable = false
    try {
      exceeded = (JSON.parse(second) as { reason?: string }).reason === 'budget-exceeded'
      const s = JSON.parse(status) as { hasProvider?: boolean }
      usable = s.hasProvider === true && cards >= 1
    } catch {
      /* keep false */
    }

    return {
      name: 'context-budget',
      ok: exceeded && usable && counterInTempDir,
      detail: `second=${second} cards=${cards} counterInTempDir=${counterInTempDir}`
    }
  }
}
