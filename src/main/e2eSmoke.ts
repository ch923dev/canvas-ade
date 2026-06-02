/**
 * In-process board harness (CANVAS_SMOKE=e2e). MAIN seeds one of each board type
 * through the renderer hook (window.__canvasE2E) and asserts each works at runtime,
 * INCLUDING the Browser native WebContentsView layer that mainWindow.capturePage()
 * cannot see (asserted here via the preview manager's own per-view capturePage).
 *
 * Emits one marker line per board + a final E2E_DONE, and returns a summary whose
 * exitCode the caller assigns to process.exitCode. Verified by running the command;
 * not a vitest target (needs the live Electron runtime).
 */
import type { BrowserWindow } from 'electron'
import { summarizeE2E, type E2EPart } from './e2eReport'
import { debugCaptureView, debugViewIds, debugViewWebContentsId } from './preview'
import { debugTerminalPid, debugWriteTerminal } from './pty'

// Markers go to stdout via bare console.log — safe here because index.ts installs a
// process.stdout 'error' handler (EPIPE swallow) before this runs whenever SMOKE is set.

/** Sentinel echoed into a terminal board to prove the PTY↔xterm data plane. */
export const TERM_SENTINEL = 'CANVAS_E2E_TERM_OK'

/** Second sentinel — proves a respawned (config-changed) session is live (fix #1). */
export const TERM_SENTINEL2 = 'CANVAS_E2E_RESPAWN_OK'

function evalIn<T>(win: BrowserWindow, expr: string): Promise<T> {
  return win.webContents.executeJavaScript(expr, true) as Promise<T>
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Poll `fn` until it resolves truthy or the timeout elapses. */
async function poll(fn: () => Promise<boolean>, timeoutMs: number, stepMs = 120): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await fn()) return true
    if (Date.now() > deadline) return false
    await delay(stepMs)
  }
}

