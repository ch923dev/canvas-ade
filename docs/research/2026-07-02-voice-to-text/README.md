# Voice-to-text (dictation) — research package

> **Status:** READY TO BUILD — research, spec, design artifact (approved as-is 2026-07-02),
> and implementation plan all FINAL. This package is **uncommitted research** on `main`;
> when the build starts, move it onto the `feat/voice-to-text` worktree branch per the repo
> doc-lifecycle convention. No code exists yet.

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
