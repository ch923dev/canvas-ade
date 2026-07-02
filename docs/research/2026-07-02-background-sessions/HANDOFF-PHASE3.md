# Background Project Sessions — Phase 3 handoff (2026-07-02)

> **For the next session.** Worktree `Z:\Canvas ADE\.worktrees\bg-sessions`, branch
> `feat/bg-sessions` (based on main `038fc641`, schema v18). One session per worktree — work
> HERE, not in main. Delete this file in the PR that merges the epic (doc-lifecycle rule).
> Full approved plan: `C:\Users\De Asis PC\.claude\plans\do-an-indepth-review-fluffy-phoenix.md`
> (user-approved 2026-07-02); the durable memory note is
> `memory/background-project-sessions-epic.md`. Coordination row: ACTIVE-WORK.md › `bg-sessions`.

## Epic in one line

Maestri-style resume: switch project A→B→A within one app run and A's terminals are STILL
RUNNING (same PTYs, live) and its previews still alive with in-page state intact.
User-locked scope: in-app-run only (quit kills all) · previews keep-alive budgeted ·
ask-on-switch dialog (Phase 4). No schema bump anywhere in this epic.

## State: Phases 1–2 DONE, committed, e2e-proven

- **Phase 1 `31fe22c7`** — plumbing. Sessions/windows tagged with owning `projectDir`; typed
  parks (`kind: 'undo'` TTL vs `'background'` no-TTL); owner-checked adopt (R1 — cloned
  projects share board UUIDs); scoped `disposeProjectPtys/Osr`, `countProjectSessions`,
  `parkProjectSessions`; `preview:osrClose` suppressed for backgrounded entries (R3);
  `projectSessions.ts` registry (factory, DI); `onProjectForeground` hook on every open.
  Ratchet splits: `previewOsrBackground.ts`, `previewOsrProbe.ts`.
- **Phase 2 `102f6c79`** — the keep-running switch, dark behind `EXPANSE_BG_SESSIONS=1`.
  `store/projectSwitch.ts` = extracted pipeline (lock → autosave cancel → pinned flush-save →
  `backgroundLiveResources` **BEFORE** `setProjectLoading()` unmount → load). IPC:
  `project:background/listBackground/closeBackground/closeActive/bgSessionsEnabled`
  (`projectSessionsIpc.ts`). Exit tombstones (R6, capture-only). `reapUndoParks` preamble
  (R5). R2 `expectedDir` pins on `terminal:writeSnapshot/deleteSnapshot`. R4 raced-adopt
  re-park (renderer disposed-branch + ownership-typed `park()`).
  **e2e `projectBackground.e2e.ts` 4/4 green**: same-pid reattach with background output ·
  exit-while-backgrounded → restored bar · rapid-switch zero orphans · clone refusal.
  Windows leg 247/247 effective. 4152 unit+integration.

**Try it live:** `$env:EXPANSE_BG_SESSIONS='1'; $env:CANVAS_DEV_TITLE='bg-sessions dev'; pnpm dev`
— switches keep the outgoing project's terminals running; switch back live-reattaches.

## Phase 3 — preview keep-alive completion (THE NEXT WORK, not started; working tree clean)

Terminals fully work. Previews SURVIVE the switch (window kept, frozen, muted, throttled) but
the remounted board sits at **"Connecting…" with a stale URL bar** — the store entry is fresh
and `ensureOsr` early-returns for an existing window, so no lifecycle events ever arrive.
The page itself must NOT reload (user requirement: unsaved in-page form state survives).

Three MAIN changes (all in `src/main/previewOsr.ts`; anchors verified at `102f6c79`):

