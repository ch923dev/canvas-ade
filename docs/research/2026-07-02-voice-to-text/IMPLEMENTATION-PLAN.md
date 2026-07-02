# IMPLEMENTATION PLAN — Voice dictation (slices V0–V5)

> **Status: FINAL — approved 2026-07-02.** Design artifact (pill widget, mock v2) signed off
> as-is; default model = Kroko (both cataloged, license note in Settings); win-arm64 =
> feature-gated off in v1. Research-verified deps per REPORT.md. Build lives on a
> **`feat/voice-to-text` worktree** (this package moves onto that branch in its first
> commit). Each slice ends runnable + testable; merge sequentially with the full gate per
> repo convention.

## Dependencies (verified 2026-07-02)

- `sherpa-onnx-node@^1.13.3` — runtime `dependencies` (MAIN-side; renderer never touches it).
  Prebuilt N-API platform packages via optionalDependencies; **no install scripts, no
  electron-rebuild** (verify after install: `node -e "require('sherpa-onnx-node')"`).
- `electron-builder.yml` asarUnpack additions: `node_modules/sherpa-onnx-node/**`,
  `node_modules/sherpa-onnx-*/**` (shared libs must sit beside the `.node`).
- Models: never bundled; pinned manifest in `src/main/voiceModels.ts` (see V2).

## Slice V0 — mic permission + packaging posture (pure security win, no feature)

Files: new `src/main/micPermission.ts` + wiring in `src/main/index.ts`;
`electron-builder.yml`; `build/entitlements.mac.plist` + inherit plist.
- Default-session `setPermissionRequestHandler`: `permission === 'media'` AND
  `details.mediaTypes` = exactly `['audio']` AND own origin → allow; everything else deny.
  **Plus `setPermissionCheckHandler`** (gates `enumerateDevices` labels — Electron leaks
  them pre-grant otherwise). Existing deny-all sessions (previewOsr, diagramWorker) untouched.
- macOS: `mac.extendInfo.NSMicrophoneUsageDescription`;
  `com.apple.security.device.audio-input` in **both** entitlements plists (helpers capture).
- Tests: vitest unit on the handler predicate (permission-name table, mediaTypes variants,
  cross-origin deny) mirroring `windowSecurity.test.ts`; `csp.test.ts` green = CSP untouched.

## Slice V1 — capture pipeline + voice:port (runnable: level meter)

Files: `src/renderer/src/voice/captureWorklet.ts` (AudioWorklet, bundled module worker —
the `osrBlitWorker` mechanism; 48 kHz→16 kHz mono Int16, ~120 ms frames, RMS level),
`src/renderer/src/voice/useVoiceCapture.ts`, `src/renderer/src/store/voiceStore.ts`
(ephemeral only), preload `window.api.voice` + `voice:port` re-post (clone of `pty:port`,
`src/preload/index.ts:995-1008`), `src/main/voiceIpc.ts` (port broker; engine end = logger
stub this slice).
- IPC: `voice:session:start|stop` (invoke) + `voice:port` transfer.
- **Silent-zeros watchdog**: N frames of zero RMS while "listening" → surface mic-denied
  state (check `systemPreferences.getMediaAccessStatus('microphone')` from MAIN).
