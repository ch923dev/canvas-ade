# HANDOFF — Voice slice V5: hardening + platform validation

> For the session picking up V5. Worktree: `Z:\Canvas ADE\.worktrees\voice-to-text`
> (branch `feat/voice-to-text` — one session per worktree). Read IMPLEMENTATION-PLAN.md
> §V5 first. This doc = the V4 state snapshot + the seams V5 consumes.
> Supersedes `HANDOFF-V4.md` (kept until the epic-merge doc collapse).

## State at handoff (2026-07-03, V4 complete)

- V0–V4 all built on `feat/voice-to-text` (V0–V3 pushed; V4 = commits
  `feat(voice): V4a …` + `feat(voice): V4b …` — see git log). Branch rebased onto
  `origin/main` @ `9a28b94` (#289) this session.
- **What V4 shipped (the seams V5 touches):**
  - `src/main/voiceConfig.ts` — the FULL SPEC §5 shape: `engine('sherpa-onnx'|'cloud') /
    modelId / language / micDeviceId? / hotkey? / autoSendOnFinal(false literal) /
    cloudProvider? / showPill / pillPosition?`. Every field optional on disk +
    read-repaired; V3-era files open clean; `autoSendOnFinal` repairs to false even from
    a hand-edited `true` (grep guard held — only type/repair/tests mention it).
  - `voiceIpc.ts`: `voice:session:start` resolves the CONFIGURED model (an id missing
    from the catalog is preserved on disk, falls back to `DEFAULT_VOICE_MODEL_ID` at use
    time — scene-id discipline). `voice:config:set` pushes the repaired config on
    **`voice:config:changed`** — the live-apply channel.
  - `src/preload/voice.ts`: `VoiceConfigView` = full shape + `config.onChanged(cb)`.
  - `src/renderer/src/voice/hotkey.ts` — accelerator grammar (letters/digits/F-keys/
    Space; requires a non-shift modifier; `parseHotkey`/`matchesHotkey`/`hotkeyLabel`/
    `codeToToken`). VoicePill matches `chordRef` (updated live from the push);
    unparsable config falls back to the platform default. Keyup still matches on `code`
    alone (modifiers release first).
  - `useVoiceCapture`: `micDeviceId` → `{ deviceId: { exact } }` constraint
    (`micConstraints` in captureMath.ts), retry `{ audio: true }` when the exact device
    rejects (unplugged headset survives).
  - `src/renderer/src/canvas/SettingsVoiceSection.tsx` — the Settings › Voice section
    (own file: max-lines ratchet). Renders **nothing** (incl. its leading divider) when
    `window.api.voice` is absent — that's what keeps SettingsModal's voice-less unit
    mocks green; keep that guard. ALL fields apply immediately (recap-toggle pattern:
    optimistic + revert on failure); the modal Save button stays LLM-only. Model picker
    drives `voice.models.*` + the `voice:models:progress` push (cumulative
    receivedBytes / whole-model totalBytes). Design artifact `mock-voice-settings.html`
    /`.png` — signed off 2026-07-03.
  - SettingsModal card now has `maxHeight: 86vh + overflowY: auto` — the Voice section
    pushed it past small viewports and the shared Modal centers WITHOUT clip-awareness
    (grid place-items center clips BOTH edges). Don't remove.
- **V4 sharp edges learned (don't relearn):**
  1. Clearing an optional config field over the merge-patch IPC: send `''`, not
     `undefined` — repair's `optStr('')` → undefined; an undefined property risks being
     dropped in serialization so the merge would keep the old value. The section + tests
     encode this (`{ hotkey: '' }` = reset, `{ micDeviceId: '' }` = system default).
  2. The config push deliberately does NOT apply `pillPosition` in VoicePill — the drag
     owns it locally; applying the echo of our own debounced persist would fight an
     in-flight drag.
  3. RTL's `getByTestId` looks for `data-testid`; this repo uses `data-test` — query via
     `document.querySelector('[data-test=…]')` in section tests.
  4. e2e settings spec (`modal.e2e.ts` @chrome @voice) toggles showPill OFF then back ON
     — the e2e userData voice-config is sticky across specs (the V3 drag-back lesson);
     keep the restore.
- Gate at handoff: cheap trio green · full units green (4300+; one unrelated flake class
  rerun-recovers) · Windows e2e: @voice 8/8 (voice 2 + composer 5 + new settings
  live-apply 1) and the full @chrome leg 56/56 with the modal changes.
- Coordination: ACTIVE-WORK.md `voice-to-text` row current. `useTerminalSpawn.ts` +
  `src/main/index.ts` remain cross-zone with bg-sessions. SettingsModal.tsx was claimed
  + released this session.

## V5 scope (plan §V5)

- silero VAD engine-side (bundled with sherpa — config, not a new dep); endpoint tuning.
- **Async recognizer init in the host** — the real fix for the V3 lesson: cold Kroko
  init >10 s under load blocks the host loop (stopSession timeout was bumped 10→30 s as
  the stopgap; keep the 30 s until this lands).
- Error surfaces per SPEC states; engine crash → auto-restart once, then `error` state
  with draft preserved.
- Packaged validation: `pack:dir` smoke that the `.node` + shared libs load from
  `app.asar.unpacked` on all 3 OSes (node-pty precedent). **win-arm64: feature-gated off
  (approved)** — pill hidden, Settings section shows "unavailable on this platform".
  Remember the FileWatcher-locks-.asar gotcha: pack via a pruned `-c.electronDist` copy
  if an installed Expanse is running.
- Optional single-platform real-audio e2e via `use-file-for-fake-audio-capture` + the
  real default model.
- Docs: TESTING.md e2e-tag note; build-history entry; this package collapses per doc
  lifecycle when the epic ships.

## Exit criteria (V5 done =)

- [ ] VAD/endpoint tuning in the host; async init (no cold-start stop-race stopgap).
- [ ] Crash/error surfaces per SPEC §3 states; draft survives an engine crash.
- [ ] pack:dir smoke green (win-x64 here; mac/linux via the matrix); win-arm64 gate.
- [ ] Full e2e matrix green at the epic merge gate; manual dev check with
      `CANVAS_DEV_TITLE` before the epic PR opens (owed from V4: the V4 dev check was
      e2e-driven with screenshots — do the human title-stamped pass at PR time).
- [ ] Doc collapse per lifecycle at the epic merge; build-history entry appended.
