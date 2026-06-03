/**
 * MCP lifecycle probes (M3). Drive the MAIN → renderer command channel the SAME way
 * the Orchestrator adapter does — by issuing real frame-guarded `mcp:command`s through
 * MAIN (NOT by calling the store directly) — so the probe exercises the true
 * round-trip: MAIN command → preload bridge → useMcpCommands applier → canvasStore.
 *
 * - T3.1 spawn: an `addBoard` command makes a terminal appear on the canvas AND in the
 *   MAIN-side mirror, and its shell (PTY) starts.
 * - T3.3 configure: a `configureBoard` command changes a durable per-type key
 *   (launchCommand) through `updateBoard` (PATCHABLE_KEYS-filtered).
 * - T3.2 close: the real close path (graceful `drainPty` THEN a `removeBoard` command,
 *   exactly what the `closeBoard` adapter does) removes the board from the canvas + the
 *   mirror and reaps the PTY.
 *
 * Restores the seed baseline (count back to 4) so later probes — and the final `seed`
 * assertion — stay valid.
 */
import { ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import type { E2EProbe } from '../types'
import { sendMcpCommand } from '../../mcpCommand'
import { listBoardMirror } from '../../boardRegistry'
import { drainPty } from '../../pty'

export const lifecycleSpawnClose: E2EProbe = {
  name: 'lifecycle-spawn-close',
  async run(ctx) {
    const id = randomUUID()
    const inMirror = (): boolean => listBoardMirror().some((b) => b.id === id)
    const onCanvas = (): Promise<boolean> =>
      ctx.evalIn<boolean>(
        `window.__canvasE2E.getBoards().some((b) => b.id === ${JSON.stringify(id)})`
      )

    // ── T3.1 SPAWN — addBoard command (the exact path registry.sendCommand uses). ──
    const spawnAck = await sendMcpCommand(ipcMain, () => ctx.win, {
      type: 'addBoard',
      board: { id, type: 'terminal' }
    })
    const spawnedOnCanvas = await ctx.poll(
      () =>
        ctx.evalIn<boolean>(
          `window.__canvasE2E.getBoards().some((b) => b.id === ${JSON.stringify(id)} && b.type === 'terminal')`
        ),
      4000
    )
    const spawnedInMirror = await ctx.poll(async () => inMirror(), 4000)
    const shellUp = await ctx.poll(async () => ctx.dbg.terminalPid(id) !== null, 10000)

    // ── T3.3 CONFIGURE — configureBoard command changes a durable per-type key. ──
    const configAck = await sendMcpCommand(ipcMain, () => ctx.win, {
      type: 'configureBoard',
      id,
      patch: { launchCommand: 'echo CANVAS_E2E_CONFIGURED' }
    })
    const configApplied = await ctx.poll(
      () =>
        ctx.evalIn<boolean>(
          `(window.__canvasE2E.getBoards().find((b) => b.id === ${JSON.stringify(id)}) || {}).launchCommand === 'echo CANVAS_E2E_CONFIGURED'`
        ),
      4000
    )

    // ── T3.2 CLOSE — graceful drain, THEN a removeBoard command (the closeBoard path). ──
    await drainPty(id)
    const closeAck = await sendMcpCommand(ipcMain, () => ctx.win, { type: 'removeBoard', id })
    const goneFromCanvas = await ctx.poll(async () => !(await onCanvas()), 4000)
    const goneFromMirror = await ctx.poll(async () => !inMirror(), 4000)
    const ptyReaped = await ctx.poll(async () => ctx.dbg.terminalPid(id) === null, 6000)
    const restored = await ctx.poll(
      () => ctx.evalIn<boolean>('window.__canvasE2E.getBoards().length === 4'),
      4000
    )

    const ok =
      spawnAck.ok &&
      spawnedOnCanvas &&
      spawnedInMirror &&
      shellUp &&
      configAck.ok &&
      configApplied &&
      closeAck.ok &&
      goneFromCanvas &&
      goneFromMirror &&
      ptyReaped &&
      restored
    return {
      name: 'lifecycle-spawn-close',
      ok,
      detail: ok
        ? 'spawn: addBoard → canvas + mirror + shell PTY up; configure: launchCommand changed; close: drain → removeBoard → gone + PTY reaped; baseline 4'
        : JSON.stringify({
            spawnAck,
            spawnedOnCanvas,
            spawnedInMirror,
            shellUp,
            configAck,
            configApplied,
            closeAck,
            goneFromCanvas,
            goneFromMirror,
            ptyReaped,
            restored
          })
    }
  }
}
