# HANDOFF — Voice slice V1: capture pipeline + `voice:port`

> For the session picking up V1. Worktree: `Z:\Canvas ADE\.worktrees\voice-to-text`
> (branch `feat/voice-to-text` — one session per worktree; do NOT work in the main checkout).
> Read `IMPLEMENTATION-PLAN.md` (V1 section) + `SPEC.md` §2–4 first. This doc is the
> state snapshot + the sharp edges; it is deleted when the epic merges (doc lifecycle).

## State at handoff (2026-07-02)

- Branch has 2 commits on top of `origin/main` @ `038fc64`:
  - `902db48` research package (REPORT/SPEC/plan/approved pill mock).
  - `58dc71c` **V0 shipped**: `src/main/micPermission.ts` (+15 unit tests) — default-session
    permission posture (audio-only `media` + `clipboard-sanitized-write` for the app page,
    request AND check handlers, everything else denied); macOS mic usage-string +
    `audio-input` entitlement in both plists; `.impeccable/` prettierignored.
- Gate at V0: typecheck · lint 0-err · format · 4141 unit · live `_electron` probe
  (audio GRANTED / video DENIED / clipboard OK / labels enumerable) · Windows e2e 242P
  (1 `osrCropSupersample` fail = the documented OSR-teardown flake, rerun-clean).
- **NOT pushed.** First push diffs from merge-base → `src/main` touched → pre-push runs the
  FULL matrix incl. the Docker Linux leg. Docker daemon confirmed up (29.5.3).
- Coordination board row exists (`voice-to-text`); **`src/main/index.ts` is cross-zone with
  the `bg-sessions` lane** — V0 added one import + one `registerMicPermissionPosture` call in
  `createWindow` beside `createNavGuard`; keep any V1 index.ts touch equally minimal and
  update the board row if you add one.

## V1 scope (exit: audio frames provably flow renderer → MAIN)

Build the mic capture pipeline and the `voice:port` data plane. **No engine (V2), no UI
(V3), no config file (V4), no board-schema or `csp.ts` changes (ever).**

New files:
- `src/renderer/src/voice/captureWorklet.ts` — AudioWorklet processor: downsample
  48 kHz float32 → **16 kHz mono Int16**, emit ~120 ms frames (1920 samples / 3840 bytes)
  as **transferable ArrayBuffers**, plus a per-frame RMS level. Cheap energy endpointer
  state can wait for V3/V5 — V1 needs level + frames only.
