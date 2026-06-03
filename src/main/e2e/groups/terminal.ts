/**
 * Terminal-board fixture group: one terminal seeded with a sentinel launchCommand.
 * Probes assert the PTY↔xterm data plane, the Configure nowheel guard, LOD survival,
 * config respawn, park/adopt-on-undo, and full-view PTY survival + chrome-less Esc close.
 */
import type { E2EGroup, GroupProbe } from '../types'

export interface TerminalFixture {
  termId: string
}

const seedTerminal: E2EGroup<TerminalFixture>['setup'] = async (ctx) => {
  const termId = await ctx.evalIn<string>(
    `window.__canvasE2E.seedBoard('terminal', { launchCommand: 'echo ${ctx.TERM_SENTINEL}' })`
  )
  return { termId }
}

export const terminal: GroupProbe<TerminalFixture> = {
  name: 'terminal',
  async run(ctx, fx) {
    const termOk = await ctx.poll(async () => {
      const text = await ctx.evalIn<string | null>(
        `window.__canvasE2E.readTerminal(${JSON.stringify(fx.termId)})`
      )
      return typeof text === 'string' && text.includes(ctx.TERM_SENTINEL)
    }, 10000)
    return { name: 'terminal', ok: termOk, detail: termOk ? 'sentinel in framebuffer' : 'no sentinel' }
  }
}