1. **Synthetic state re-emit** — `preview:osrOpen` handler (line ~763). Before calling
   `ensureOsr`, check `osr.get(args.id)`; if the entry EXISTS: `armOwner(win)` then emit the
   CURRENT state so the fresh previewStore entry converges without a reload:
   ```ts
   const wc = existing.osrWin.webContents
   emitEvent({ id, type: 'did-navigate', url: wc.getURL(),
     canGoBack: wc.navigationHistory.canGoBack(),
     canGoForward: wc.navigationHistory.canGoForward() })
   if (existing.ready && !existing.failed)
     emitEvent({ id, type: 'did-finish-load', url: wc.getURL() })
   ```
   (wrap in try/catch — window can die mid-remount). If `!ready || failed`, emit only the
   navigate: the real lifecycle (or the user's Reload) resolves the rest — stay honest.
   Renderer needs NO change: `useOffscreenPreview` mount patches `connecting` then consumes
   `preview:event` (see its `did-navigate`/`did-finish-load` branches); frames resume when the
   liveness manager sends `preview:osrSetPaint(true)` (foregroundProject already cleared the
   `backgrounded` flag at project:open — ordering holds, see `onProjectForeground`).
2. **Global window budget** — `GLOBAL_OSR_MAX = 8` (constant next to `OSR_FRAME_RATE`). In
   `ensureOsr` (existing-entry check at line ~431), before constructing a new BrowserWindow:
   if `osr.size >= GLOBAL_OSR_MAX`, evict `osr.size - GLOBAL_OSR_MAX + 1` windows — ONLY
   `backgrounded` entries, oldest `backgroundedAt` first, via `disposeOsr(id)`. NEVER evict a
   foreground entry (renderer `OSR_MAX_LIVE=4` already bounds those; background residents must
   not starve foreground creation). Evicted boards fall back to the existing freeze+revive
   path — the in-memory `preview-osr-${id}` partition keeps cookies. Add
   `backgroundedAt?: number` to `OsrEntry`; SET it in `previewOsrBackground.backgroundProjectOsr`
   loop (after a true transition), CLEAR in `foregroundProjectOsr` — keep `applyOsrBackground`
   clock-free/pure. Extract the victim-picking as a pure `pickOsrEvictions(entries, max)` for
   unit tests (previewOsr.test.ts style).
3. **Downloads denied while backgrounded** — `ensureOsr`'s `registerOsrDownloads` call
   (line ~513): wrap the token bucket: `allow: () => !e.backgrounded && allowDownload()`.
   (R2: a backgrounded page's download would land in the ACTIVE project's
   `.canvas/downloads/` — `getDownloadsDir()` resolves `getCurrentDir()` at save time.)

**Watch the max-lines ratchet:** previewOsr.ts sits ~10 lines under 700 CODE lines. If the
budget code tips it, move eviction into `previewOsrBackground.ts` (it already has the narrow
`getOsrEntries`/`disposeOsr`/`sweepPendingForProject` surface).

### Phase 3 e2e (`e2e/projectBackgroundPreview.e2e.ts`, tag `@preview`)

Prove NO-RELOAD survival: seed a browser board at `localUrl()` (the in-process page —
`src/main/localServer.ts` serves an `<input id="t">` whose `input` handler mirrors into
`document.title` as `VAL:<value>`; see `browserTyping.e2e.ts`). Cleanest probe: add two
e2e-gated helpers to `src/main/e2eMain.ts` (interface + impl, mirrors `osrPainting`):
- `osrEval(id, code)` → `getOsrWindow(id)?.webContents.executeJavaScript(code)` (E2E ONLY —
  gated by `__ENABLE_E2E_MAIN__` + `CANVAS_E2E`, like the rest of the registry).
- reuse existing `osrPainting(id)`.

Flow: mint/open B then A (INTERLEAVED — see gotchas) → seed browser board (`seedBoard('browser',
{ url: localUrl })`) → poll renderer `getRuntime(id).status === 'connected'` → `osrEval` set
`window.__bgProbe = 'alive-123'` → `switchProjectFromDisk(dirB, true)` → assert
`osrPainting(id) === false` (window KEPT, frozen — null would mean destroyed) → switch back →
poll status `'connected'` (proves the synthetic re-emit) → `osrEval` read `__bgProbe` →
`'alive-123'` (same JS context ⇒ never reloaded) → poll `osrPainting(id) === true` (liveness
resumed). Budget eviction: unit-test `pickOsrEvictions` instead of staging 8 windows.

## Gotchas this epic already paid for (do not rediscover)

- **e2e MAIN registry needs `CANVAS_E2E=1` at BUILD time.** Plain `pnpm build` compiles
  `__ENABLE_E2E_MAIN__` off → every `__canvasE2EMain` call is undefined. Iterate with
  `CANVAS_E2E=1 pnpm exec electron-vite build` then `pnpm exec playwright test <spec>`;
  `pnpm test:e2e` does it correctly (pretest hook).
- **Renderer `terminalLive` is the VISIBILITY gate, not PTY state.** Probe MAIN-side
  (`terminalPid` / `ptySessionCounts`).
- **ConPTY pid is 0 until the agent starts** — poll `pid > 0`, never `!== null`.
- **e2e temp projects: interleave mint→open.** `project:open` approves only the CURRENT dir
  or recents; `createTempProject` flips currentDir — mint B, open B, mint A, open A (helpers
  already in `projectBackground.e2e.ts`; `openFromDisk` throws on a non-open settle).
- **osrCropSupersample is the documented flake** and can take a neighbor spec down with it
  ("browser has been closed" in the fixture reset) — rerun the pair, don't "fix".
- **Board-delete undo across a switch is impossible by design** — undo-parks are reaped at
  background time (R5); don't "fix" that either.
- `.impeccable/` is prettier-ignored (local plugin cache); `pty.ts` uses a literal ` `
  escape in `residueKey` — never paste a raw NUL byte.

## After Phase 3

- **Phase 4 — UX (flag removed):** ask-on-switch dialog (only when the outgoing project has
  live resources; lock BEFORE dialog, save AFTER), ProjectSwitcher live-dot + "N running"
  badges (`project:listBackground`), per-project Close (confirm when running →
  `project:closeBackground`; active close path = `closeActiveLiveResources`). **Design
  artifact FIRST (repo rule)** — wireframes/mock for dialog + switcher rows + close-confirm,
  user sign-off before component code. Reuse `ConfirmModal` chooser variant.
- **Phase 5 — hardening:** ring watermark splice (full scrollback: sidecar snapshot to park
  point + post-park-only replay; undo-adopt keeps full-ring), `pty:exitResidue` UX in
  `TerminalRestoredBar` ("exited in background (code N)" — `takeExitResidue` already exists),
  quit/darwin ring-tail append to owning-project sidecars (`terminalSnapshot` writers take an
  explicit dir), recap project-gating + `pruneBoardResults` union-of-residents, new ADR
  (in-app-run lifetime · budgets · dialog policy · darwin=quit semantics · no schema bump ·
  v1 MCP limitation: background agents run but MCP canvas tools see only the active project).

## Gate ritual (unchanged)

Per phase: `pnpm typecheck` · `pnpm lint` (0 errors; 37 STYLE-02 warnings are pre-existing) ·
`pnpm format:check` · `pnpm vitest run` · the phase's e2e spec + full Windows leg. Full matrix
(`pnpm test:e2e:matrix`, Docker up) once at pre-merge. Manual dev check with
`CANVAS_DEV_TITLE` before the PR. src/main is LINUX_SENSITIVE → pre-push wants the Docker leg.
