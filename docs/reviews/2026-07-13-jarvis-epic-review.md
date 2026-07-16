# Jarvis epic review (2026-07-13) — COMPLETE, all findings fixed or dispositioned

**Scope:** the full Jarvis voice-agent epic diff vs `main` (umbrella @ `ce1323be`, 0.17.0 —
64 files, +9.7k): J1 TTS engine (#329) · J2 playback/duplex (#335) · J3 brain+persona (#339) ·
panel surface (#341). **Method:** four parallel deep-review passes (main-process brain ·
main-process TTS/models · renderer playback/barge-in · panel UI/e2e), each hunting what per-PR
review misses — cross-module races, crash sinks, resource lifecycles. Findings deduplicated;
MIC-1 found independently by two reviewers.

**Verdict:** slice quality high (engine/worker plumbing, port discipline, epoch cancellation,
SEC-2 pins, listener hygiene all held). Defects clustered in exactly two seams: **multi-step
async transitions guarded by single-shot precondition checks** (MIC-1/2, BRAIN-1, TTS-4,
TURN-1) and **the filesystem/crash boundary** (TTS-1/2/3, BRAIN-2).

**Findings: 2 critical · 8 major · 13 P2 · 2 nits — ALL fixed or explicitly dispositioned**
across three waves:

- **Review wave `fix/jarvis-review-wave` #343 (0.17.1, 2026-07-13) + mic-supersede #350:**
  all P0 (MIC-1 mic-gate arm/close race = hot mic behind a closed panel · MIC-2 disarm gated on
  `capturing` · TTS-1 download write-stream error → whole-app exit, incl. the pre-existing STT
  path · BRAIN-2 unguarded turn-body push on a destroyed window) and all P1 (BRAIN-1 abort-dead
  turn still paid the full Anthropic request · TTS-2 delete-while-download component race ·
  TTS-3 size-only readiness made corruption permanent · ESC-1 app-wide capture-phase Esc grab ·
  HIST-1 per-project history never hydrated — decision: **read-back hydrate on panel mount**,
  hydrated turns carry `at: 0` · TTS-4 barge-in flush watermark missed the in-flight utterance),
  plus the cheap P2s (BRAIN-4 · TURN-1 · DUCK-1 · NIT-1/2). Every fix carries a regression test.
- **J4 hands #352 (0.21.0):** BRAIN-5 closed via the J4 injection audit — `jarvisManifest.ts`
  `neutralize()` flattens every C0/C1 control + U+2028/U+2029 in board titles AND group names
  before the length clip (one board = exactly one manifest line, regression-tested). Audit
  record: tool args = model output = untrusted (MAIN-side type/length checks, live-model
  reference resolution, human confirm on every mutating tool, no destructive tools in the
  catalog); browser-board content has no unvetted path into tool args; confirm-origin ALS stamp
  is MAIN-set only (caller-supplied `origin` stripped, regression test).
- **J5 polish #354 (0.22.0, 2026-07-17) — deferred tail closed:** BRAIN-3 (typed stall abort,
  opaque transport errors) · TTS-5 (`clampSid` vs live `numSpeakers`) · TTS-6 (addon-unavailable
  escalates `ok:false` instead of the no-model degrade) · TTS-7 (`evictAllBut` unpins worker
  caches on model switch) · MIC-3 (mic strip reports actual capture state incl. denied) ·
  BADGE-1 (stale attention marks for deleted boards inert) · PANE-1 (PersonaPane subscribes
  `jarvis:config:changed` with echo suppression) · E2E-1 (Settings-disable-while-open,
  disarm/re-arm, badge/chip specs added).

**Clean/verified holds:** SEC-2 `e.source === window` pins on both voice-port adopters;
queued-clause barge-in epoch + stall-watchdog re-arm intact; no AudioContext/IPC-listener leaks;
IPC sender validation on every voice/TTS/jarvis channel; key material never crosses IPC outbound.

**Raw finding cards (git history):** `docs/reviews/2026-07-13-jarvis-epic-review/REVIEW.md` —
`git log --all --oneline -- docs/reviews/2026-07-13-jarvis-epic-review/` and check out that path.