- `src/renderer/src/voice/useVoiceCapture.ts` — getUserMedia({audio:{deviceId?}}) +
  AudioContext + worklet wiring; forwards frames onto the voice MessagePort; owns the
  **silent-zeros watchdog** (N consecutive zero-RMS frames while capturing → flag
  `micSilent` in the store; missing OS mic permission yields a LIVE all-zeros stream,
  NOT an error — electron#42714).
- `src/renderer/src/store/voiceStore.ts` — Zustand, **ephemeral only** (never serialized):
  `{ capturing, level, micSilent, activeBoardId? }` + actions.
- `src/main/voiceIpc.ts` — control plane `voice:session:start|stop` (ipcMain.handle) +
  port broker: `MessageChannelMain`, port1 → renderer, port2 → a **logger stub** engine end
  this slice (counts frames, logs cadence under a debug flag; the real utilityProcess host
  replaces it in V2 behind the same seam).
- Preload: `window.api.voice = { start, stop }` + the `voice:port` re-post.

## The seams to clone (exact pointers, verified during V0)

- **Port transfer pattern** — clone `pty:port` verbatim:
  - MAIN side: `MessageChannelMain` + `win.webContents.postMessage('pty:port', {id}, [port2])`
    → `src/main/pty.ts` (~line 487, inside the spawn handler; `attachPortInput` at
    `pty.ts:77` is the receive-side shape).
  - Preload re-post (ports can't cross contextBridge): `src/preload/index.ts:995-1005` —
    `window.postMessage({ __ptyPort: true, id }, origin, e.ports)`; renderer reads
    `event.ports[0]`. Name yours `__voicePort`.
  - `window.api` namespace + `contextBridge.exposeInMainWorld`: `src/preload/index.ts:~1008`;
    types in `src/preload/index.d.ts`.
- **Bundled module worker (CSP-safe)** — the ONLY worker shape prod CSP allows:
  `new Worker(new URL('./osrBlitWorker.ts', import.meta.url), {type:'module'})` at
  `src/renderer/src/canvas/boards/useOffscreenPreview.ts:59`. For an AudioWorklet the
  equivalent is `audioWorklet.addModule(new URL('./captureWorklet.ts', import.meta.url))` —
  verify electron-vite emits the worklet chunk; if `addModule(URL)` fights the bundler,
  the fallback is a same-origin emitted asset path, NEVER a blob: URL (CSP blocks it).
- **IPC channel naming**: `namespace:verb` — `voice:session:start`, `voice:session:stop`,
  `voice:port` (match `pty:*`/`llm:*` style).
- **Permission posture is already done** (V0) — renderer `getUserMedia({audio})` is granted
  for the app page; do not add per-call permission code.

## Testing (V1)

- **Unit (vitest)**: downsampler math + frame framing as PURE functions (factor them out of
  the worklet file or into a `captureMath.ts` the worklet imports — worklet global scope
  doesn't exist under vitest). Silent-zeros watchdog counter logic. voiceStore actions.
- **e2e probe (Playwright `_electron`, tag `@terminal` or a new `@voice`)**: launch with
  fake media, call `window.api.voice.start()`, assert `voiceStore` level rises / frames
  count up (expose the counters on the existing `CANVAS_E2E` seam — see
  `src/renderer/src/smoke/e2eRegistry.ts` for the registry pattern; MAIN-gated, BUG-057).
- **Fake media MUST be env-gated in MAIN, not Playwright launch args** (playwright#16621):
  in `src/main/index.ts` (or better: inside `voiceIpc.ts` registration to keep index.ts
  minimal — but appendSwitch must run before `app.ready`, so it likely lands beside the
  other early `app.commandLine` calls): `CANVAS_FAKE_MEDIA=1` →
  `app.commandLine.appendSwitch('use-fake-device-for-media-stream')`; optional
  `CANVAS_FAKE_MEDIA_WAV=<path>` → `use-file-for-fake-audio-capture` (16-bit PCM WAV;
  append `%noloop` to play once). V0's probe passed the flag as a launch arg and it DID
  work on this machine — keep the env-gate anyway (deterministic across harnesses).
- Gate before handing off V1: cheap trio + full unit + **Windows e2e leg** (+ flake-rerun
  policy: `docs/testing/TESTING.md`); the Linux leg joins at push time automatically
  (`src/main`+`src/preload` = LINUX_SENSITIVE). Manual dev check with
  `$env:CANVAS_DEV_TITLE='voice V1'; pnpm dev` — confirm the title stamp, start a capture
  from devtools (`window.api.voice.start()`), watch MAIN's stub log frames.

## Sharp edges (learned so far — don't relearn)

1. **Silent-zeros ≠ error** (electron#42714) — the watchdog is a REQUIREMENT, not polish.
2. **No blob workers, no remote fetch, no wasm in renderer** — prod CSP (`src/main/csp.ts`,
   test-locked). If anything in V1 seems to need a CSP change, stop — the design is wrong.
3. **voiceStore is session-state** — never route anything into `boardSchema`/`PATCHABLE_KEYS`.
4. **`.impeccable/hook.cache.json`** regenerates locally; it's prettierignored now — if
   `format:check` ever flags a path you didn't touch, check for new tool caches before
   touching shared config.
5. Node for tooling = 22.17 via nvm + `corepack pnpm` (system node 25 skews vitest).
6. Bash-tool commits: backticks in `-m` get substituted — use the quoted-heredoc `-F -` form.
7. AudioWorklet frame cadence: 128-sample quanta @ 48 kHz → accumulate ~45 quanta per 120 ms
   frame; don't postMessage per quantum (IPC storm).

## Exit criteria (V1 done =)

- [ ] `window.api.voice.start()` in the dev app → MAIN stub logs steady ~8 frames/s;
      `stop()` halts them and releases the mic (track stopped, AudioContext closed).
- [ ] Level + silent-zeros state observable in `voiceStore` (devtools) + e2e counters.
- [ ] Unit + Windows e2e green (flake policy applies); cheap trio green.
- [ ] Committed on `feat/voice-to-text` as `feat(voice): V1 — …`; board row updated;
      this file's row in README Status flipped.
