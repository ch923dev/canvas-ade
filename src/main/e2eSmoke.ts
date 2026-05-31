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
import { debugCaptureView } from './preview'
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
  const browserLiveBefore = await poll(async () => {
    const rt = await evalIn<{ live: boolean } | null>(
      win,
      `window.__canvasE2E.getRuntime(${JSON.stringify(browserId)})`
    )
    return rt?.live === true
  }, 4000)
  if (browserLiveBefore) {
    await evalIn(win, `window.__canvasE2E.setFullView(${JSON.stringify(planId)})`)
    await delay(400) // applyLiveness full-view branch closes the browser view
    await evalIn(win, `window.__canvasE2E.addChecklist(${JSON.stringify(planId)})`) // mutate → reconcile (the bug path)
    await delay(400)
    const capDuring = await debugCaptureView(browserId)
    const rtDuring = await evalIn<{ live: boolean } | null>(
      win,
      `window.__canvasE2E.getRuntime(${JSON.stringify(browserId)})`
    )
    fvPrevOk = !capDuring.attached && rtDuring?.live !== true
    fvPrevDetail = fvPrevOk
      ? 'browser stayed detached through a full-view mutation'
      : `browser re-attached over modal (attached=${capDuring.attached} live=${rtDuring?.live})`
    await evalIn(win, 'window.__canvasE2E.setFullView(null)') // exit → browser reattaches
    await delay(300)
  }
  parts.push({ name: 'fullview-preview', ok: fvPrevOk, detail: fvPrevDetail })

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

  const count = await evalIn<number>(win, 'window.__canvasE2E.getBoards().length')
  parts.push({ name: 'seed', ok: count === 4, detail: `${count} boards` })

  const summary = summarizeE2E(parts)
  for (const p of parts) console.log(`E2E_${p.name.toUpperCase()} ${JSON.stringify(p)}`)
  console.log(summary.line)
  return summary.exitCode
}
