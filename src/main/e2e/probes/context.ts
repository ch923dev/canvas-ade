import type { E2EProbe } from '../types'

/**
 * T-D2: the Tier-1 reopen digest panel. Seeds one board of each type, opens the panel
 * via the e2e hook, and asserts the rendered cards match the boards AND a card reflects
 * real board data (the terminal's launchCommand line). No LLM involved (Tier-1).
 */
export const context: E2EProbe = {
  name: 'context-digest',
  async run(ctx) {
    await ctx.evalIn<string>(
      "window.__canvasE2E.seedBoard('terminal', { launchCommand: 'pnpm dev' })"
    )
    await ctx.evalIn<string>("window.__canvasE2E.seedBoard('browser')")
    await ctx.evalIn<string>("window.__canvasE2E.seedBoard('planning')")
    await ctx.evalIn('window.__canvasE2E.openDigest()')

    const open = await ctx.poll(
      () =>
        ctx.evalIn<boolean>("!!document.querySelector('[data-test=digest-panel][data-open=true]')"),
      4000
    )
    const cards = await ctx.evalIn<number>(
      "document.querySelectorAll('[data-test=digest-card]').length"
    )
    const boards = await ctx.evalIn<number>('window.__canvasE2E.getBoards().length')
    const hasCmd = await ctx.evalIn<boolean>(
      "Array.from(document.querySelectorAll('[data-test=digest-card]')).some((c) => c.textContent.includes('Runs `pnpm dev`'))"
    )

    return {
      name: 'context-digest',
      ok: open && cards === boards && cards >= 3 && hasCmd,
      detail: `open=${open} cards=${cards} boards=${boards} cmd=${hasCmd}`
    }
  }
}
