/**
 * MCP lifecycle probes (M3). Drive the MAIN → renderer command channel the SAME way
 * the Orchestrator adapter does — by issuing a real frame-guarded `mcp:command`
 * through MAIN (NOT by calling the store directly) — so the probe exercises the true
 * round-trip: MAIN command → preload bridge → useMcpCommands applier → canvasStore.
 *
 * T3.1 (spawn): an `addBoard` command makes a terminal board appear on the canvas AND
 * in the MAIN-side mirror, and its shell (PTY) starts. Restores the seed baseline
 * (count back to 4) so later probes — and the final `seed` assertion — stay valid.
 */
import { ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import type { E2EProbe } from '../types'
import { sendMcpCommand } from '../../mcpCommand'
import { listBoardMirror } from '../../boardRegistry'

export const lifecycleSpawn: E2EProbe = {
  name: 'lifecycle-spawn',
  async run(ctx) {
    const id = randomUUID()
    // The exact path the orchestrator's registry.sendCommand uses (frame-guarded).
    const ack = await sendMcpCommand(ipcMain, () => ctx.win, {
      type: 'addBoard',
      board: { id, type: 'terminal' }
    })

    const onCanvas = await ctx.poll(
      () =>
        ctx.evalIn<boolean>(
          `window.__canvasE2E.getBoards().some((b) => b.id === ${JSON.stringify(id)} && b.type === 'terminal')`
        ),
      4000
    )
    // The agent-facing mirror (debounced publish ~150ms) must reflect the new board.
    const inMirror = await ctx.poll(async () => listBoardMirror().some((b) => b.id === id), 4000)
    // A freshly spawned terminal auto-starts its shell — assert the PTY pid exists.
    const shellUp = await ctx.poll(async () => ctx.dbg.terminalPid(id) !== null, 10000)

    // Restore baseline (close_board lands in T3.2; here use the store hook). Removing a
    // terminal board unmounts it → its PTY is reaped.
    await ctx.evalIn(`window.__canvasE2E.deleteBoard(${JSON.stringify(id)})`)
    const restored = await ctx.poll(
      () => ctx.evalIn<boolean>('window.__canvasE2E.getBoards().length === 4'),
      4000
    )

    const ok = ack.ok && onCanvas && inMirror && shellUp && restored
    return {
      name: 'lifecycle-spawn',
      ok,
      detail: ok
        ? 'mcp:command addBoard → terminal on canvas + in mirror + shell PTY up; baseline restored'
        : JSON.stringify({ ack, onCanvas, inMirror, shellUp, restored })
    }
  }
}
