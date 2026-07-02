# HANDOFF — Voice slice V3: VoicePill + VoiceFlyout + terminal injection

> For the session picking up V3. Worktree: `Z:\Canvas ADE\.worktrees\voice-to-text`
> (branch `feat/voice-to-text` — one session per worktree; do NOT work in the main checkout).
> Read `IMPLEMENTATION-PLAN.md` (§V3) + `SPEC.md` §3 (UX contract — the states table is the
> build checklist) first. Design artifact: `mock-voice-composer.html/.png` (**pill mock v2,
> approved AS-IS 2026-07-02** — no new sign-off needed; go straight to build). This doc is
> the state snapshot + sharp edges; deleted when the epic merges (doc lifecycle).

## State at handoff (2026-07-03)

- Branch `feat/voice-to-text` @ `836fa1be`, **pushed**, full matrix green (Win 244P +
  Linux-Docker 245P). Commits on top of `origin/main` @ `038fc64`:
  - `902db48` research package · `58dc71c` **V0** mic permission posture
  - `62ae9e3f` V1 handoff · `7f14168c` **V1** capture pipeline + `voice:port` (worklet →
    16 kHz Int16 120 ms frames ~8.3/s, RMS level, silent-zeros watchdog, ephemeral
    `voiceStore`, `@voice` e2e)
  - `2c756c81` **V2 spike** (sherpa-onnx-node loads in utilityProcess, dev AND packaged
    win-x64 — no custom loader; gate machinery kept for V5) · `0ae4a2d5` **V2** engine
    host + models · `836fa1be` eos drain fix
- **The whole voice backend exists and is proven.** In-app model download (71 MB / 6.6 s,
  sha256-verified, atomic) → recognizer `model=live` in the utilityProcess → WAV fixture →
  correct partials + finals ("after early nightfall…"). V3 is UI + injection ONLY — do not
  touch the engine/model layer except through the existing seams.
- On this machine the Kroko model is already downloaded into the dev/e2e userData
  (`C:\Users\De Asis PC\AppData\Roaming\Electron\voice-models`) — dev-checking V3 gives you
  REAL live partials with a real mic. The model-gated integration test runs with
  `CANVAS_VOICE_MODELS_ROOT='C:\Users\De Asis PC\AppData\Roaming\Electron\voice-models'`.
- Coordination board row `voice-to-text` exists — update it as you go. `src/main/index.ts`
  is cross-zone with the `bg-sessions` lane (V0–V2 kept touches minimal; V3 should not need
  index.ts at all).

## What V2 left you (the seams V3 consumes)

### Renderer side (all exist)
- `src/renderer/src/store/voiceStore.ts` — ephemeral Zustand: `capturing, level, micSilent`
  + actions. V3 EXTENDS this with draft/partial/flyout state (still ephemeral-only — never
  near `boardSchema`/`PATCHABLE_KEYS`).
- `src/renderer/src/voice/useVoiceCapture.ts` — mounted at App root; owns the mic session.
  The transferred MessagePort IS the session. **V3 must tap the transcript here**: the port's
  `onmessage` currently only handles `{t:'stop'}` — extend it to route `{t:'partial'|'final',
  text}` into `voiceStore`. Do NOT reorder the dispose sequence: `{t:'eos'}` must stay the
  LAST message posted on the port (the drain handshake — see sharp edge 1).
- `window.api.voice` (preload `src/preload/voice.ts`): `start()` →
  `{ok, micStatus, modelStatus}` (drive `mic-denied` off micStatus+watchdog, `model-missing`
  off `modelStatus === 'absent'`); `stop()` → `{ok, frames}`; `models.list|status|download|
  delete` + `models.onDownloadProgress(cb)` → unsubscribe (throttled `voice:models:progress`
  push — wire the flyout Download CTA + progress bar directly to these).

### MAIN side (do not modify, only consume)
- `src/main/voiceIpc.ts` — port broker + models IPC. **`VoiceIpcDeps.engine` is an injection
  seam** (used by voiceIpc.test.ts) — this is where the e2e stub engine goes (below).