// ── Bug 7 (config-scroll ghost): the terminal Configure popover must carry React Flow's
// `nowheel` opt-out so scrolling it doesn't pan the canvas (a pan moves live native views
// → ghost). Open the config and assert the popover is a `.nowheel` element (the fix). ──
export const configNowheel: GroupProbe<TerminalFixture> = {
  name: 'config-nowheel',
  async run(ctx, fx) {
    await ctx.evalIn(`window.__canvasE2E.fitView(${JSON.stringify(fx.termId)})`)
    await ctx.evalIn('window.__canvasE2E.setZoom(1)')
    await ctx.delay(150)
    const cfgOk = await ctx.evalIn<boolean>(
      `(async () => {
         const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
         const node = document.querySelector('.react-flow__node[data-id="${fx.termId}"]');
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

// ── Bug 1 (full-view PTY survival): opening full view must RELOCATE the terminal's
// live subtree (stable portal host), not remount it — a remount tears down the PTY.
// Assert the SAME pid + intact scrollback after toggling full view on and back off.
// Pre-fix (inline↔portal ternary) this remounted → killTerminal + fresh pid. ──
export const terminalFullview: GroupProbe<TerminalFixture> = {
  name: 'terminal-fullview',
  async run(ctx, fx) {
    const fvPidBefore = ctx.dbg.terminalPid(fx.termId)
    await ctx.evalIn(`window.__canvasE2E.setFullView(${JSON.stringify(fx.termId)})`)
    await ctx.delay(400) // modal mounts + publishes host → BoardNode relocates the subtree
    const fvMounted = await ctx.evalIn<boolean>(
      `window.__canvasE2E.terminalMounted(${JSON.stringify(fx.termId)})`
    )
    const fvText = await ctx.evalIn<string | null>(
      `window.__canvasE2E.readTerminal(${JSON.stringify(fx.termId)})`
    )
    const fvPidDuring = ctx.dbg.terminalPid(fx.termId)
    await ctx.evalIn('window.__canvasE2E.setFullView(null)')
    await ctx.delay(300)
    const fvPidAfter = ctx.dbg.terminalPid(fx.termId)
    const fvOk =
      fvMounted &&
      fvPidBefore !== null &&
      fvPidDuring === fvPidBefore &&
      fvPidAfter === fvPidBefore &&
      typeof fvText === 'string' &&
      fvText.includes(ctx.TERM_SENTINEL)
    return {
      name: 'terminal-fullview',
      ok: fvOk,
      detail: fvOk
        ? `same pid ${fvPidBefore} survived full view + scrollback intact`
        : `pid before=${fvPidBefore} during=${fvPidDuring} after=${fvPidAfter} mounted=${fvMounted}`
    }
  }
}

// ── Slice 5 (close-motion state machine) + Esc-through-typing fix: full view renders a
// chrome-less frame (no §6.1 band). Open via the hook, assert the frame mounts and the
// band is GONE, then FOCUS the full-view terminal's xterm helper textarea and dispatch
// Escape FROM IT (target=TEXTAREA) — the window Esc handler must still close full view
// despite the typing guard. Assert the modal is gone after the tween. ──
export const fullviewClose: GroupProbe<TerminalFixture> = {
  name: 'fullview-close',
  async run(ctx, fx) {
    await ctx.evalIn(`window.__canvasE2E.setFullView(${JSON.stringify(fx.termId)})`)
    await ctx.delay(400) // modal mounts + enter tween settles
    const pre = await ctx.evalIn<{ frame: boolean; bandGone: boolean; typed: boolean }>(
      `(() => {
         const ta = document.querySelector('.fullview-host .xterm-helper-textarea');
         if (ta) ta.focus();
         const typing = document.activeElement?.tagName === 'TEXTAREA';
         return {
           frame: !!document.querySelector('.fullview-scrim .fullview-frame .fullview-host'),
           bandGone: document.querySelector('.fullview-band') === null,
           typed: typing
         };
       })()`
    )
    await ctx.realKey('Escape') // real OS Escape from the focused xterm textarea (was synthetic)
    await ctx.delay(400) // exit tween (200ms) + onExited unmount
    const closed = await ctx.evalIn<boolean>(`document.querySelector('.fullview-scrim') === null`)
    const ok = pre.frame && pre.bandGone && pre.typed && closed
    return {
      name: 'fullview-close',
      ok,
      detail: ok
        ? 'chrome-less frame (no band); real Esc from focused terminal textarea closes + unmounts'
        : `frame=${pre.frame} bandGone=${pre.bandGone} typing=${pre.typed} closed=${closed}`
    }
  }
}

// ── Fix #2 (LOD-survival): zooming below LOD must NOT unmount the terminal and
// kill its PTY. e2eTerminals registration tracks the xterm mount, so the board
// staying mounted across LOD proves the session survives (pre-fix BoardNode
// early-returned a LOD card → TerminalBoard unmounted → registration dropped). ──
export const terminalLod: GroupProbe<TerminalFixture> = {
  name: 'terminal-lod',
  async run(ctx, fx) {
    await ctx.evalIn('window.__canvasE2E.setZoom(0.2)') // < LOD_ZOOM (0.4)
    const lodAlive = await ctx.poll(
      () => ctx.evalIn<boolean>(`window.__canvasE2E.terminalMounted(${JSON.stringify(fx.termId)})`),
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
export const terminalRespawn: GroupProbe<TerminalFixture> = {
  name: 'terminal-respawn',
  async run(ctx, fx) {
    await ctx.evalIn('window.__canvasE2E.setZoom(1)')
    await ctx.evalIn(
      `window.__canvasE2E.patchBoard(${JSON.stringify(fx.termId)}, { launchCommand: 'echo ${ctx.TERM_SENTINEL2}' })`
    )
    const respawnOk = await ctx.poll(async () => {
      const text = await ctx.evalIn<string | null>(
        `window.__canvasE2E.readTerminal(${JSON.stringify(fx.termId)})`
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
export const terminalAdopt: GroupProbe<TerminalFixture> = {
  name: 'terminal-adopt',
  async run(ctx, fx) {
    await ctx.evalIn('window.__canvasE2E.setZoom(1)')
    ctx.dbg.writeTerminal(fx.termId, `echo ${ctx.ADOPT_MARKER}\r`)
    const markerSeen = await ctx.poll(async () => {
      const text = await ctx.evalIn<string | null>(
        `window.__canvasE2E.readTerminal(${JSON.stringify(fx.termId)})`
      )
      return typeof text === 'string' && text.includes(ctx.ADOPT_MARKER)
    }, 8000)
    const pidBefore = ctx.dbg.terminalPid(fx.termId)
    await ctx.evalIn(`window.__canvasE2E.deleteBoard(${JSON.stringify(fx.termId)})`)
    await ctx.delay(200) // let the unmount + park settle
    await ctx.evalIn('window.__canvasE2E.undo()')
    const adoptedOk = await ctx.poll(async () => {
      const pidNow = ctx.dbg.terminalPid(fx.termId)
      const text = await ctx.evalIn<string | null>(
        `window.__canvasE2E.readTerminal(${JSON.stringify(fx.termId)})`
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

export const terminalGroup: E2EGroup<TerminalFixture> = {
  name: 'terminal',
  setup: seedTerminal,
  probes: [terminal, configNowheel, terminalFullview, fullviewClose, terminalLod, terminalRespawn, terminalAdopt],
  teardown: async (ctx) => {
    await ctx.evalIn('window.__canvasE2E.clearAllBoards()')
  }
}
