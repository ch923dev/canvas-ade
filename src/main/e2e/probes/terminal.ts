/**
 * Terminal-board probes: PTY↔xterm data plane, the Configure-popover nowheel guard,
 * LOD-survival (zoom-out must not unmount + kill the PTY), config-respawn under the
 * same id, and park/adopt-on-undo (same pid + replayed scrollback).
 */
import type { E2EProbe } from '../types'

/** Seed a terminal whose launchCommand echoes the sentinel; read it off the framebuffer. */
export const terminal: E2EProbe = {
  name: 'terminal',
  async run(ctx) {
    const termId = await ctx.evalIn<string>(
      `window.__canvasE2E.seedBoard('terminal', { launchCommand: 'echo ${ctx.TERM_SENTINEL}' })`
    )
    ctx.ids.termId = termId
    const termOk = await ctx.poll(async () => {
      const text = await ctx.evalIn<string | null>(
        `window.__canvasE2E.readTerminal(${JSON.stringify(termId)})`
      )
      return typeof text === 'string' && text.includes(ctx.TERM_SENTINEL)
    }, 10000)
    return {
      name: 'terminal',
      ok: termOk,
      detail: termOk ? 'sentinel in framebuffer' : 'no sentinel'
    }
  }
}

// ── Bug 7 (config-scroll ghost): the terminal Configure popover must carry React Flow's
// `nowheel` opt-out so scrolling it doesn't pan the canvas (a pan moves live native views
// → ghost). Open the config and assert the popover is a `.nowheel` element (the fix). ──
export const configNowheel: E2EProbe = {
  name: 'config-nowheel',
  async run(ctx) {
    const termId = ctx.ids.termId!
    await ctx.evalIn(`window.__canvasE2E.fitView(${JSON.stringify(termId)})`)
    await ctx.evalIn('window.__canvasE2E.setZoom(1)')
    await ctx.delay(150)
    const cfgOk = await ctx.evalIn<boolean>(
      `(async () => {
         const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
         const node = document.querySelector('.react-flow__node[data-id="${termId}"]');
         const cfgBtn = node && node.querySelector('button[title="Configure terminal"]');
         if (!cfgBtn) return false;
         cfgBtn.click(); await sleep(150);
         const ok = !!document.querySelector('.nowheel select'); // the config popover (nowheel) holds the Shell <select>
         cfgBtn.click(); // close
         return ok;
       })()`
    )
    return {
      name: 'config-nowheel',
      ok: cfgOk,
      detail: cfgOk
        ? 'config popover has nowheel (no pan on scroll)'
        : 'config popover missing nowheel'
    }
  }
}

// ── Fix #2 (LOD-survival): zooming below LOD must NOT unmount the terminal and
// kill its PTY. e2eTerminals registration tracks the xterm mount, so the board
// staying mounted across LOD proves the session survives (pre-fix BoardNode
// early-returned a LOD card → TerminalBoard unmounted → registration dropped). ──
export const terminalLod: E2EProbe = {
  name: 'terminal-lod',
  async run(ctx) {
    const termId = ctx.ids.termId!
    await ctx.evalIn('window.__canvasE2E.setZoom(0.2)') // < LOD_ZOOM (0.4)
    const lodAlive = await ctx.poll(
      () => ctx.evalIn<boolean>(`window.__canvasE2E.terminalMounted(${JSON.stringify(termId)})`),
      3000
    )
    return {
      name: 'terminal-lod',
      ok: lodAlive,
      detail: lodAlive ? 'mounted across LOD (session alive)' : 'unmounted at LOD (PTY killed)'
    }
  }
}

// ── Fix #1 (restart/config respawn): changing launchCommand tears the old PTY
// down and spawns a new one under the SAME board id — the path that raced. The
// new session must come up and echo a fresh sentinel (a stale old-process onExit
// must not reap it). Restore zoom first so xterm relayouts before reading. ──
export const terminalRespawn: E2EProbe = {
  name: 'terminal-respawn',
  async run(ctx) {
    const termId = ctx.ids.termId!
    await ctx.evalIn('window.__canvasE2E.setZoom(1)')
    await ctx.evalIn(
      `window.__canvasE2E.patchBoard(${JSON.stringify(termId)}, { launchCommand: 'echo ${ctx.TERM_SENTINEL2}' })`
    )
    const respawnOk = await ctx.poll(async () => {
      const text = await ctx.evalIn<string | null>(
        `window.__canvasE2E.readTerminal(${JSON.stringify(termId)})`
      )
      return typeof text === 'string' && text.includes(ctx.TERM_SENTINEL2)
    }, 10000)
    return {
      name: 'terminal-respawn',
      ok: respawnOk,
      detail: respawnOk ? 'new session echoed after respawn' : 'respawned session not alive'
    }
  }
}

// ── #15 (park/adopt on undo): write a unique marker into the live terminal,
// capture its pid, delete the board (parks the session), undo (adopts it), then
// assert the SAME pid is back AND the marker replayed from the buffer — a fresh
// spawn would have neither. Restore zoom first so the re-mounted xterm lays out. ──
export const terminalAdopt: E2EProbe = {
  name: 'terminal-adopt',
  async run(ctx) {
    const termId = ctx.ids.termId!
    await ctx.evalIn('window.__canvasE2E.setZoom(1)')
    ctx.dbg.writeTerminal(termId, `echo ${ctx.ADOPT_MARKER}\r`)
    const markerSeen = await ctx.poll(async () => {
      const text = await ctx.evalIn<string | null>(
        `window.__canvasE2E.readTerminal(${JSON.stringify(termId)})`
      )
      return typeof text === 'string' && text.includes(ctx.ADOPT_MARKER)
    }, 8000)
    const pidBefore = ctx.dbg.terminalPid(termId)
    await ctx.evalIn(`window.__canvasE2E.deleteBoard(${JSON.stringify(termId)})`)
    await ctx.delay(200) // let the unmount + park settle
    await ctx.evalIn('window.__canvasE2E.undo()')
    const adoptedOk = await ctx.poll(async () => {
      const pidNow = ctx.dbg.terminalPid(termId)
      const text = await ctx.evalIn<string | null>(
        `window.__canvasE2E.readTerminal(${JSON.stringify(termId)})`
      )
      return (
        pidNow !== null &&
        pidBefore !== null &&
        pidNow === pidBefore &&
        typeof text === 'string' &&
        text.includes(ctx.ADOPT_MARKER)
      )
    }, 10000)
    return {
      name: 'terminal-adopt',
      ok: markerSeen && adoptedOk,
      detail:
        markerSeen && adoptedOk
          ? `same pid ${pidBefore} + scrollback replayed after undo`
          : `markerSeen=${markerSeen} pidBefore=${pidBefore} adoptedOk=${adoptedOk}`
    }
  }
}