- Fake media for tests: `CANVAS_FAKE_MEDIA=1` → MAIN `app.commandLine.appendSwitch(
  'use-fake-device-for-media-stream')` (+ optional `use-file-for-fake-audio-capture`,
  16-bit PCM WAV, `%noloop`). Env-gated in MAIN, NOT Playwright launch args
  (playwright#16621 unreliability); matches the `CANVAS_SMOKE` pattern.
- Tests: vitest units for downsampler math + framing (pure functions); Playwright probe:
  level meter animates under fake media.

## Slice V2 — engine host + models (runnable: WAV fixture → transcript events) [SPIKE FIRST]

Files: `src/main/voiceEngineHost.ts` (utilityProcess entry, out/main bundle),
`src/main/voiceEngine.ts` (`VoiceEngine` interface + spawn/lifecycle/restart),
`src/main/voiceModels.ts` (catalog, download, sha256 verify, delete), `voiceIpc.ts` wiring,
`package.json`, `electron-builder.yml`.
- **Spike gate (do first, half a day)**: sherpa-onnx-node loading inside `utilityProcess`
  under dev AND `pnpm pack:dir` (asar.unpacked path via custom loader — the paseo
  precedent, sherpa issues #3108/#2622). macOS later needs rpath layout, not DYLD env
  (SIP); `allowLoadingUnsignedLibraries` available pre-certs. If the spike fails →
  in-MAIN host behind the same interface (one file), decision logged here.
  - **✅ SPIKE PASSED 2026-07-02 (win-x64, both legs) → utilityProcess host is GO.**
    Dev: loads via the shared node_modules. Packaged: resolves *through* `app.asar`
    (Electron's patched fs) and the `.node` + DLLs auto-redirect to `app.asar.unpacked` —
    **no custom loader needed on Windows** (keep the paseo loader in reserve for the macOS
    rpath leg, V5). asarUnpack globs added (`sherpa-onnx-node/**`, `sherpa-onnx-*/**` —
    whole-dir, DLLs must stay beside the .node). Gate machinery kept for V5:
    `CANVAS_VOICE_SPIKE=1|<result-file>` env → forks the host, prints
    `VOICE_SPIKE_OK|FAIL`, exits (spike runs isolate userData to a temp dir so the packaged
    leg doesn't fight an installed Expanse for the single-instance lock). Environment
    gotcha hit while packing: a RUNNING installed Expanse with a project watcher on the
    repo permanently locks fresh `.asar` files (Electron asar-fs handle cache) →
    electron-builder EBUSY; workaround = pruned `-c.electronDist` copy (robocopy /XF
    default_app.asar version) + fresh output dir. Product fix owed: FileWatcher should
    ignore `**/*.asar`.
- Engine loop: `OnlineRecognizer` + per-session stream; `acceptWaveform` per frame;
  `getResult` → `{t:'partial'}`; `isEndpoint` → `{t:'final'}` + `reset`. Endpoint rules:
  start from example defaults (rule1 2.4 s / rule2 1.2 s), tune in V5.
- Model catalog v1: **Kroko EN 55 MB = default (approved; published sha256; CC-BY-SA note
  shown in Settings)** + Apache int8 zipformer repack (~70 MB, self-pinned sha256) as the
  alternative pick. Download: `.part` → hash → atomic rename into
  `userData/voice-models/<id>/`.
- IPC: `voice:models:list|download|delete|status`.
- Tests: vitest integration — 16 kHz WAV fixture through the engine interface (skips when
  model absent; CI caches the small model); download units w/ mocked fetch (hash mismatch →
  reject + `.part` cleanup).

## Slice V3 — pill widget + flyout + injection (runnable: dictate → edit → Send lands in the CLI)

> Reworked after mock-v1 feedback: floating **VoicePill** overlay (logo + waveform bars,
> draggable, screen-fixed) + **VoiceFlyout** review panel. **Terminal board DOM untouched.**

Files: `src/renderer/src/voice/VoicePill.tsx` + `VoiceFlyout.tsx`,
`src/renderer/src/styles/islands/voice-pill.css` (new partial at its cascade slot — islands
convention like toast/minimap), mount in the app-level overlay layer beside the other
islands (`App.tsx`/`Canvas.tsx` chrome slot),
`src/renderer/src/canvas/boards/terminal/terminalInputRegistry.ts`, edits
`useTerminalSpawn.ts` only (register/unregister beside `e2eTerminals`, ~lines 701/1001),
hotkey registration (quick-press toggle / press-and-hold PTT on `Ctrl/Cmd+Shift+M`).
- Pill: drag via pointer events with a small movement threshold (drag never toggles the
  mic), viewport clamp, debounced persist to `voiceConfig.pillPosition`; `showPill` toggle;
  bars driven by the V1 RMS level; red status dot on mic-denied.
- Flyout: anchored above the pill (flips below near top edge); target row bound to
  `useCanvasStore.selectedId` (+ terminal type + `running` check → `no-target` state);
  interaction contract from `SubmitWell.tsx`: auto-grow textarea (~6 rows cap), Enter=Send,
  Shift+Enter=newline, `isComposing` guard. Dimmed-italic partial tail; only the tail
  replaced on final. Draft survives selection change / board delete / Esc-close.
- Injection: `paste(boardId, text)` = `term.paste()` (bracketed); `submit()` = `sendInput('\r')`
  after ~150 ms settle. **Send is the only `\r` emitter.** Insert/Send disabled when
  `!useTerminalRuntimeStore.running[id]`.
- Silence auto-STOP ~15 s + ~2 min cap — never auto-submit (`autoSendOnFinal` hard-false).
- Tests: vitest registry lifecycle + flyout behavior (mocked registry — assert paste then
  discrete `\r`; retarget-on-selection; draft preservation) + pill drag/persist units;
  Playwright e2e with a `CANVAS_E2E` **stub engine** (canned partial/final over the real
  port; no model, no mic) asserting pill/flyout rendering + exact PTY bytes via
  `e2eTerminalInput`; drag e2e uses real PointerEvents (the whiteboard-probe pattern).
  Tag `@terminal` for e2e scoping.

## Slice V4 — settings + config

Files: `src/main/voiceConfig.ts` (clone `llmConfig.ts`: userData JSON, write-file-atomic,
read-repair; shape per SPEC §5) + test cloned from `llmConfig.test.ts`; `voiceIpc.ts`
`voice:config:get|set`; `SettingsModal.tsx` Voice section (engine select w/ Cloud greyed,
model picker w/ size + download/delete state, language, mic device, hotkey); preload surface.

## Slice V5 — hardening + platform validation

- silero VAD engine-side (bundled with sherpa — config, not a new dep); endpoint tuning.
- Error surfaces per SPEC states; engine crash → auto-restart once, then `error` state with
  draft preserved.
- Packaged validation: `pack:dir` smoke that the `.node` + shared libs load from
  `app.asar.unpacked` on all 3 OSes (node-pty precedent test shape); **win-arm64:
  feature-gated off (approved)** — pill hidden, Settings section shows "unavailable on this
  platform".
- Optional single-platform real-audio e2e via `use-file-for-fake-audio-capture` + the real
  default model.
- Docs: TESTING.md e2e-tag note; build-history entry; this package collapses per doc
  lifecycle when the epic ships.

## Collision map / scheduling

- Files shared with in-flight work: `useTerminalSpawn.ts` (terminal zone — check
  ACTIVE-WORK.md lanes before starting; `TerminalBoard.tsx` is no longer touched after the
  pill rework), `SettingsModal.tsx`, `App.tsx`/`Canvas.tsx` overlay slot,
  `electron-builder.yml` (release-packaging lane), `src/main/index.ts` (small wiring).
- **Queue position**: after Board-Inspector umbrella→main; around the Meridian redesign
  epic (Meridian restyles all renderer chrome — land VoiceComposer either before Meridian
  starts or style it to Meridian tokens); launch month Jul 2–31 freezes risk-appetite —
  V0 (security win) can land independently any time.
- Full-matrix e2e at pre-merge per repo convention; `src/main` + `src/preload` changes make
  every push LINUX_SENSITIVE (Docker leg required — have Docker up).
