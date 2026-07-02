# Voice-to-text (dictation) — research package

> **Status:** BUILD IN PROGRESS on `feat/voice-to-text` (worktree
> `.worktrees/voice-to-text`). V0 ✅ shipped `58dc71c` (mic permission posture + mac
> entitlements). V1 ✅ shipped (capture pipeline + `voice:port` + logger-stub engine end;
> gate + Win e2e green, ~8.3 frames/s verified end-to-end; branch not pushed). **NEXT: V2
> — engine host + models (SPIKE FIRST), see
> [IMPLEMENTATION-PLAN.md](IMPLEMENTATION-PLAN.md).** V2–V5 pending. One V1 gotcha for
> V2's port work: Electron cross-process MessagePorts NULL `e.data` when a non-port
> transferable rides the transfer list — COPY frames across the boundary (see
> `useVoiceCapture.ts`).

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
5. **[HANDOFF-V1.md](HANDOFF-V1.md)** — live handoff for the next slice (state snapshot,
   seams with file:line pointers, sharp edges, exit criteria).

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