- `src/main/voiceEngine.ts` / `voiceEngineHost.ts` — session port protocol (host → renderer):
  `{t:'partial', text}` (only on text change), `{t:'final', text}` (endpoint fired, stream
  reset), `{t:'stop'}` (teardown order). Renderer → host: `{t:'frame', d}` then `{t:'eos'}`
  last. All plain JSON — NEVER put a transferable in a cross-process port transfer list.

### Terminal side (V3 creates the registry)
- `src/renderer/src/canvas/boards/terminal/terminalInputRegistry.ts` — NEW: `boardId →
  {paste(text), submit()}`. Register/unregister in `useTerminalSpawn.ts` beside the
  `e2eTerminals` lifecycle: register near `useTerminalSpawn.ts:705`
  (`if (isE2E()) e2eTerminals.set(board.id, term)`), unregister near `:1005`. Those two
  lines are the ONLY useTerminalSpawn edits — terminal zone is shared, check ACTIVE-WORK.md
  lanes before starting.
- `paste` = `term.paste(text)` (bracketed, multi-line safe); `submit` = PTY `sendInput('\r')`
  after ~150 ms settle. **Send is the only `\r` emitter in the whole feature**;
  `autoSendOnFinal` stays hard-false. Insert/Send disabled unless
  `useTerminalRuntimeStore.running[id]`.
- Interaction contract to clone: `SubmitWell.tsx` — auto-grow textarea (~6 rows cap /
  `MAX_INPUT_PX`), Enter=Send, Shift+Enter=newline, `isComposing` IME guard.

## V3 scope (exit: dictate → edit in flyout → Send lands exact bytes in the CLI)

Per plan §V3 + SPEC §3. New: `VoicePill.tsx`, `VoiceFlyout.tsx`,
`src/renderer/src/styles/islands/voice-pill.css` (islands cascade slot, like toast/minimap),
`terminalInputRegistry.ts`; mount pill+flyout in the app-level overlay layer beside the other
islands (`App.tsx`/`Canvas.tsx` chrome slot — screen-fixed, NOT inside React Flow). Hotkey
`Ctrl/Cmd+Shift+M`: quick-press = toggle, press-and-hold = push-to-talk (app-focused only).
Silence auto-STOP ~15 s + ~2 min cap — stop, never submit. Full state table: SPEC §3
(`idle/listening/finalizing/reviewing/no-target/model-missing/mic-denied/error`).

**Scope decision to make at start — pill position persistence.** Plan says "debounced persist
to `voiceConfig.pillPosition`", but `voiceConfig.ts` is a V4 file. Recommended: pull a
MINIMAL `src/main/voiceConfig.ts` forward now (clone `llmConfig.ts`: userData JSON,
write-file-atomic, read-repair; fields `showPill` + `pillPosition` only) + `voice:config:get|set`
— V4 then just adds fields + the Settings UI. Fallback if you want V3 renderer-pure:
localStorage now, migrate in V4 (note it on the board either way). Renderer-pure keeps the
push off the Docker leg; the minimal-config route touches `src/main` → LINUX_SENSITIVE →
have Docker up.

## Testing (V3)

- **Unit (vitest)**: registry lifecycle (register/unregister/overwrite); flyout behavior
  against a mocked registry — assert `paste` called with exact text THEN a discrete `\r`
  (never `text + '\r'` in one write); retarget-on-selection keeps the draft; draft survives
  board delete; pill drag threshold (drag never toggles) + viewport clamp + debounced persist.
