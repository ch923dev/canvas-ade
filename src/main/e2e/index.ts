/**
 * In-process board harness (CANVAS_SMOKE=e2e). MAIN seeds a typed fixture per GROUP through
 * the renderer hook (window.__canvasE2E), runs that group's probes against the fixture, then
 * tears the group down to an empty canvas before the next — so groups never leak into one
 * another. Between probes the runner asserts the group's board-count invariant (reset model C)
 * and hard-fails the group on violation instead of cascading.
 *
 * Emits one E2E_<NAME> marker per part + a final E2E_DONE, and returns a summary whose exitCode
 * the caller assigns to process.exitCode. Verified by running the command; not a vitest target.
 *
 * Markers go to stdout via bare console.log — safe because index.ts installs a process.stdout
 * 'error' handler (EPIPE swallow) before this runs whenever SMOKE is set.
 */
import type { BrowserWindow } from 'electron'
import { summarizeE2E, type E2EPart } from '../e2eReport'
import { makeContext, type E2ECtx } from './context'
import type { E2EGroup } from './types'
import { terminalGroup } from './groups/terminal'
import { browserGroup } from './groups/browser'
import { crossBoardGroup } from './groups/crossBoard'
import { planningGroup } from './groups/planning'
import { menuGroup } from './groups/menu'
import { layoutGroup } from './groups/layout'

// Groups run in this order; each tears down to empty, so the order is NOT load-bearing for
// correctness (no shared state survives a teardown). Listed terminal→layout for readability.
const GROUPS: E2EGroup<unknown>[] = [
  terminalGroup as E2EGroup<unknown>,
  browserGroup as E2EGroup<unknown>,
  crossBoardGroup as E2EGroup<unknown>,
  planningGroup as E2EGroup<unknown>,
  menuGroup as E2EGroup<unknown>,
  layoutGroup as E2EGroup<unknown>
]

async function boardCount(ctx: E2ECtx): Promise<number> {
  return ctx.evalIn<number>('window.__canvasE2E.getBoards().length')
}

export async function runE2ESmoke(win: BrowserWindow, localUrl: string): Promise<number> {
  const ctx = makeContext(win, localUrl)

  const hookReady = await ctx.poll(() => ctx.evalIn<boolean>('!!window.__canvasE2E'), 8000)
  if (!hookReady) {
    const s = summarizeE2E([
      { name: 'hook', ok: false, detail: 'window.__canvasE2E never appeared' }
    ])
    console.log(s.line)
    return s.exitCode
  }

  const parts: E2EPart[] = []
  for (const group of GROUPS) {
    const fixture = await group.setup(ctx)
    const baseline = await boardCount(ctx)
    for (const probe of group.probes) {
      const r = await probe.run(ctx, fixture)
      if (Array.isArray(r)) parts.push(...r)
      else parts.push(r)
      const now = await boardCount(ctx)
      if (now !== baseline) {
        parts.push({
          name: `${group.name}-fixture-broken`,
          ok: false,
          detail: `board count ${now} != baseline ${baseline} after probe '${probe.name}'`
        })
        break // stop this group; teardown still runs below
      }
    }
    await group.teardown(ctx, fixture)
  }

  // Every group tore down to empty → the canvas must be empty now (replaces the old `seed`
  // final-count probe).
  const finalCount = await boardCount(ctx)
  parts.push({
    name: 'canvas-empty',
    ok: finalCount === 0,
    detail: `${finalCount} boards remain after teardown`
  })

  const summary = summarizeE2E(parts)
  for (const p of parts) console.log(`E2E_${p.name.toUpperCase()} ${JSON.stringify(p)}`)
  console.log(summary.line)
  return summary.exitCode
}
