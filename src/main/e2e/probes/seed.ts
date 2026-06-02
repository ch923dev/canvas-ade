/**
 * Final invariant: the playlist seeded exactly 4 boards (terminal + browser + planning +
 * dead-url browser) and every create/delete/duplicate restored its own count, so the
 * canvas ends where it started.
 */
import type { E2EProbe } from '../types'

export const seed: E2EProbe = {
  name: 'seed',
  async run(ctx) {
    const count = await ctx.evalIn<number>('window.__canvasE2E.getBoards().length')
    return { name: 'seed', ok: count === 4, detail: `${count} boards` }
  }
}
