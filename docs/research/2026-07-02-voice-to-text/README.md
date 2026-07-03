# Voice-to-text (dictation) — research package

> **Status:** BUILD IN PROGRESS on `feat/voice-to-text` (worktree
> `.worktrees/voice-to-text`). V0 ✅ shipped `58dc71c` (mic permission posture + mac
> entitlements). V1 ✅ shipped `7f14168c` (capture pipeline + `voice:port`; pushed, full
> matrix green). V2 ✅ shipped (spike `2c756c8` + engine): **sherpa-onnx utilityProcess
> host live** — spike passed dev AND packaged (win-x64, no custom loader needed), pinned
> per-file HF model manifest (Kroko default + Apache int8 alt; per-file beats the
> release `.tar.bz2` — Node has no bzip2), download/verify/delete IPC, streaming
> recognizer loop (partial/final over the session port), WAV-fixture integration test
> green against the real model. V3 ✅ shipped: **VoicePill + VoiceFlyout + terminal
> injection live** — draggable screen-fixed pill (RMS bars, position persisted via a
> minimal `voiceConfig.ts` pulled forward from V4), flyout review composer (dimmed-italic
> partial tail via a mirror overlay, Enter=Send/Shift+Enter/Esc, no-target /
> model-missing+Download / mic-denied rows), `terminalInputRegistry` injection (Send =
> bracketed paste → ~150 ms settle → ONE discrete `\r`, gated on `running[id]`; Insert =
> paste only), Ctrl/Cmd+Shift+M quick-press toggle + press-and-hold PTT (capture-phase —
> works with a focused terminal), silence auto-STOP ~15 s + ~2 min cap, e2e stub engine
> behind the `VoiceIpcDeps.engine` seam (runtime-toggled via `voiceStubSet` so
> voice.e2e.ts keeps the real host). V4 ✅ shipped: **settings + config live** — full
> SPEC §5 `voiceConfig` shape (read-repaired, V3-era files open clean, `autoSendOnFinal`
> literal-false), Settings › Voice section (design artifact `mock-voice-settings.html`
> signed off 2026-07-03: live showPill toggle, engine select w/ Cloud greyed, radio model
> picker w/ download-progress/delete/DEFAULT badge/CC-BY-SA note, language, mic device,
> hotkey capture field), `voice:config:changed` push (showPill/hotkey apply LIVE, no
> remount), configured accelerator via `voice/hotkey.ts` (code-based, default fallback),
> `micDeviceId` exact-constraint w/ default retry, configured model honored at session
> start. **NEXT: V5 — hardening + platform validation, see
> [HANDOFF-V5.md](HANDOFF-V5.md) + [IMPLEMENTATION-PLAN.md](IMPLEMENTATION-PLAN.md).** Gotchas
> for later slices: Electron cross-process MessagePorts NULL `e.data` when a non-port
> transferable rides the transfer list — COPY frames across the boundary
> (`useVoiceCapture.ts`); a RUNNING installed Expanse watching the repo locks fresh
> `.asar` files forever → pack via a pruned `-c.electronDist` copy (see
> IMPLEMENTATION-PLAN › V2 spike note).

Dictate prompts by voice instead of typing — primarily to drive the agentic CLIs in
Terminal boards. Local-first STT (no API key, offline, private), review-first composer
(no unreviewed text ever reaches a live agent).

## Start here

1. **[REPORT.md](REPORT.md)** — engine landscape + web-verified evidence + decision tables.
2. **[SPEC.md](SPEC.md)** — the feature spec: composer UX, targeting, settings, security
   invariants.
3. **[mock-voice-composer.html](mock-voice-composer.html)** (+ `mock-voice-composer.png`) —
   the design artifact (token-faithful states mock, per the design-before-code rule).
4. **[IMPLEMENTATION-PLAN.md](IMPLEMENTATION-PLAN.md)** — slices V0–V5, per-slice
   files/IPC/tests, collision map. Written after design-artifact sign-off.
5. **[HANDOFF-V5.md](HANDOFF-V5.md)** — live handoff for the next slice (state snapshot,
   seams, sharp edges, exit criteria). `HANDOFF-V1.md` / `HANDOFF-V3.md` / `HANDOFF-V4.md`
   are the superseded editions (kept until the epic-merge doc collapse).

## Decisions locked at kickoff (user-confirmed 2026-07-02)

| Topic | Decision |
|---|---|
| Engine | **Local-first** on-device STT; pluggable cloud tier reserved for later (config placeholder only in v1). |
| UX | **Review-first via a floating pill widget** (reworked 2026-07-02 from the footer-composer mock on user feedback): draggable screen-fixed pill (logo + waveform indicator) + a flyout holding the editable transcript, Insert/Send targeting the selected terminal. Boards untouched. `autoSendOnFinal` hard-`false` in v1. |
| Scope of this package | Research report → spec → design artifact (sign-off) → implementation plan. |

## Positioning

Greenfield: zero prior mentions across roadmap / feature-proposals / research / reviews /
design-reference. Nearest conceptual neighbors: SB-2 Run-on-Agent, OS-2 broadcast input,
shipped QW-1 prompt queue (all terminal-input features). Build must schedule around the
early-access launch month (Jul 2–31) and the queued Meridian redesign epic.