export async function runE2ESmoke(win: BrowserWindow, localUrl: string): Promise<number> {
  const parts: E2EPart[] = []

  // The hook installs after React mounts — wait for it before driving anything.
  const hookReady = await poll(() => evalIn<boolean>(win, '!!window.__canvasE2E'), 8000)
  if (!hookReady) {
    const s = summarizeE2E([
      { name: 'hook', ok: false, detail: 'window.__canvasE2E never appeared' }
    ])
    console.log(s.line)
    return s.exitCode
  }

  // Seed + assert one of each board type, plus a final 3-board count check. Each
  // block pushes its E2EPart; the summary decides the overall pass/fail + exit code.

  // ── Terminal: seed with a launchCommand that echoes the sentinel, then read it
  // back off the xterm framebuffer (proves the PTY↔xterm data plane end to end). ──
  const termId = await evalIn<string>(
    win,
    `window.__canvasE2E.seedBoard('terminal', { launchCommand: 'echo ${TERM_SENTINEL}' })`
  )
  const termOk = await poll(async () => {
    const text = await evalIn<string | null>(
      win,
      `window.__canvasE2E.readTerminal(${JSON.stringify(termId)})`
    )
    return typeof text === 'string' && text.includes(TERM_SENTINEL)
  }, 10000)
  parts.push({
    name: 'terminal',
    ok: termOk,
    detail: termOk ? 'sentinel in framebuffer' : 'no sentinel'
  })

  // ── Bug 1 (full-view PTY survival): opening full view must RELOCATE the terminal's
  // live subtree (stable portal host), not remount it — a remount tears down the PTY.
  // Assert the SAME pid + intact scrollback after toggling full view on and back off.
  // Pre-fix (inline↔portal ternary) this remounted → killTerminal + fresh pid. ──
  const fvPidBefore = debugTerminalPid(termId)
  await evalIn(win, `window.__canvasE2E.setFullView(${JSON.stringify(termId)})`)
  await delay(400) // modal mounts + publishes host → BoardNode relocates the subtree
  const fvMounted = await evalIn<boolean>(
    win,
    `window.__canvasE2E.terminalMounted(${JSON.stringify(termId)})`
  )
  const fvText = await evalIn<string | null>(
    win,
    `window.__canvasE2E.readTerminal(${JSON.stringify(termId)})`
  )
  const fvPidDuring = debugTerminalPid(termId)
  await evalIn(win, 'window.__canvasE2E.setFullView(null)')
  await delay(300)
  const fvPidAfter = debugTerminalPid(termId)
  const fvOk =
    fvMounted &&
    fvPidBefore !== null &&
    fvPidDuring === fvPidBefore &&
    fvPidAfter === fvPidBefore &&
    typeof fvText === 'string' &&
    fvText.includes(TERM_SENTINEL)
  parts.push({
    name: 'terminal-fullview',
    ok: fvOk,
    detail: fvOk
      ? `same pid ${fvPidBefore} survived full view + scrollback intact`
      : `pid before=${fvPidBefore} during=${fvPidDuring} after=${fvPidAfter} mounted=${fvMounted}`
  })

  // ── Browser: seed pointing at the in-process localServer (deterministic), fit the
  // camera to it (forces zoom ≥ LOD so the native view attaches), wait for the
  // connected status, then assert a NON-BLANK per-view capturePage (the gap). ──
  const browserId = await evalIn<string>(
    win,
    `window.__canvasE2E.seedBoard('browser', { url: ${JSON.stringify(localUrl)} })`
  )
  await delay(150) // let React Flow mount + measure the new node before fitView
  await evalIn(win, `window.__canvasE2E.fitView(${JSON.stringify(browserId)})`)
  const connected = await poll(async () => {
    const rt = await evalIn<{ status: string; live: boolean } | null>(
      win,
      `window.__canvasE2E.getRuntime(${JSON.stringify(browserId)})`
    )
    return rt?.status === 'connected' && rt.live === true
  }, 10000)
  let capDetail = 'not connected'
  let browserOk = false
  if (connected) {
    // Brief pause after connected: the view needs at least one paint before
    // capturePage yields non-blank pixels.
    await delay(300)
    const cap = await debugCaptureView(browserId)
    browserOk = cap.attached && !cap.empty
    capDetail = `attached=${cap.attached} empty=${cap.empty}`
  }
  parts.push({ name: 'browser', ok: browserOk, detail: capDetail })

  // ── Occlusion fix (node-drag/resize detach): a node gesture must DETACH every live
  // native view to its HTML snapshot — a native WebContentsView paints above all HTML,
  // so without this a board dragged over a live Browser board is occluded by it. Drive
  // previewStore.nodeGesture and assert the live flag drops on start, restores on end. ──
  let gestureDetail = 'browser not live'
  let gestureOk = false
  if (browserOk) {
    await evalIn(win, 'window.__canvasE2E.setGesture(true)')
    const detached = await poll(async () => {
      const rt = await evalIn<{ live: boolean } | null>(
        win,
        `window.__canvasE2E.getRuntime(${JSON.stringify(browserId)})`
      )
      return rt?.live === false
    }, 5000)
    await evalIn(win, 'window.__canvasE2E.setGesture(false)')
    const reattached = await poll(async () => {
      const rt = await evalIn<{ live: boolean } | null>(
        win,
        `window.__canvasE2E.getRuntime(${JSON.stringify(browserId)})`
      )
      return rt?.live === true
    }, 8000)
    gestureOk = detached && reattached
    gestureDetail = `detached=${detached} reattached=${reattached}`
  }
  parts.push({ name: 'browser-gesture', ok: gestureOk, detail: gestureDetail })

  // ── Bug 2 (focus webview ghost): double-clicking a terminal focuses it (animated
  // fitView). A live Browser elsewhere must DETACH cleanly for the focus (no native view
  // left attached → the #43961 ghost) and REATTACH on unfocus. The compositor pixel isn't
  // code-assertable, but the detach/reattach invariant the fix preserves is. ──
  let focusOk = false
  let focusDetail = 'browser not live before focus'
  if (browserOk) {
    await evalIn(win, `window.__canvasE2E.fitView(${JSON.stringify(browserId)})`)
    await poll(async () => {
      const rt = await evalIn<{ live: boolean } | null>(
        win,
        `window.__canvasE2E.getRuntime(${JSON.stringify(browserId)})`
      )
      return rt?.live === true
    }, 5000)
    await evalIn(win, `window.__canvasE2E.setFocus(${JSON.stringify(termId)})`) // focus the terminal
    await delay(500) // focus effect → applyLiveness demotes the non-focused browser
    const capFocused = await debugCaptureView(browserId)
    const detachedOnFocus = !capFocused.attached
    await evalIn(win, 'window.__canvasE2E.setFocus(null)') // clear focus → browser reattaches
    await evalIn(win, `window.__canvasE2E.fitView(${JSON.stringify(browserId)})`)
    const reattached = await poll(async () => {
      const rt = await evalIn<{ live: boolean } | null>(
        win,
        `window.__canvasE2E.getRuntime(${JSON.stringify(browserId)})`
      )
      return rt?.live === true
    }, 8000)
    focusOk = detachedOnFocus && reattached
    focusDetail = `detachedOnFocus=${detachedOnFocus} reattached=${reattached}`
  }
  parts.push({
    name: 'focus-detach',
    ok: focusOk,
    detail: focusOk ? 'browser detached on terminal focus, reattached on unfocus' : focusDetail
  })

  // ── Bug 7 (config-scroll ghost): the terminal Configure popover must carry React Flow's
  // `nowheel` opt-out so scrolling it doesn't pan the canvas (a pan moves live native views
  // → ghost). Open the config and assert the popover is a `.nowheel` element (the fix). ──
  await evalIn(win, `window.__canvasE2E.fitView(${JSON.stringify(termId)})`)
  await evalIn(win, 'window.__canvasE2E.setZoom(1)')
  await delay(150)
  const cfgOk = await evalIn<boolean>(
    win,
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
  parts.push({
    name: 'config-nowheel',
    ok: cfgOk,
    detail: cfgOk ? 'config popover has nowheel (no pan on scroll)' : 'config popover missing nowheel'
  })

  // ── Planning: seed, add a checklist element, assert it persisted on the board AND
  // that the whole canvas round-trips through the schema (persistence-readiness). ──
  const planId = await evalIn<string>(win, "window.__canvasE2E.seedBoard('planning')")
  await evalIn(win, `window.__canvasE2E.addChecklist(${JSON.stringify(planId)})`)
  const planProbe = await evalIn<{ kinds: string[]; roundTrip: boolean }>(
    win,
    `(() => {
       const b = window.__canvasE2E.getBoards().find((x) => x.id === ${JSON.stringify(planId)});
       const kinds = b && b.type === 'planning' ? b.elements.map((e) => e.kind) : [];
       return { kinds, roundTrip: window.__canvasE2E.roundTripOk() };
     })()`
  )
  const planOk = planProbe.kinds.includes('checklist') && planProbe.roundTrip
  parts.push({
    name: 'planning',
    ok: planOk,
    detail: `elements=[${planProbe.kinds.join(',')}] roundTrip=${planProbe.roundTrip}`
  })

  // ── Bug 4 (full view ignores other browser views): with a live Browser board and a
  // DIFFERENT board in full view, a store mutation (note/checklist edit) must NOT
  // re-attach the browser's native view over the modal scrim. Pre-fix, reconcile's
  // new-board path re-attached it (it never consulted fullViewId). Assert it stays
  // detached THROUGH a mutation, then reattaches on exit (no leak). ──
  let fvPrevOk = false
  let fvPrevDetail = 'browser not live before full view'
  // PREV-STATE: full-viewing a DIFFERENT board must DETACH the other Browser's native view
  // (not painting over the modal), but NOT destroy its webContents — destroying it discards
  // the page's navigated state, so on full-view EXIT the board reloads at its persisted
  // board.url instead of the page the user navigated to (the full-view-resets-other-browser
  // bug). Assert the view stays DETACHED through a full-view mutation (no modal occlusion)
  // AND survives in the main-side `views` map (its renderer is not closed). debugViewIds is
  // the clean discriminator: close → id gone; detach → id retained. (Independent of the
  // flaky capturePage.)
  let fvSurviveOk = false
  let fvSurviveDetail = 'browser not live before full view'
  const browserLiveBefore = await poll(async () => {
    const rt = await evalIn<{ live: boolean } | null>(
      win,
      `window.__canvasE2E.getRuntime(${JSON.stringify(browserId)})`
    )
    return rt?.live === true
  }, 4000)
  if (browserLiveBefore) {
    await evalIn(win, `window.__canvasE2E.setFullView(${JSON.stringify(planId)})`)
    await delay(400) // applyLiveness full-view branch detaches the other browser view
    await evalIn(win, `window.__canvasE2E.addChecklist(${JSON.stringify(planId)})`) // mutate → reconcile (the bug path)
    await delay(400)
    const capDuring = await debugCaptureView(browserId)
    const rtDuring = await evalIn<{ live: boolean } | null>(
      win,
      `window.__canvasE2E.getRuntime(${JSON.stringify(browserId)})`
    )
    // The other browser's webContents must NOT have been closed (its id stays in `views`),
    // so its navigated page state survives the full-view session and no reload happens on exit.
    const survived = debugViewIds().includes(browserId)
    fvPrevOk = !capDuring.attached && rtDuring?.live !== true
    fvPrevDetail = fvPrevOk
      ? 'browser stayed detached through a full-view mutation'
      : `browser re-attached over modal (attached=${capDuring.attached} live=${rtDuring?.live})`
    fvSurviveOk = survived
    fvSurviveDetail = survived
      ? 'browser webContents survived full view (no reload on exit)'
      : 'browser webContents was closed during full view → resets to board.url on exit'
    await evalIn(win, 'window.__canvasE2E.setFullView(null)') // exit → browser reattaches
    await delay(300)
  }
  parts.push({ name: 'fullview-preview', ok: fvPrevOk, detail: fvPrevDetail })
  parts.push({ name: 'fullview-preserve', ok: fvSurviveOk, detail: fvSurviveDetail })

  // ── PREV-SELF: full-viewing the Browser board ITSELF must not restart it. The fvId
  // branch holds the view across the enter/exit MOTION tween — but via closeBoard (a real
  // webContents.close), which discards the page; on settle attachBoard re-OPENs it at
  // board.url, snapping the user's navigated page back to the root (the inverse of the
  // other-board reset). Must drive the REAL animated path (openFullViewAnimated) — the
  // plain setFullView raw-setter never sets fullViewEntering, so it skips the motion branch
  // entirely and can't see this bug. Deterministic check (no status-blip timing): the live
  // webContents id. A close+reopen mints a NEW id; a detach+reattach keeps the SAME one —
  // exactly the terminal pid-survival assertion, applied to the native view. ──
  const readStatus = async (): Promise<string | null> => {
    const rt = await evalIn<{ status: string } | null>(
      win,
      `window.__canvasE2E.getRuntime(${JSON.stringify(browserId)})`
    )
    return rt?.status ?? null
  }
  let selfOk = false
  let selfDetail = 'browser never reconnected before self-full-view'
  const reconnected = await poll(async () => (await readStatus()) === 'connected', 6000)
  if (reconnected) {
    const wcBefore = debugViewWebContentsId(browserId)
    await evalIn(win, `window.__canvasE2E.openFullViewAnimated(${JSON.stringify(browserId)})`)
    await delay(700) // enter tween settles (fullViewEntering → false)
    const wcDuring = debugViewWebContentsId(browserId)
    await evalIn(win, 'window.__canvasE2E.closeFullViewAnimated()')
    await delay(700) // exit tween + onExited → fullViewId cleared, view back on canvas
    const wcAfter = debugViewWebContentsId(browserId)
    // Same webContents id throughout = the view was detached/reattached, never closed, so
    // the page (and its navigated state) survived. Any change/null = it was destroyed+reopened.
    const survivedSelf =
      wcBefore !== null && wcDuring === wcBefore && wcAfter === wcBefore
    selfOk = survivedSelf
    selfDetail = survivedSelf
      ? `full-viewing the browser kept the same webContents #${wcBefore} (no restart)`
      : `browser restarted across full view (wc before=${wcBefore} during=${wcDuring} after=${wcAfter})`
  }
  parts.push({ name: 'fullview-self-preserve', ok: selfOk, detail: selfDetail })

  // ── Full-view emulator: a Mobile/Tablet preset in full view must render as an
  // aspect-correct device (height-bound, centred, letterboxed) — NOT stretched to fill
  // the landscape modal. Set the browser to Mobile, full-view it, and assert the relocated
  // device frame keeps the preset's portrait aspect (~390/844) AND is clearly narrower than
  // its stage (letterbox). Pre-fix (inset:0) the frame fills the stage → landscape aspect,
  // ~full width → both checks fail. ──
  await evalIn(win, `window.__canvasE2E.patchBoard(${JSON.stringify(browserId)}, { viewport: 'mobile' })`)
  await evalIn(win, `window.__canvasE2E.setFullView(${JSON.stringify(browserId)})`)
  await delay(450) // modal mounts + portal relocates the device frame + layout settles
  const emu = await evalIn<{
    found: boolean
    frameRatio: number
    stageRatio: number
    widthFrac: number
  }>(
    win,
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
  await evalIn(win, 'window.__canvasE2E.setFullView(null)')
  await delay(300)
  // Mobile preset aspect = 390/844 ≈ 0.462. Allow tolerance; require the frame be portrait
  // AND letterboxed (markedly narrower than the landscape stage), not stretched to fill.
  const mobileRatio = 390 / 844
  const emuOk =
    emu.found &&
    Math.abs(emu.frameRatio - mobileRatio) < 0.06 &&
    emu.widthFrac < 0.9 &&
    emu.frameRatio < emu.stageRatio
  parts.push({
    name: 'fullview-emulator',
    ok: emuOk,
    detail: emuOk
      ? 'Mobile full view is an aspect-correct, letterboxed emulator (not stretched)'
      : JSON.stringify(emu)
  })

  // ── Slice 5 (close-motion state machine) + Esc-through-typing fix: full view renders a
  // chrome-less frame (no §6.1 band — removed; exits are the board's own ⤢ toggle, Esc, or
  // a scrim click). Open via the e2e hook, assert the frame mounts and the band is GONE,
  // then FOCUS the full-view terminal's xterm helper textarea and dispatch Escape FROM IT
  // (target=TEXTAREA) — the window Esc handler must still close full view despite the
  // typing guard (else a focused terminal traps the user in maximized mode). Assert the
  // modal is gone after the tween — proving the close state machine + the typing-guard
  // bypass end to end. ──
  await evalIn(win, `window.__canvasE2E.setFullView(${JSON.stringify(termId)})`)
  await delay(400) // modal mounts + enter tween settles
  const fvClose = await evalIn<{ frame: boolean; bandGone: boolean; typed: boolean }>(
    win,
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
  await delay(400) // exit tween (200ms) + onExited unmount
  const fvCloseGone = await evalIn<boolean>(
    win,
    `document.querySelector('.fullview-scrim') === null`
  )
  const fvCloseOk = fvClose.frame && fvClose.bandGone && fvClose.typed && fvCloseGone
  parts.push({
    name: 'fullview-close',
    ok: fvCloseOk,
    detail: fvCloseOk
      ? 'chrome-less frame (no band); Esc from focused terminal textarea closes + unmounts'
      : `frame=${fvClose.frame} bandGone=${fvClose.bandGone} typing=${fvClose.typed} closed=${fvCloseGone}`
  })

  // ── Fix #2 (LOD-survival): zooming below LOD must NOT unmount the terminal and
  // kill its PTY. e2eTerminals registration tracks the xterm mount, so the board
  // staying mounted across LOD proves the session survives (pre-fix BoardNode
  // early-returned a LOD card → TerminalBoard unmounted → registration dropped). ──
  await evalIn(win, 'window.__canvasE2E.setZoom(0.2)') // < LOD_ZOOM (0.4)
  const lodAlive = await poll(
    () => evalIn<boolean>(win, `window.__canvasE2E.terminalMounted(${JSON.stringify(termId)})`),
    3000
  )
  parts.push({
    name: 'terminal-lod',
    ok: lodAlive,
    detail: lodAlive ? 'mounted across LOD (session alive)' : 'unmounted at LOD (PTY killed)'
  })

  // ── Fix #1 (restart/config respawn): changing launchCommand tears the old PTY
  // down and spawns a new one under the SAME board id — the path that raced. The
  // new session must come up and echo a fresh sentinel (a stale old-process onExit
  // must not reap it). Restore zoom first so xterm relayouts before reading. ──
  await evalIn(win, 'window.__canvasE2E.setZoom(1)')
  await evalIn(
    win,
    `window.__canvasE2E.patchBoard(${JSON.stringify(termId)}, { launchCommand: 'echo ${TERM_SENTINEL2}' })`
  )
  const respawnOk = await poll(async () => {
    const text = await evalIn<string | null>(
      win,
      `window.__canvasE2E.readTerminal(${JSON.stringify(termId)})`
    )
    return typeof text === 'string' && text.includes(TERM_SENTINEL2)
  }, 10000)
  parts.push({
    name: 'terminal-respawn',
    ok: respawnOk,
    detail: respawnOk ? 'new session echoed after respawn' : 'respawned session not alive'
  })

  // ── #15 (park/adopt on undo): write a unique marker into the live terminal,
  // capture its pid, delete the board (parks the session), undo (adopts it), then
  // assert the SAME pid is back AND the marker replayed from the buffer — a fresh
  // spawn would have neither. Restore zoom first so the re-mounted xterm lays out. ──
  await evalIn(win, 'window.__canvasE2E.setZoom(1)')
  const ADOPT_MARKER = 'CANVAS_E2E_ADOPT_MARKER'
  debugWriteTerminal(termId, `echo ${ADOPT_MARKER}\r`)
  const markerSeen = await poll(async () => {
    const text = await evalIn<string | null>(
      win,
      `window.__canvasE2E.readTerminal(${JSON.stringify(termId)})`
    )
    return typeof text === 'string' && text.includes(ADOPT_MARKER)
  }, 8000)
  const pidBefore = debugTerminalPid(termId)
  await evalIn(win, `window.__canvasE2E.deleteBoard(${JSON.stringify(termId)})`)
  await delay(200) // let the unmount + park settle
  await evalIn(win, 'window.__canvasE2E.undo()')
  const adoptedOk = await poll(async () => {
    const pidNow = debugTerminalPid(termId)
    const text = await evalIn<string | null>(
      win,
      `window.__canvasE2E.readTerminal(${JSON.stringify(termId)})`
    )
    return (
      pidNow !== null &&
      pidBefore !== null &&
      pidNow === pidBefore &&
      typeof text === 'string' &&
      text.includes(ADOPT_MARKER)
    )
  }, 10000)
  parts.push({
    name: 'terminal-adopt',
    ok: markerSeen && adoptedOk,
    detail:
      markerSeen && adoptedOk
        ? `same pid ${pidBefore} + scrollback replayed after undo`
        : `markerSeen=${markerSeen} pidBefore=${pidBefore} adoptedOk=${adoptedOk}`
  })

  // ── Fix #4 (dead-URL status): a refused connection must end as 'load-failed',
  // NOT 'connected' (Chromium's error-page did-finish-load previously clobbered the
  // failure). Seed a browser at a closed port and assert the runtime status. ──
  const deadUrl = 'http://127.0.0.1:59999/' // nothing listens → connection refused
  const deadId = await evalIn<string>(
    win,
    `window.__canvasE2E.seedBoard('browser', { url: ${JSON.stringify(deadUrl)} })`
  )
  await delay(150)
  await evalIn(win, `window.__canvasE2E.fitView(${JSON.stringify(deadId)})`)
  const failedOk = await poll(async () => {
    const rt = await evalIn<{ status: string; live: boolean } | null>(
      win,
      `window.__canvasE2E.getRuntime(${JSON.stringify(deadId)})`
    )
    return rt?.status === 'load-failed'
  }, 12000)
  parts.push({
    name: 'browser-deadurl',
    ok: failedOk,
    detail: failedOk ? 'refused URL → load-failed' : `did not reach load-failed`
  })

  // ── Bug 3 (stale preview link): the terminal→browser edge is solid while the source
  // terminal runs, dashed/dimmed once it's down. Link the browser to the terminal, assert
  // a non-dashed edge, mark the terminal down, assert it goes dashed. ──
  await evalIn(
    win,
    `window.__canvasE2E.patchBoard(${JSON.stringify(browserId)}, { previewSourceId: ${JSON.stringify(termId)} })`
  )
  await evalIn(win, 'window.__canvasE2E.fitView()') // frame all → both nodes measured + edge rendered
  await delay(250)
  const edgeDash = (): Promise<string> =>
    evalIn<string>(
      win,
      `(() => { const p = document.querySelector('.react-flow__edge[data-id="preview-${browserId}"] .react-flow__edge-path'); return p ? (p.style.strokeDasharray || 'none') : 'no-edge'; })()`
    )
  const dashRunning = await edgeDash()
  await evalIn(win, `window.__canvasE2E.setTerminalDown(${JSON.stringify(termId)})`)
  await delay(250)
  const dashDown = await edgeDash()
  await evalIn(
    win,
    `window.__canvasE2E.patchBoard(${JSON.stringify(browserId)}, { previewSourceId: undefined })`
  ) // unlink → restore
  const edgeOk = dashRunning === 'none' && dashDown.includes('5')
  parts.push({
    name: 'preview-edge-stale',
    ok: edgeOk,
    detail: edgeOk
      ? 'solid while running → dashed when terminal down'
      : `running=${dashRunning} down=${dashDown}`
  })

  // ── Duplicating a linked Browser keeps the preview link: a Browser connected to a
  // terminal (previewSourceId) should, when duplicated, leave the COPY linked to the SAME
  // terminal — so both previews (e.g. Desktop + Mobile of one dev server) keep their
  // connector arrow. Link the browser, duplicate it, assert the clone carries the same
  // previewSourceId AND that its own preview edge renders, then delete the clone (restore
  // the seed count) and unlink the original. ──
  await evalIn(
    win,
    `window.__canvasE2E.patchBoard(${JSON.stringify(browserId)}, { previewSourceId: ${JSON.stringify(termId)} })`
  )
  const cloneId = await evalIn<string | null>(
    win,
    `window.__canvasE2E.duplicateBoard(${JSON.stringify(browserId)})`
  )
  await evalIn(win, 'window.__canvasE2E.fitView()') // frame all (incl. the clone) so its edge renders
  await delay(250)
  const dup = await evalIn<{ cloneSource: string | null; edgePresent: boolean }>(
    win,
    `(() => {
       const clone = window.__canvasE2E.getBoards().find((b) => b.id === ${JSON.stringify(cloneId)});
       const cloneSource = clone && clone.type === 'browser' ? (clone.previewSourceId ?? null) : null;
       const edgePresent = !!document.querySelector('.react-flow__edge[data-id="preview-${cloneId}"]');
       return { cloneSource, edgePresent };
     })()`
  )
  if (cloneId) await evalIn(win, `window.__canvasE2E.deleteBoard(${JSON.stringify(cloneId)})`) // restore seed count
  await evalIn(
    win,
    `window.__canvasE2E.patchBoard(${JSON.stringify(browserId)}, { previewSourceId: undefined })`
  ) // unlink the original → restore baseline
  const dupOk = !!cloneId && dup.cloneSource === termId && dup.edgePresent
  parts.push({
    name: 'duplicate-keeps-link',
    ok: dupOk,
    detail: dupOk
      ? 'duplicated Browser stays linked to the same terminal + its own preview edge renders'
      : JSON.stringify({ cloneId, ...dup })
  })

  // ── Bugs 8/9 + 11/12 (board ⋯ menu): drive the REAL menu through the DOM. Bug 11/12
  // only reproduces with a pointerdown→click sequence (pre-fix the document pointerdown
  // close-listener unmounted the item before its click fired); bug 8/9 needs the popover
  // portaled to <body>, not clipped inside the board's overflow:hidden frame. Open the
  // planning board's menu, Duplicate (count +1) then Delete the clone (count back). ──
  // Bring the planning board into detail view + on-screen so its title-bar ⋯ menu renders.
  await evalIn(win, `window.__canvasE2E.fitView(${JSON.stringify(planId)})`)
  await evalIn(win, 'window.__canvasE2E.setZoom(1)')
  await delay(150)
  const menuProbe = await evalIn<{
    portaled: boolean
    base: number
    afterDup: number
    afterDel: number
  }>(
    win,
    `(async () => {
       const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
       const sel = (s, root) => (root || document).querySelector(s);
       const base = window.__canvasE2E.getBoards().length;
       const node = sel('.react-flow__node[data-id=' + JSON.stringify(${JSON.stringify(planId)}) + ']');
       const more = node && sel('button[title="More"]', node);
       if (!more) return { portaled: false, base, afterDup: -1, afterDel: -1 };
       more.click(); await sleep(80);
       const menu = sel('.board-menu');
       const portaled = !!menu && menu.parentElement === document.body && !sel('.bb-frame .board-menu');
       const dup = menu && [...menu.querySelectorAll('.board-menu-item')].find((b) => b.textContent.trim() === 'Duplicate');
       if (dup) { dup.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); dup.click(); }
       await sleep(150);
       const afterDup = window.__canvasE2E.getBoards().length;
       const dupId = window.__canvasE2E.getBoards().slice(-1)[0] && window.__canvasE2E.getBoards().slice(-1)[0].id;
       const dupNode = dupId && sel('.react-flow__node[data-id=' + JSON.stringify(dupId) + ']');
       const more2 = dupNode && sel('button[title="More"]', dupNode);
       if (more2) {
         more2.click(); await sleep(80);
         const menu2 = sel('.board-menu');
         const del = menu2 && [...menu2.querySelectorAll('.board-menu-item')].find((b) => b.textContent.trim() === 'Delete');
         if (del) { del.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); del.click(); }
       }
       await sleep(150);
       const afterDel = window.__canvasE2E.getBoards().length;
       return { portaled, base, afterDup, afterDel };
     })()`
  )
  const menuOk =
    menuProbe.portaled &&
    menuProbe.afterDup === menuProbe.base + 1 &&
    menuProbe.afterDel === menuProbe.base
  parts.push({
    name: 'board-menu',
    ok: menuOk,
    detail: menuOk ? 'portaled to body + Duplicate/Delete fire' : JSON.stringify(menuProbe)
  })

  // ── Bugs 13/14 (board ⋯ menu chrome). Narrow the terminal so its title-bar action
  // cluster (globe·settings·restart + ⤢ + ⋯) would overflow the frame, then assert the
  // ⋯ trigger stays WITHIN the title-bar's right edge (bug 13 — was clipped past it by
  // the frame's overflow:hidden). Then pan the trigger PAST the window's right edge and
  // open the menu: the popover must clamp back inside the viewport (bug 14 — was anchored
  // by `right` with no clamp, so a trigger off the right edge pushed the menu off-screen).
  await evalIn(win, `window.__canvasE2E.patchBoard(${JSON.stringify(termId)}, { w: 150 })`)
  await evalIn(win, `window.__canvasE2E.fitView(${JSON.stringify(termId)})`)
  await evalIn(win, 'window.__canvasE2E.setZoom(1)')
  await delay(150)
  const chrome = await evalIn<{
    found: boolean
    triggerInBar: boolean
    restColor: string
    strokeWidth: string
    inViewport: boolean
    items: string[]
  }>(
    win,
    `(async () => {
       const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
       const sel = (s, root) => (root || document).querySelector(s);
       const node = sel('.react-flow__node[data-id=' + JSON.stringify(${JSON.stringify(termId)}) + ']');
       const bar = node && sel('.board-titlebar', node);
       const more = node && sel('button[title="More"]', node);
       if (!bar || !more) return { found: false, triggerInBar: false, restColor: '', strokeWidth: '', inViewport: false, items: [] };
       const b = bar.getBoundingClientRect();
       const t = more.getBoundingClientRect();
       // Bug 13: the ⋯ trigger sits fully inside the title bar (was clipped past the right edge).
       const triggerInBar = t.width > 0 && t.left >= b.left - 0.5 && t.right <= b.right + 0.5;
       // "Options not visible": the ⋯ glyph is near-inkless, so at REST (no hover/active) it
       // must use the brighter --text-2 (#9b9ba1 = rgb(155,155,161)) and a bumped stroke so
       // it reads. Measure before any interaction (hover would brighten regardless).
       const svg = more.querySelector('svg');
       const restColor = svg ? getComputedStyle(svg).color : '';
       const strokeWidth = svg ? (svg.getAttribute('stroke-width') || '') : '';
       // Bug 14: shove the trigger ~40px past the window's right edge, then open the menu.
       // (panBy +x moves content right; the board is centred after fitView, so the delta
       // that lands the trigger's right edge 40px beyond the window is positive.)
       const overshoot = (window.innerWidth - t.right) + 40;
       window.__canvasE2E.panBy(overshoot, 0);
       await sleep(80);
       const more2 = sel('button[title="More"]', node);
       more2.click(); await sleep(80);
       const menu = sel('.board-menu');
       const m = menu && menu.getBoundingClientRect();
       const items = menu ? [...menu.querySelectorAll('.board-menu-item')].map((x) => x.textContent.trim()) : [];
       const inViewport = !!m && m.left >= 0 && m.top >= 0 && m.right <= window.innerWidth && m.bottom <= window.innerHeight;
       more2.click(); await sleep(40);            // close the menu
       window.__canvasE2E.panBy(-overshoot, 0);   // restore the camera
       return { found: true, triggerInBar, restColor, strokeWidth, inViewport, items };
     })()`
  )
  const wantItems = ['Full view', 'Duplicate', 'Delete']
  const restVisible =
    chrome.restColor === 'rgb(155, 155, 161)' && parseFloat(chrome.strokeWidth) >= 2
  const chromeOk =
    chrome.found &&
    chrome.triggerInBar &&
    chrome.inViewport &&
    restVisible &&
    wantItems.every((l) => chrome.items.includes(l))
  parts.push({
    name: 'menu-chrome',
    ok: chromeOk,
    detail: chromeOk
      ? '⋯ within bar (13) + on-screen near edge (14) + visible at rest (text-2, sw≥2)'
      : JSON.stringify(chrome)
  })

  // ── Menu-over-preview occlusion: a native WebContentsView paints above ALL HTML,
  // even the body-portaled ⋯ popover, so a menu dropping over a live Browser board's
  // device stage renders UNDER the preview. Fix: while a board ⋯ menu is open the preview
  // layer detaches live views → HTML snapshot (z-ordered, so the menu shows on top), then
  // reattaches on close. Assert the live→detached→reattached transition on the Browser
  // board (the detach is exactly what un-occludes the menu; pixels aren't observable in
  // the harness, the liveness flag is). Negative control: without the fix `live` stays
  // true while the menu is open. ──
  await evalIn(win, `window.__canvasE2E.fitView(${JSON.stringify(browserId)})`)
  await evalIn(win, 'window.__canvasE2E.setZoom(1)')
  await delay(250) // let the browser view attach live at rest
  const occl = await evalIn<{
    found: boolean
    liveBefore: boolean
    liveDuringMenu: boolean
    liveAfter: boolean
  }>(
    win,
    `(async () => {
       const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
       const sel = (s, root) => (root || document).querySelector(s);
       const id = ${JSON.stringify(browserId)};
       const live = () => !!(window.__canvasE2E.getRuntime(id) || {}).live;
       const node = sel('.react-flow__node[data-id=' + JSON.stringify(id) + ']');
       const more = node && sel('button[title="More"]', node);
       if (!more) return { found: false, liveBefore: false, liveDuringMenu: false, liveAfter: false };
       const liveBefore = live();
       more.click(); await sleep(250);          // open ⋯ → layer detaches live views
       const liveDuringMenu = live();
       more.click(); await sleep(300);           // close ⋯ → reattach eligible views
       const liveAfter = live();
       return { found: true, liveBefore, liveDuringMenu, liveAfter };
     })()`
  )
  const occlOk = occl.found && occl.liveBefore && !occl.liveDuringMenu && occl.liveAfter
  parts.push({
    name: 'menu-preview-detach',
    ok: occlOk,
    detail: occlOk
      ? 'live preview detaches while ⋯ menu open (un-occluded) → reattaches on close'
      : JSON.stringify(occl)
  })

  // ── Multi-browser connect (gesture routing): the terminal globe routes by gesture.
  // A plain TAP refreshes the browser(s) already linked to this terminal; a press-and-HOLD
  // (≥500ms) or a RIGHT-CLICK opens the multi-select connect picker over candidate browsers
  // (unconnected + connected-elsewhere). Print a dev-server URL into the terminal so port
  // detection succeeds, then drive all three gestures through the real DOM. Both seeded
  // browsers are currently unlinked → 2 candidates; connecting one then makes a tap refresh
  // it (no picker). Restores the link at the end so the baseline is unchanged. ──
  const DETECTED_URL = 'http://localhost:3000' // parser drops the trailing slash
  await evalIn(win, `window.__canvasE2E.patchBoard(${JSON.stringify(termId)}, { w: 360 })`) // menu-chrome narrowed it; widen so the globe is clickable
  await evalIn(win, `window.__canvasE2E.fitView(${JSON.stringify(termId)})`)
  await evalIn(win, 'window.__canvasE2E.setZoom(1)')
  debugWriteTerminal(termId, 'echo http://localhost:3000/\r')
  const urlSeen = await poll(async () => {
    const t = await evalIn<string | null>(
      win,
      `window.__canvasE2E.readTerminal(${JSON.stringify(termId)})`
    )
    return typeof t === 'string' && t.includes('localhost:3000')
  }, 8000)
  const gesture = await evalIn<{
    detected: string[]
    holdOpened: boolean
    holdTitle: boolean
    holdCount: number
    rightOpened: boolean
    tapOpened: boolean
  }>(
    win,
    `(async () => {
       const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
       const detected = (await window.api.detectPorts(${JSON.stringify(termId)})).map((u) => u.url);
       const node = document.querySelector('.react-flow__node[data-id=' + JSON.stringify(${JSON.stringify(termId)}) + ']');
       const globe = node && node.querySelector('button[title*="choose browser"]');
       const picker = () => node.querySelector('.ca-port-picker');
       const pickerHas = (txt) => { const p = picker(); return !!p && p.textContent.includes(txt); };
       if (!globe) return { detected, holdOpened: false, holdTitle: false, holdCount: 0, rightOpened: false, tapOpened: false };

       // (1) LONG-PRESS: mousedown arms the ~500ms timer → onLongPress opens the picker.
       globe.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
       await sleep(700);                                  // hold past the threshold
       globe.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
       globe.dispatchEvent(new MouseEvent('click', { bubbles: true })); // release-click (swallowed after a hold)
       await sleep(600);                                  // detectPorts + render
       const holdOpened = !!picker();
       const holdTitle = pickerHas('Push to which browser');
       const holdCount = picker() ? picker().querySelectorAll('.ca-browser-choice input').length : 0;
       const cancel = picker() && picker().querySelector('.ca-preview-dismiss');
       if (cancel) cancel.click();
       await sleep(120);

       // (2) RIGHT-CLICK: contextmenu opens the same picker (no timing). Then check the first
       // candidate + Connect → wires that browser to this terminal.
       globe.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
       await sleep(600);
       const rightOpened = !!picker();
       const firstBox = picker() && picker().querySelector('.ca-browser-choice input');
       if (firstBox) {
         firstBox.click();                                // check candidate[0] (the first browser)
         await sleep(60);
         const connect = picker().querySelector('.ca-browser-connect');
         if (connect) connect.click();
       }
       await sleep(200);

       // (3) TAP: a plain click now refreshes the just-linked browser — NO picker opens.
       globe.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
       globe.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
       globe.dispatchEvent(new MouseEvent('click', { bubbles: true }));
       await sleep(700);
       const tapOpened = !!picker();
       return { detected, holdOpened, holdTitle, holdCount, rightOpened, tapOpened };
     })()`
  )
  await delay(150)
  const linkAfter = await evalIn<{ source: string | null; url: string }>(
    win,
    `(() => {
       const b = window.__canvasE2E.getBoards().find((x) => x.id === ${JSON.stringify(browserId)});
       return { source: (b && b.type === 'browser' ? (b.previewSourceId ?? null) : null), url: (b && b.type === 'browser' ? b.url : '') };
     })()`
  )
  await evalIn(
    win,
    `window.__canvasE2E.patchBoard(${JSON.stringify(browserId)}, { previewSourceId: undefined })`
  ) // restore baseline (unlink)
  const connectedOk = linkAfter.source === termId && linkAfter.url === DETECTED_URL
  const connectGestureOk =
    urlSeen &&
    gesture.holdOpened &&
    gesture.holdTitle &&
    gesture.holdCount >= 2 &&
    gesture.rightOpened &&
    connectedOk &&
    !gesture.tapOpened
  parts.push({
    name: 'preview-connect-gesture',
    ok: connectGestureOk,
    detail: connectGestureOk
      ? 'hold + right-click open the connect picker; Connect links the browser; tap refreshes (no picker)'
      : JSON.stringify({ urlSeen, ...gesture, ...linkAfter })
  })

  // ── Auto-tidy (Smart preset): repack the scattered boards into a clean, non-overlapping
  // block. The seed spread is a wide 760px stride; after Smart tidy the boards must (a) keep
  // their count, (b) NOT overlap, (c) occupy a TIGHTER horizontal span than the spread, and
  // (d) GROUP by type — all browser boards land on a single row (same y), proving the
  // link/type-aware grouping runs (not the old reading-order shelf-pack). Pure store path
  // (positions only), so this is deterministic — not subject to the capturePage flake. ──
  const tidyProbe = await evalIn<{
    before: number
    after: number
    overlap: boolean
    count: number
    browserRows: number
  }>(
    win,
    `(() => {
       const rect = (b) => ({ x: b.x, y: b.y, w: b.w, h: b.h });
       const span = (bs) => Math.max(...bs.map((b) => b.x + b.w)) - Math.min(...bs.map((b) => b.x));
       const overlapAny = (bs) => {
         for (let i = 0; i < bs.length; i++)
           for (let j = i + 1; j < bs.length; j++) {
             const a = bs[i], c = bs[j];
             if (a.x < c.x + c.w && c.x < a.x + a.w && a.y < c.y + c.h && c.y < a.y + a.h) return true;
           }
         return false;
       };
       const pre = window.__canvasE2E.getBoards().map(rect);
       window.__canvasE2E.tidy('smart');
       const after = window.__canvasE2E.getBoards();
       const post = after.map(rect);
       const browserYs = new Set(after.filter((b) => b.type === 'browser').map((b) => Math.round(b.y)));
       return { before: span(pre), after: span(post), overlap: overlapAny(post), count: post.length, browserRows: browserYs.size };
     })()`
  )
  const tidyOk =
    tidyProbe.count >= 2 &&
    !tidyProbe.overlap &&
    tidyProbe.after < tidyProbe.before &&
    tidyProbe.browserRows === 1
  parts.push({
    name: 'tidy',
    ok: tidyOk,
    detail: tidyOk
      ? `smart packed: span ${Math.round(tidyProbe.before)}→${Math.round(tidyProbe.after)}px, browsers grouped on 1 row, no overlaps`
      : JSON.stringify(tidyProbe)
  })

  // ── Tile (resize-to-fill preset): the window-manager templates RESIZE boards to fill an
  // area's zones. Tile into a fixed 1600×1000 area with cols-2 and assert the union of the
  // boards fills that area edge-to-edge (each axis within tolerance) AND no overlaps — i.e.
  // boards were genuinely resized to their zones, not just moved. Deterministic store path. ──
  const tileProbe = await evalIn<{ fills: boolean; overlap: boolean; resized: boolean; count: number }>(
    win,
    `(() => {
       const area = { x: 0, y: 0, w: 1600, h: 1000 };
       const before = window.__canvasE2E.getBoards().map((b) => b.w + 'x' + b.h).join(',');
       window.__canvasE2E.tile('cols-2', area);
       const bs = window.__canvasE2E.getBoards();
       const r = bs.map((b) => ({ x: b.x, y: b.y, w: b.w, h: b.h }));
       const minX = Math.min(...r.map((b) => b.x)), minY = Math.min(...r.map((b) => b.y));
       const maxX = Math.max(...r.map((b) => b.x + b.w)), maxY = Math.max(...r.map((b) => b.y + b.h));
       let overlap = false;
       for (let i = 0; i < r.length; i++)
         for (let j = i + 1; j < r.length; j++) {
           const a = r[i], c = r[j];
           if (a.x < c.x + c.w - 0.5 && c.x < a.x + a.w - 0.5 && a.y < c.y + c.h - 0.5 && c.y < a.y + a.h - 0.5) overlap = true;
         }
       const fills = Math.abs(minX) < 1 && Math.abs(minY) < 1 && Math.abs(maxX - 1600) < 2 && Math.abs(maxY - 1000) < 2;
       return { fills, overlap, resized: bs.map((b) => b.w + 'x' + b.h).join(',') !== before, count: bs.length };
     })()`
  )
  const tileOk = tileProbe.count >= 2 && tileProbe.fills && !tileProbe.overlap && tileProbe.resized
  parts.push({
    name: 'tile',
    ok: tileOk,
    detail: tileOk
      ? 'cols-2 tiling resized boards to fill the 1600×1000 area, no overlaps'
      : JSON.stringify(tileProbe)
  })

  // ── W1.1 Eraser + W1.2 letter shortcuts (whiteboard slice 1). Drive the REAL DOM:
  // seed a single note on the planning board, focus the well, press 'e' (the erase
  // shortcut — proves W1.2 sets the tool), then "tap" the note's computed screen point.
  // The erase pointer-down hit-tests the note → pointer-up commits its removal as ONE
  // undo step (W1.1); undo must restore it. Then press 'n' and tap an empty spot — the
  // note tool creates a fresh note, proving a second shortcut routes through. All
  // assertions read element counts off the store (deterministic; no component-state peek).
  await evalIn(
    win,
    `window.__canvasE2E.patchBoard(${JSON.stringify(planId)}, { elements: [{ id: 'e2e-erase-note', kind: 'note', x: 40, y: 40, w: 156, h: 96, tint: 'yellow', text: '', rotation: 0 }] })`
  )
  await evalIn(win, `window.__canvasE2E.fitView(${JSON.stringify(planId)})`)
  await delay(200) // node measured + well laid out + above LOD
  const wb = await evalIn<{
    start: number
    afterErase: number
    afterUndo: number
    afterCreate: number
  }>(
    win,
    `(async () => {
       const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
       const id = ${JSON.stringify(planId)};
       const elems = () => {
         const b = window.__canvasE2E.getBoards().find((x) => x.id === id);
         return b && b.type === 'planning' ? b.elements.length : -1;
       };
       const node = document.querySelector('.react-flow__node[data-id=' + JSON.stringify(id) + ']');
       const well = node && node.querySelector('.pl-well');
       if (!well) return { start: -1, afterErase: -1, afterUndo: -1, afterCreate: -1 };
       const r = well.getBoundingClientRect();
       const scale = well.offsetWidth > 0 ? r.width / well.offsetWidth : 1; // board-local → screen
       const at = (bx, by) => ({ x: r.left + bx * scale, y: r.top + by * scale });
       const press = (k) => { well.focus(); well.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })); };
       const tap = (p) => {
         for (const t of ['pointerdown', 'pointerup']) {
           try { well.dispatchEvent(new PointerEvent(t, { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, clientX: p.x, clientY: p.y })); } catch (e) {}
         }
       };
       const start = elems();
       // W1.2: 'e' selects the eraser. W1.1: tap the note (board-local centre 118,88) → removed.
       press('e'); await sleep(40);
       tap(at(118, 88)); await sleep(80);
       const afterErase = elems();
       window.__canvasE2E.undo(); await sleep(80);     // one undo step restores the swipe
       const afterUndo = elems();
       // W1.2: 'n' selects the note tool → a tap on an empty spot creates a note.
       press('n'); await sleep(40);
       tap(at(230, 210)); await sleep(80);
       const afterCreate = elems();
       return { start, afterErase, afterUndo, afterCreate };
     })()`
  )
  const eraseOk = wb.start === 1 && wb.afterErase === 0 && wb.afterUndo === 1
  parts.push({
    name: 'whiteboard-erase',
    ok: eraseOk,
    detail: eraseOk
      ? "'e' erases the note on tap; undo restores it in one step"
      : JSON.stringify(wb)
  })
  const shortcutOk = wb.afterUndo === 1 && wb.afterCreate === 2
  parts.push({
    name: 'whiteboard-shortcut',
    ok: shortcutOk,
    detail: shortcutOk
      ? "'n' selects the note tool → tap creates a note"
      : JSON.stringify(wb)
  })

  // ── W2 selection core (multi-select + snapping). Seed two notes, drive the REAL
  // DOM on .pl-well, and assert the EFFECTS via getBoards() (selection is ephemeral
  // component state). A marquee that selects both is proven by the group it then
  // deletes / drags; snapping is proven by the committed coordinate.
  await evalIn(
    win,
    `window.__canvasE2E.patchBoard(${JSON.stringify(planId)}, { elements: [
       { id: 'w2-a', kind: 'note', x: 40, y: 40, w: 156, h: 96, tint: 'yellow', text: 'A', rotation: 0 },
       { id: 'w2-b', kind: 'note', x: 260, y: 40, w: 156, h: 96, tint: 'blue', text: 'B', rotation: 0 }
     ] })`
  )
  await evalIn(win, `window.__canvasE2E.fitView(${JSON.stringify(planId)})`)
  await delay(200)
  const w2 = await evalIn<{
    stage: string
    ids: string
    marqueeDel: number
    afterDelUndo: number
    multiMovedBoth: boolean
    afterMoveUndo: boolean
    shiftAddMoved: boolean
    snapX: number
  }>(
    win,
    `(async () => {
       const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
       const id = ${JSON.stringify(planId)};
       const board = () => window.__canvasE2E.getBoards().find((x) => x.id === id);
       const els = () => { const b = board(); return b && b.type === 'planning' ? b.elements : []; };
       const note = (nid) => els().find((e) => e.id === nid);
       const count = () => els().length;
       const node = document.querySelector('.react-flow__node[data-id=' + JSON.stringify(id) + ']');
       const well = node && node.querySelector('.pl-well');
       if (!well) return { stage: 'no-well', ids: '', marqueeDel: -1, afterDelUndo: -1, multiMovedBoth: false, afterMoveUndo: false, shiftAddMoved: false, snapX: -1 };
       const r = well.getBoundingClientRect();
       const scale = well.offsetWidth > 0 ? r.width / well.offsetWidth : 1;
       const at = (bx, by) => ({ x: r.left + bx * scale, y: r.top + by * scale });
       // A board-local drag STARTS from the note's grip ring (.pl-note-grip), not the
       // outer .pl-note (which only stops propagation). Press the grip to begin a move.
       const grip = (i) => node.querySelectorAll('.pl-note-grip')[i];
       const ev = (target, type, p, shift) => {
         try { target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, clientX: p.x, clientY: p.y, shiftKey: !!shift })); } catch (e) {}
       };
       // down on downTarget, then N moves + up on the WELL (it owns pointer capture).
       const drag = async (from, to, opts) => {
         const o = opts || {};
         const downT = o.downTarget || well;
         ev(downT, 'pointerdown', from, o.shift); await sleep(20);
         const steps = 4;
         for (let i = 1; i <= steps; i++) {
           const t = i / steps;
           ev(well, 'pointermove', { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t }, o.shift);
           await sleep(15);
         }
         ev(well, 'pointerup', to, o.shift); await sleep(40);
       };
       const press = (k) => { well.focus(); well.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })); };

       // Crash-safe x reader + stage tracker: a probe bug must surface as a diagnostic
       // (which stage, which elements survive), never an uncaught throw that aborts the
       // whole harness before any E2E_ line prints.
       const nx = (nid) => { const n = note(nid); return n ? n.x : -999999; };
       const idsNow = () => els().map((e) => e.id).join('|');
       // Each sub-test RE-SEEDS two fresh notes + clears selection so it is INDEPENDENT:
       // a chained undo→edit across tests hits the lastRecorded dedup edge (the documented
       // undo-lastrecorded-phantom / D1.1 class) which churns shared state. Re-seeding sets
       // a fresh boards array, so the next deferred beginChange always records its checkpoint.
       // Notes carry text so a no-move grip click never triggers the empty-note prune.
       const seedEls = () => window.__canvasE2E.patchBoard(id, { elements: [
         { id: 'w2-a', kind: 'note', x: 40, y: 40, w: 156, h: 96, tint: 'yellow', text: 'A', rotation: 0 },
         { id: 'w2-b', kind: 'note', x: 260, y: 40, w: 156, h: 96, tint: 'blue', text: 'B', rotation: 0 }
       ] });
       const clearSel = () => { ev(well, 'pointerdown', at(560, 300)); ev(well, 'pointerup', at(560, 300)); };
       const fresh = async () => { seedEls(); await sleep(140); clearSel(); await sleep(40); well.focus(); await sleep(20); };
       let stage = 'start';
       try {
         // (1) group-delete: marquee both → Delete → 0; undo restores both in ONE step.
         stage = 'group-delete';
         await fresh();
         await drag(at(10, 10), at(440, 150)); // marquee covers w2-a + w2-b
         press('Delete'); await sleep(60);
         const marqueeDel = count();
         window.__canvasE2E.undo(); await sleep(60);
         const afterDelUndo = count();

         // (2) multidrag: marquee both → drag one's grip +40,+40 → BOTH move; undo restores both.
         stage = 'multidrag';
         await fresh();
         await drag(at(10, 10), at(440, 150)); await sleep(20); // select both
         const ax0 = nx('w2-a'), bx0 = nx('w2-b');
         await drag(at(118, 88), at(158, 128), { downTarget: grip(0) });
         const multiMovedBoth = nx('w2-a') - ax0 >= 30 && nx('w2-b') - bx0 >= 30;
         window.__canvasE2E.undo(); await sleep(60);
         const afterMoveUndo = nx('w2-a') === ax0 && nx('w2-b') === bx0;

         // (3) shift-add: click A (grip, no move → selects A), Shift-click B (toggle-add),
         // then drag A → BOTH move. Proves additive ELEMENT selection (selectOnPress/toggle).
         stage = 'shift-add';
         await fresh();
         ev(grip(0), 'pointerdown', at(60, 60)); ev(well, 'pointerup', at(60, 60)); await sleep(40); // click A -> {A}
         ev(grip(1), 'pointerdown', at(280, 60), true); ev(well, 'pointerup', at(280, 60), true); await sleep(40); // Shift-click B -> {A,B}
         const sa0 = nx('w2-a'), sb0 = nx('w2-b');
         await drag(at(60, 60), at(100, 60), { downTarget: grip(0) });
         const shiftAddMoved = nx('w2-a') - sa0 >= 30 && nx('w2-b') - sb0 >= 30;

         // (4) snap: press B alone (unselected) and drag its left edge to within tol of A's
         // left (x=40) → committed B.x snaps to 40 (A is the static neighbor).
         stage = 'snap';
         await fresh();
         await drag(at(338, 88), at(122, 88), { downTarget: grip(1) });
         const snapX = nx('w2-b');

         return { stage: 'done', ids: idsNow(), marqueeDel, afterDelUndo, multiMovedBoth, afterMoveUndo, shiftAddMoved, snapX };
       } catch (err) {
         return { stage: 'ERR@' + stage + ':' + String((err && err.message) || err), ids: idsNow(), marqueeDel: -9, afterDelUndo: -9, multiMovedBoth: false, afterMoveUndo: false, shiftAddMoved: false, snapX: -9 };
       }
     })()`
  )
  const groupDeleteOk = w2.marqueeDel === 0 && w2.afterDelUndo === 2
  parts.push({
    name: 'whiteboard-group-delete',
    ok: groupDeleteOk,
    detail: groupDeleteOk ? 'marquee selects 2 → Delete removes both; undo restores both in one step' : JSON.stringify(w2)
  })
  const multidragOk = w2.multiMovedBoth && w2.afterMoveUndo
  parts.push({
    name: 'whiteboard-multidrag',
    ok: multidragOk,
    detail: multidragOk ? 'marquee 2 → drag one moves both; undo restores both in one step' : JSON.stringify(w2)
  })
  const shiftAddOk = w2.shiftAddMoved
  parts.push({
    name: 'whiteboard-shift-add',
    ok: shiftAddOk,
    detail: shiftAddOk ? 'click A + Shift-click B selects both; dragging A moves both' : JSON.stringify(w2)
  })
  const snapOk = Math.abs(w2.snapX - 40) <= 1
  parts.push({
    name: 'whiteboard-snap',
    ok: snapOk,
    detail: snapOk ? "drag aligns B's left edge to neighbor (x=40)" : JSON.stringify(w2)
  })

  const count = await evalIn<number>(win, 'window.__canvasE2E.getBoards().length')
  parts.push({ name: 'seed', ok: count === 4, detail: `${count} boards` })

  const summary = summarizeE2E(parts)
  for (const p of parts) console.log(`E2E_${p.name.toUpperCase()} ${JSON.stringify(p)}`)
  console.log(summary.line)
  return summary.exitCode
}
