# HANDOFF — Voice slice V4: settings + config

> For the session picking up V4. Worktree: `Z:\Canvas ADE\.worktrees\voice-to-text`
> (branch `feat/voice-to-text` — one session per worktree). Read `IMPLEMENTATION-PLAN.md`
> §V4 + SPEC.md §5 first. This doc = the V3 state snapshot + the seams V4 consumes.
> Supersedes `HANDOFF-V3.md` (kept until the epic-merge doc collapse).

## State at handoff (2026-07-03, V3 complete)

- V0–V3 all built on `feat/voice-to-text`. V3 = VoicePill + VoiceFlyout + terminal
  injection, committed as `feat(voice): V3 — …` (see git log / build-history for the SHA).
  Full flow PROVEN with the real engine + real Kroko model (fixture WAV as mic): partial
  tail → finals appended → edit → Send lands exact bytes + ONE discrete `\r` (screenshots
  were taken during the dev check; pwsh executed the submitted line).
- **What V3 shipped (the seams V4 touches):**
  - `src/main/voiceConfig.ts` — the MINIMAL config slice pulled forward per the V3 scope
    decision: `{ showPill: boolean, pillPosition?: {x,y} }`, llmConfig-style
    (userDataDir-keyed pure file I/O, write-file-atomic, `repairVoiceConfig` read-repair
    funnel). **V4 extends THIS file** with `engine/modelId/language/micDeviceId/hotkey/
    autoSendOnFinal(false!)/cloudProvider` per SPEC §5 — extend `repairVoiceConfig` too;
    keep every new field optional/read-repaired so existing configs stay valid.
  - `voice:config:get|set` in `voiceIpc.ts` (frame-guarded; set = merge-patch through
    `repairVoiceConfig`). Preload surface: `window.api.voice.config.get()/set(patch)`
    (`src/preload/voice.ts` › `VoiceConfigView` — widen it with the V4 fields).
  - `src/renderer/src/voice/VoicePill.tsx` — pill overlay island (drag/clamp/persist,
    hotkey Ctrl/Cmd+Shift+M quick-press toggle + hold-PTT, silence auto-STOP ~15 s +
    ~2 min cap, mic-denied hoist). Reads `showPill` at mount; **V4's Settings toggle
    should push a live update** (today it only applies on next mount — add a
    `voice:config:changed` push or re-read on Settings close).
  - `src/renderer/src/voice/VoiceFlyout.tsx` — review composer (mirror-overlay partial
    tail, Enter/Shift+Enter/Esc per SubmitWell contract, no-target / model-missing +
    Download CTA + progress / mic-denied rows). `injectTranscript(targetId, submit)` is
    the ONLY injection path: paste → 150 ms settle → ONE discrete `\r`, `running[id]`
    re-checked at fire time. **Send stays the only `\r` emitter.**
  - `src/renderer/src/canvas/boards/terminal/terminalInputRegistry.ts` — `boardId →
    {paste, submit}`; registered in `useTerminalSpawn.ts` beside `sendInput` (~:730),
    unregistered in teardown (~:1015). Terminal zone is shared — check ACTIVE-WORK.md.
  - `voiceStore` V3 fields: `draft/partial/flyoutOpen/micStatus/modelStatus/lastVoiceAt/
    captureStartedAt` + `joinFinal` (edge-trims segments — sherpa leads finals with a
    space). Still 100% ephemeral — nothing near boardSchema/PATCHABLE_KEYS.
  - e2e stub engine: `src/main/voiceEngineStub.ts` behind voiceIpc's engine fallback,
    runtime-toggled via `__canvasE2EMain.voiceStubSet(on)` (e2eMain — NOT a launch env:
    workers:1 shares one app across spec files; an env gate would hijack voice.e2e.ts and
    lose the real-host coverage). `e2e/voiceComposer.e2e.ts` (@terminal @voice, 5 specs)
    always flips it back off. `readTerminalInputChunks` (e2eHooks) proves the
    discrete-`\r` byte shape.