- **e2e (Playwright, tag `@terminal` — plus keep `@voice` on voice.e2e.ts)**: stub engine via
  the `VoiceIpcDeps.engine` seam, env-gated (e.g. `CANVAS_E2E`/`CANVAS_VOICE_STUB`) — a fake
  `VoiceEngineHandle` that holds the MessagePortMain and posts canned `{t:'partial'}` /
  `{t:'final'}` (no model, no mic; fake media covers getUserMedia). Assert: pill renders +
  toggles; flyout opens on first partial; edited text + Send → **exact PTY bytes** via the
  `e2eTerminalInput` hook (`src/renderer/src/smoke/e2eHooks.ts:173`); Insert = paste only,
  no `\r`. Drag e2e = real PointerEvents (the whiteboard-probe pattern —
  [[e2e-whiteboard-probes]]; synthetic `dispatchEvent` clicks false-green on CSS-transformed
  targets, `sendInputEvent` modifiers don't reach `e.altKey`).
- Existing `@voice` e2e (frame counting) must STAY green — it runs modelless via the
  count-only degrade; your stub must not break the real-engine path.
- Manual dev check: `$env:CANVAS_DEV_TITLE='voice V3'; pnpm dev` — confirm the title stamp,
  then dictate with the REAL mic + model (already downloaded on this machine): pill bars
  animate, partials appear as the dimmed-italic tail, endpoint solidifies, Send lands in a
  live claude terminal.

## Sharp edges (learned V0–V2 — don't relearn)

1. **The eos drain handshake is load-bearing.** Renderer dispose posts `{t:'eos'}` as the
   LAST port message; the host defers `session:stopped` until it sees it (1 s fallback).
   Port-vs-parentPort delivery order is NOT guaranteed cross-queue — a cold recognizer init
   (~2 s host-loop block) once let `session:stop` overtake queued frames → `frames=0` →
   blocked the push. Anything V3 adds to the port protocol must keep eos last.
2. **COPY frames/payloads across cross-process ports, never transfer** — a non-port
   transferable in the transfer list silently NULLS `e.data` ([[electron-port-transfer-null-payload]]).
3. **Prod CSP is test-locked** (`src/main/csp.ts`) — no blob workers, no remote fetch, no
   inline styles beyond what's there. If V3 UI seems to need a CSP change, the design is wrong.
4. **Hotkey**: Electron's menu can eat accelerators before the renderer sees them (Alt+V
   case, [[terminal-io-feature]] #81). Verify `Ctrl/Cmd+Shift+M` actually reaches a renderer
   keydown with a real press; also mind xterm.js key capture when a terminal is focused —
   the hotkey must work while a Terminal board has focus (that's the primary flow).
5. **Overlay z-order**: pill/flyout are screen-fixed islands — anchor math must use viewport
   coords, not canvas coords; flyout flips below near the top edge; keep both above board
   chrome but below modals (match the toast/minimap layering in the islands CSS).
6. Tooling: node 22.17 via nvm + `corepack pnpm` (system node 25 skews vitest). Full unit
   suite inside an Expanse terminal needs env sanitizing ([[cc-inside-expanse-test-env]]):
   `env -u CANVAS_RECAP_BOARD TMP='C:\Users\De Asis PC\AppData\Local\Temp' TEMP='C:\Users\De Asis PC\AppData\Local\Temp' corepack pnpm test`.
7. Bash-tool commits: backticks in `-m` get substituted — quoted-heredoc `git commit -F -`.
8. Pushes: `env -u SSH_ASKPASS`; gh account `ch923dev` (`gh auth switch` first). If the push
   is main/preload-touching, Docker must be up ([[linux-e2e-leg-needs-docker-running]]).
9. Styling: match `src/renderer/src/index.css` tokens (blue `#4f8cff`, no gradients/glow).
   Meridian redesign is queued and restyles all chrome — build to current tokens; Meridian
   will sweep it.

## Exit criteria (V3 done =)

- [ ] Pill renders (overlay island), drags with threshold + clamp, position persists across
      relaunch; click + hotkey toggle listening; bars driven by live RMS.
- [ ] Flyout: opens on first partial; dimmed-italic tail; only the tail replaced on final;
      editable throughout; Enter=Send / Shift+Enter=newline / Esc semantics; target row
      tracks `selectedId`; `no-target` + `model-missing` (Download CTA + progress) +
      `mic-denied` states render per SPEC §3.
- [ ] Send = bracketed paste then ONE discrete `\r` after settle, only when `running[id]`;
      Insert = paste only. Verified byte-exact in e2e AND manually against a real agent CLI.
- [ ] Draft survives selection change / board delete / Esc-close.
- [ ] Unit + Windows e2e green (flake policy: `docs/testing/TESTING.md`); cheap trio green;
      existing `@voice` spec still green; manual dev check done under a `CANVAS_DEV_TITLE`
      stamp.
- [ ] Committed as `feat(voice): V3 — …`; board row updated; README Status flipped;
      this handoff superseded (write HANDOFF-V4 if handing off again).
