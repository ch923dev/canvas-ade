/**
 * Full-view (modal) probes: the live-subtree portal relocation must keep a terminal's
 * PTY (same pid + scrollback) and a Browser's native view (same webContents id) alive
 * through enter/exit — never remount/close. Plus: other Browser views stay detached but
 * survive through a full-view mutation, Mobile renders as an aspect-correct letterboxed
 * emulator, and Esc from a focused terminal textarea still closes the chrome-less frame.
 */
import type { E2EProbe } from '../types'

// ── Bug 1 (full-view PTY survival): opening full view must RELOCATE the terminal's
// live subtree (stable portal host), not remount it — a remount tears down the PTY.
// Assert the SAME pid + intact scrollback after toggling full view on and back off.
// Pre-fix (inline↔portal ternary) this remounted → killTerminal + fresh pid. ──
export const terminalFullview: E2EProbe = {
  name: 'terminal-fullview',
  async run(ctx) {
    const termId = ctx.ids.termId!
    const fvPidBefore = ctx.dbg.terminalPid(termId)
    await ctx.evalIn(`window.__canvasE2E.setFullView(${JSON.stringify(termId)})`)
    await ctx.delay(400) // modal mounts + publishes host → BoardNode relocates the subtree
    const fvMounted = await ctx.evalIn<boolean>(
      `window.__canvasE2E.terminalMounted(${JSON.stringify(termId)})`
    )
    const fvText = await ctx.evalIn<string | null>(
      `window.__canvasE2E.readTerminal(${JSON.stringify(termId)})`
    )
    const fvPidDuring = ctx.dbg.terminalPid(termId)
    await ctx.evalIn('window.__canvasE2E.setFullView(null)')
    await ctx.delay(300)
    const fvPidAfter = ctx.dbg.terminalPid(termId)
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

// ── Bug 4 (full view ignores other browser views): with a live Browser board and a
// DIFFERENT board in full view, a store mutation (note/checklist edit) must NOT
// re-attach the browser's native view over the modal scrim. Pre-fix, reconcile's
// new-board path re-attached it (it never consulted fullViewId). Assert it stays
// detached THROUGH a mutation, then reattaches on exit (no leak). Also assert the
// other Browser's webContents SURVIVES (id retained in `views`) — destroying it would
// reset the board to board.url on full-view exit. ──
export const fullviewPreview: E2EProbe = {
  name: 'fullview-preview',
  async run(ctx) {
    const browserId = ctx.ids.browserId!
    // planId used to be seeded by the `planning` probe (migrated to Vitest + deleted in T3).
    // This is now the FIRST probe in the PLAYLIST that consumes it, so seed it here (idempotent
    // — the later whiteboard slivers reuse ctx.ids.planId via the same `??` guard).
    const planId =
      ctx.ids.planId ??
      (ctx.ids.planId = await ctx.evalIn<string>("window.__canvasE2E.seedBoard('planning')"))
    let fvPrevOk = false
    let fvPrevDetail = 'browser not live before full view'
    let fvSurviveOk = false
    let fvSurviveDetail = 'browser not live before full view'
    const browserLiveBefore = await ctx.poll(async () => {
      const rt = await ctx.evalIn<{ live: boolean } | null>(
        `window.__canvasE2E.getRuntime(${JSON.stringify(browserId)})`
      )
      return rt?.live === true
    }, 4000)
    if (browserLiveBefore) {
      await ctx.evalIn(`window.__canvasE2E.setFullView(${JSON.stringify(planId)})`)
      await ctx.delay(400) // applyLiveness full-view branch detaches the other browser view
      await ctx.evalIn(`window.__canvasE2E.addChecklist(${JSON.stringify(planId)})`) // mutate → reconcile (the bug path)
      await ctx.delay(400)
      const capDuring = await ctx.dbg.captureView(browserId)
      const rtDuring = await ctx.evalIn<{ live: boolean } | null>(
        `window.__canvasE2E.getRuntime(${JSON.stringify(browserId)})`
      )
      const survived = ctx.dbg.viewIds().includes(browserId)
      fvPrevOk = !capDuring.attached && rtDuring?.live !== true
      fvPrevDetail = fvPrevOk
        ? 'browser stayed detached through a full-view mutation'
        : `browser re-attached over modal (attached=${capDuring.attached} live=${rtDuring?.live})`
      fvSurviveOk = survived
      fvSurviveDetail = survived
        ? 'browser webContents survived full view (no reload on exit)'
        : 'browser webContents was closed during full view → resets to board.url on exit'
      await ctx.evalIn('window.__canvasE2E.setFullView(null)') // exit → browser reattaches
      await ctx.delay(300)
    }
    return [
      { name: 'fullview-preview', ok: fvPrevOk, detail: fvPrevDetail },
      { name: 'fullview-preserve', ok: fvSurviveOk, detail: fvSurviveDetail }
    ]
  }
}

// ── PREV-SELF: full-viewing the Browser board ITSELF must not restart it. Drive the
// REAL animated path (openFullViewAnimated) — the plain setFullView raw-setter skips
// the motion branch. Deterministic check: a close+reopen mints a NEW webContents id; a
// detach+reattach keeps the SAME one (the terminal pid-survival assertion, for the view). ──
export const fullviewSelfPreserve: E2EProbe = {
  name: 'fullview-self-preserve',
  async run(ctx) {
    const browserId = ctx.ids.browserId!
    const readStatus = async (): Promise<string | null> => {
      const rt = await ctx.evalIn<{ status: string } | null>(
        `window.__canvasE2E.getRuntime(${JSON.stringify(browserId)})`
      )
      return rt?.status ?? null
    }
    let selfOk = false
    let selfDetail = 'browser never reconnected before self-full-view'
    const reconnected = await ctx.poll(async () => (await readStatus()) === 'connected', 6000)
    if (reconnected) {
      const wcBefore = ctx.dbg.viewWebContentsId(browserId)
      await ctx.evalIn(`window.__canvasE2E.openFullViewAnimated(${JSON.stringify(browserId)})`)
      await ctx.delay(700) // enter tween settles (fullViewEntering → false)
      const wcDuring = ctx.dbg.viewWebContentsId(browserId)
      await ctx.evalIn('window.__canvasE2E.closeFullViewAnimated()')
      await ctx.delay(700) // exit tween + onExited → fullViewId cleared, view back on canvas
      const wcAfter = ctx.dbg.viewWebContentsId(browserId)
      const survivedSelf = wcBefore !== null && wcDuring === wcBefore && wcAfter === wcBefore
      selfOk = survivedSelf
      selfDetail = survivedSelf
        ? `full-viewing the browser kept the same webContents #${wcBefore} (no restart)`
        : `browser restarted across full view (wc before=${wcBefore} during=${wcDuring} after=${wcAfter})`
    }
    return { name: 'fullview-self-preserve', ok: selfOk, detail: selfDetail }
  }
}

// ── Full-view emulator: a Mobile/Tablet preset in full view must render as an
// aspect-correct device (height-bound, centred, letterboxed) — NOT stretched to fill
// the landscape modal. Set Mobile, full-view it, and assert the device frame keeps the
// preset's portrait aspect (~390/844) AND is clearly narrower than its stage (letterbox). ──
export const fullviewEmulator: E2EProbe = {
  name: 'fullview-emulator',
  async run(ctx) {
    const browserId = ctx.ids.browserId!
    await ctx.evalIn(
      `window.__canvasE2E.patchBoard(${JSON.stringify(browserId)}, { viewport: 'mobile' })`
    )
    await ctx.evalIn(`window.__canvasE2E.setFullView(${JSON.stringify(browserId)})`)
    await ctx.delay(450) // modal mounts + portal relocates the device frame + layout settles
    const emu = await ctx.evalIn<{
      found: boolean
      frameRatio: number
      stageRatio: number
      widthFrac: number
    }>(
      `(() => {
         const frame = document.querySelector('[data-bb-frame=' + JSON.stringify(${JSON.stringify(browserId)}) + ']');
         const stage = frame && frame.closest('.bb-stage');
         if (!frame || !stage) return { found: false, frameRatio: 0, stageRatio: 0, widthFrac: 0 };
         const f = frame.getBoundingClientRect();
         const s = stage.getBoundingClientRect();
         return {
           found: true,
           frameRatio: f.width / f.height,
           stageRatio: s.width / s.height,
           widthFrac: f.width / s.width
         };
       })()`
    )
    await ctx.evalIn('window.__canvasE2E.setFullView(null)')
    await ctx.delay(300)
    // Mobile preset aspect = 390/844 ≈ 0.462. Require portrait AND letterboxed (markedly
    // narrower than the landscape stage), not stretched to fill.
    const mobileRatio = 390 / 844
    const emuOk =
      emu.found &&
      Math.abs(emu.frameRatio - mobileRatio) < 0.06 &&
      emu.widthFrac < 0.9 &&
      emu.frameRatio < emu.stageRatio
    return {
      name: 'fullview-emulator',
      ok: emuOk,
      detail: emuOk
        ? 'Mobile full view is an aspect-correct, letterboxed emulator (not stretched)'
        : JSON.stringify(emu)
    }
  }
}

// ── Slice 5 (close-motion state machine) + Esc-through-typing fix: full view renders a
// chrome-less frame (no §6.1 band). Open via the hook, assert the frame mounts and the
// band is GONE, then FOCUS the full-view terminal's xterm helper textarea and dispatch
// Escape FROM IT (target=TEXTAREA) — the window Esc handler must still close full view
// despite the typing guard. Assert the modal is gone after the tween. ──
export const fullviewClose: E2EProbe = {
  name: 'fullview-close',
  async run(ctx) {
    const termId = ctx.ids.termId!
    await ctx.evalIn(`window.__canvasE2E.setFullView(${JSON.stringify(termId)})`)
    await ctx.delay(400) // modal mounts + enter tween settles
    const fvClose = await ctx.evalIn<{ frame: boolean; bandGone: boolean; typed: boolean }>(
      `(() => {
         const ta = document.querySelector('.fullview-host .xterm-helper-textarea');
         if (ta) ta.focus();
         const typing = document.activeElement?.tagName === 'TEXTAREA';
         (ta || document).dispatchEvent(
           new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
         );
         return {
           frame: !!document.querySelector('.fullview-scrim .fullview-frame .fullview-host'),
           bandGone: document.querySelector('.fullview-band') === null,
           typed: typing
         };
       })()`
    )
    await ctx.delay(400) // exit tween (200ms) + onExited unmount
    const fvCloseGone = await ctx.evalIn<boolean>(
      `document.querySelector('.fullview-scrim') === null`
    )
    const fvCloseOk = fvClose.frame && fvClose.bandGone && fvClose.typed && fvCloseGone
    return {
      name: 'fullview-close',
      ok: fvCloseOk,
      detail: fvCloseOk
        ? 'chrome-less frame (no band); Esc from focused terminal textarea closes + unmounts'
        : `frame=${fvClose.frame} bandGone=${fvClose.bandGone} typing=${fvClose.typed} closed=${fvCloseGone}`
    }
  }
}