- **V3 sharp edges learned (don't relearn):**
  1. `voiceEngine.stopSession` default timeout is now **30 s** (was 10 s): a COLD Kroko
     init under machine load (parallel suites/Docker) measured >10 s blocking the host
     loop → stop reported frames=0 + the renderer kept capturing — this presented as the
     @voice e2e failing "frames 0 / capturing stuck" and looked exactly like a V3
     regression (it wasn't; host bundles were byte-identical). If @voice flakes cold,
     suspect load, rerun; the real fix (async recognizer init in the host) is V5.
  2. The flyout textarea's `listening…` placeholder must stay suppressed while a partial
     exists — the mirror renders the tail behind a transparent textarea and the
     placeholder overlap-garbles (fixed; screenshot-caught).
  3. The fake-media TONE's RMS is ~0.001 — BELOW `SILENCE_RMS` (0.015). Any e2e capture
     left open ≥15 s will be auto-stopped by the pill babysitter. Keep e2e captures short
     or account for it.
  4. Pill/flyout z-index is **120** — deliberately BELOW the full-view scrim (200): a
     290-class pill floated over full-view terminals in every spec (cross-spec occlusion
     flake class). Dictation into a full-view board = hotkey works, review UI hidden —
     acceptable for V3; revisit in V5 if wanted.
  5. The drag e2e drags the pill BACK afterward — pillPosition persists to the SHARED dev
     userData voice-config.json (sticky-prefs isolation class).
- Coordination: board row `voice-to-text` in ACTIVE-WORK.md is current; `main` moved to
  `f2312c1` (PR #281) during V3 — the branch was rebased before push (or rebase before
  yours). `useTerminalSpawn.ts` + `src/main/index.ts` remain cross-zone with bg-sessions.

## V4 scope (plan §V4)

Files: extend `src/main/voiceConfig.ts` (+ test — clone remaining llmConfig.test shapes);
`voiceIpc.ts` `voice:config:*` already exist (widen the view); `SettingsModal.tsx` Voice
section: engine select (Cloud greyed "coming soon"), model picker (size + downloaded /
download / delete state — reuse `voice.models.*` + `onDownloadProgress`), language, mic
device (`enumerateDevices` — labels ARE gated by V0's permission-check handler, verify
they appear post-grant), hotkey field, `showPill` toggle. `autoSendOnFinal` MUST stay
hard-false (SPEC §2) — render it disabled/hidden, never honored.
- SettingsModal is a SHARED file (collision map) — check ACTIVE-WORK.md lanes first.
- Hotkey config: VoicePill's `isVoiceHotkey` is hardcoded Ctrl/Cmd+Shift+M — V4 reads the
  configured accelerator (keep `code`-based matching; mind xterm capture-phase note in
  VoicePill).
- Mic device: `useVoiceCapture`'s getUserMedia currently `{ audio: true }` — V4 threads
  `micDeviceId` through (deviceId exact constraint, fall back to default).

## Testing (V4)

Units: voiceConfig field repair/roundtrip; Settings section render/interaction against a
mocked `window.api.voice`. e2e: keep @voice + the composer spec green (no stub changes
needed); a Settings-section smoke can ride @chrome. Gate per repo convention: cheap trio +
units + Windows e2e; FULL matrix at pre-merge (main/preload touches → LINUX_SENSITIVE).

## Exit criteria (V4 done =)

- [ ] SPEC §5 config shape persisted + read-repaired; older configs open clean.
- [ ] Settings › Voice section renders per design tokens (design artifact first if the
      section's layout is non-trivial — the design-before-code rule applies).
- [ ] Model picker: download with live progress, delete, default badge, license note
      (Kroko CC-BY-SA per the kickoff decision).
- [ ] showPill toggle applies LIVE; pill position still persists.
- [ ] Hotkey + language + mic device round-trip config → behavior.
- [ ] `autoSendOnFinal` remains unhonored everywhere (grep guard).
- [ ] Units + Windows e2e green; board row + README flipped; HANDOFF-V5 written if
      handing off again.
