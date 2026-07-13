# Jarvis epic review — umbrella @ `ce1323be` (0.17.0, post-#341 + main sync)

**Date:** 2026-07-13 · **Scope:** the full J-epic diff vs main (64 files, +9.7k): J1 TTS engine
(#329), J2 playback/duplex (#335), J3 brain+persona (#339), panel surface (#341), synced with
main through #340. Four parallel deep-review passes (main-process brain · main-process TTS/models ·
renderer playback/barge-in · panel UI/e2e), each instructed to hunt what per-PR review misses:
cross-module races, crash sinks, resource lifecycles. Findings below are deduplicated; two
reviewers independently found MIC-1.

**Verdict:** the slice quality is high — engine/worker plumbing, port discipline, epoch
cancellation, SEC-2 pins, and listener hygiene all hold; prior review-round fixes (queued-clause
epoch, stall watchdog re-arm) verified intact. Defects cluster in exactly two seams: **multi-step
async transitions guarded by single-shot precondition checks** (MIC-1/2, BRAIN-1, TTS-4, TURN-1)
and **the filesystem/crash boundary** (TTS-1/2/3, BRAIN-2). Fix P0+P1 before the epic-end
umbrella→main PR.

## Dispositions — review wave `fix/jarvis-review-wave` (0.17.1, 2026-07-13)

**FIXED (with regression tests):** all P0 (MIC-1 · MIC-2 · TTS-1 incl. the pre-existing STT
path · BRAIN-2) and all P1 (BRAIN-1 · TTS-2 · TTS-3 · ESC-1 · HIST-1 · TTS-4), plus the cheap
P2s: BRAIN-4 (the supersede/cancel/destroyed-window/pre-abort tests now exist), TURN-1, DUCK-1,
NIT-1, NIT-2. HIST-1 decision: **read-back hydrate** on panel mount (App gates the panel on
`status==='open'`, so mount = the project boundary) — chosen over clear-on-switch so a
reload/switch-back shows the turns the model actually remembers; hydrated turns carry `at: 0`
(MAIN keeps no timestamps) and render without time/day labels.

**DEFERRED (open):**
- **BRAIN-5 → J4 injection audit (hard MUST — do not lose).**
- BRAIN-3 (typed stall reason), TTS-5 (sid clamp), TTS-6 (addon-load misreport), TTS-7 (worker
  cache eviction), MIC-3 (mic strip vs OS denial), BADGE-1 (stale attention chips), PANE-1
  (config-changed subscription) → J4/J5 follow-up lanes.
- E2E-1 partially addressed in-wave (double-tap hotkey drill + scoped-Esc spec landed); the
  Settings-disable-while-open, mic-strip disarm/re-arm and badge/chip specs remain open.

This doc stays live until the deferred tail lands; collapse to a dated summary then
(docs/reviews README convention).

## P0 — fix before anything else

| id | sev | where | defect | fix shape |
|---|---|---|---|---|
| MIC-1 | critical | `renderer/jarvis/jarvisSession.ts:66-114` | Structural mic-gate checked ONCE pre-await: `setConverseMode(true)` reads `panelOpen` at entry, then awaits `jarvis.status()` + `tts.status()`; a close (double-tap hotkey / Esc after edge-tab click / project close) landing in that window tears down a not-yet-armed session, then the stale arm continuation registers the consumer, sets `converseMode=true`, starts capture → **hot mic behind a closed panel, finals silently sent to the LLM** — the exact state KICKOFF-PANEL §3 promises cannot exist. | Arm-generation token bumped by disarm + fresh `panelOpen` re-check after EACH await; assert in a unit + e2e. |
| MIC-2 | major | `renderer/jarvis/jarvisSession.ts:78` | Disarm gates `stopVoice()` on `voiceStore.capturing`, which only flips true after the full async arm chain (~100s of ms). Close within that window skips the stop → port arrives, mic arms anyway; converse off so finals fall through to the dictation flyout. | Unconditional stop (extra stop on a not-yet-open session is cheap) or a stop-pending latch honored by the capture-start path. |
| TTS-1 | critical | `main/voiceTtsModels.ts:230-247` | Download write stream has NO `'error'` listener; ENOSPC / Defender EPERM mid-stream (likeliest during the 345 MB Kokoro leg) throws into `uncaughtException` → `crashShutdown(1)` — **the whole app exits**. Also strands the `downloading` single-flight set (`voiceIpc.ts:457-478`) until restart. Same defect pre-existing in the STT path `voiceModels.ts:273-289` — fix both. | `'error'` listener → reject → existing cleanup path; regression test with a failing stream. |
| BRAIN-2 | major (crash class) | `main/jarvisIpc.ts:144-176` + `:89-91` | The void'd async turn body has no `.catch`, and `push` doesn't guard destroyed `webContents`. Close the window mid-stream: delta `push` throws (destroyed-but-not-yet-nulled window — index.ts's own `'closed'` comment documents the getter throws), the error/done pushes rethrow OUTSIDE any try → `unhandledRejection` → `crashShutdown(1)`. | `.catch` on the IIFE + `isDestroyed()` guard in `push` (recap-map lesson). |

## P1 — fix in this wave

| id | sev | where | defect | fix shape |
|---|---|---|---|---|
| BRAIN-1 | major | `main/jarvisBrain.ts:169-177` + `jarvisIpc.ts:147` | Abort listener attached to an already-aborted signal never fires; the turn body awaits `getAppModel()` (first turn = full lazy `ensureMcp`, seconds) BEFORE streaming. Barge-in during that await → the dead turn still issues the complete paid Anthropic request (system + manifest + 24-turn history) with a live stall signal, concurrent with the new turn — single-in-flight invariant broken. | `signal.aborted` check at stream entry + after the `getAppModel` await. Add the missing supersede/cancel tests (see BRAIN-4). |
| TTS-2 | major | `main/voiceIpc.ts:481-486` + `voiceTtsModels.ts:272-287` | Delete-while-download race: delete guard only blocks the SAME id; keep-set only protects components of `ready` models. Piper installed → Kokoro downloading (skips espeak, already ready) → delete Piper mid-flight → espeak rm'd → Kokoro completes `ok:true` but status `absent`. 345 MB for an unusable "installed" model, no error surfaced. | Extend the delete keep-set to shared components of any in-flight install. |
| TTS-3 | major | `voiceTtsModels.ts:127-140,205-207,257-258` | Size-only readiness + skip-`ready` resume + no fsync ⇒ a size-preserving corruption of a landed component is PERMANENT: every session fails `tts:engine:error`, and the user's natural fix (Download) is a no-op returning `ok:true`. Regression vs STT, where re-download unconditionally re-fetches and repairs. | Explicit user-initiated download force-refetches (or re-verifies) landed components. |
| ESC-1 | major | `renderer/jarvis/JarvisPanel.tsx:190-201` | Window CAPTURE-phase Esc grab while panel open: eats Esc bound for vim/TUI in terminal boards, double-fires with the full-view capture Esc (one press exits full view AND kills the mic), suppresses every bubble-phase Esc consumer. Spec says "Esc closes from anywhere IN the panel"; this is app-wide. | Scope to panel-contained targets (or integrate with the existing keybinding layering); keep the one-Esc-one-layer discipline. |
| HIST-1 | major | `renderer/store/jarvisStore.ts:95-96` | `hydrateTurns`/`clearTurns` are DEAD CODE while MAIN keys history per-project → project switch shows project A's transcript over project B's brain history; renderer reload shows "No turns yet" while MAIN feeds 24 prior turns to the model. | Wire clear+hydrate on project switch / panel mount (needs a `jarvis:history:get` read or clear-on-switch policy — pick and document). |
| TTS-4 | major | `renderer/voice/ttsPlayback.ts:193` (+122-124,157) | Barge-in flush watermark = max SEEN utterance id; a barge-in during synthesis warmup (speak accepted, zero chunks seen — the documented ~456 ms first-audio window) sets the watermark below the in-flight utterance → the ENTIRE cancelled clause plays at full volume after the duck restore. Distinct from the fixed queued-clause epoch (renderer speak chain); this is the port data plane. | Flush through max ACCEPTED id (renderer has it from `speak()` returns) or host-side epoch tag on post-cancel stragglers. |

## P2 — take in-lane if cheap, else file

- **BRAIN-3** (minor) `jarvisBrain.ts:204-210`: catch-all forwards raw transport `err.message` to the renderer, violating the module's own opaque-error (BUG-003) contract; the 60 s stall surfaces as a generic abort string. Type the stall reason; strip messages.
- **BRAIN-4** (minor) `jarvisIpc.test.ts:2-5`: header claims "supersede-on-new-turn, cancel" coverage that does not exist. Write the tests (they'd have caught BRAIN-1/2).
- **BRAIN-5** (minor, defense-in-depth) `jarvisManifest.ts:14-16,66,76`: board titles/group names embed into the SYSTEM prompt with newlines un-neutralized (`sanitizeSnapshot` only length-caps). Inert today (no tools); **becomes the injection seam the moment J4 ships tools → fold into the J4 injection audit as a MUST.**
- **TTS-5** (minor) `voiceIpc.ts:359-363`: `sid` never clamped against the live engine's `numSpeakers` (exposed, never consulted); config switch mid-session can send an out-of-range speaker index into the native addon.
- **TTS-6** (minor) `voiceEngineHost.ts:602-604`: TTS-worker addon load failure reported as `ok:true, live:false` — misdiagnosed as "model not loaded". STT has a designed count-only degrade; TTS doesn't.
- **TTS-7** (minor) `voiceEngineHost.ts:520-530,592,608-609`: recognizer/OfflineTts worker caches never evict — up to ~550 MB pinned after model A/B, including models deleted from disk.
- **TURN-1** (minor) `jarvisSession.ts:148` (+44-51): superseded-turn deltas leak through the id guard during the `startTurn` round-trip (stale `currentTurnId`) → fragments of the abandoned reply speak under the new epoch. Null the id synchronously in `sendTurn`.
- **DUCK-1** (minor) `ttsPlayback.ts:206-219`: overlapping `duckAndFlush` restore timers interleave — first restore snaps gain to 1 mid-second-duck. Cancel/supersede the timer.
- **MIC-3** (minor) `JarvisPanel.tsx:303-311`: mic strip keys off `converseMode` only — claims "mic live" over an OS-denied mic (denial CTA suppressed by `composerSuppressed`). Key off actual capture / surface denial in-panel.
- **BADGE-1** (minor) `JarvisPanel.tsx:211,254-258,366-387`: badge/chips render stale `attentionStore` entries for deleted boards (first surface ever to render them); chip focuses a dead id (self-clears on click).
- **PANE-1** (minor) `PersonaPane.tsx:116-119`: pane never subscribes `jarvis:config:changed` → MAIN's repaired values (name fallback, rate clamps) diverge from the pane until remount while the panel header shows the repaired value.
- **E2E-1** (minor) `e2e/jarvis.e2e.ts`: zero direct tests on the structural refuse (`arm while closed`), the hotkey toggle, Settings-disable-while-open, mic-strip disarm/re-arm, badge/chips. The invariant this surface exists to enforce has one guard line and no test.
- **NIT-1/2** (carried from #341 review, no-reply nits): `jarvisConfig.ts` enabled/name doc comments still say "island"; D8 chip board-titles read via `getState`.

## Clean / verified holds

- SEC-2 `e.source === window` pins on both voice-port adopters — compliant, no other port-taking listeners in the slice.
- Queued-clause barge-in epoch + mid-stream stall watchdog re-arm (the #339 round-1 fixes) — verified intact.
- No AudioContext/source/IPC-listener leaks found; speak chain `.catch`-protected; utterance-id continuity safe across host restart; in-flight speak-vs-cancel FIFO-safe.
- Island/tail retirement complete (only the sanctioned `islandPosition` repair-funnel reads remain); neural-core rAF/interval loops cancelled; edge tab truly static; CSS slots into the panel family without z-index collisions.
- IPC sender validation (`isForeignSender`) on every voice/TTS/jarvis channel; key material never crosses IPC outbound or reaches logs.
- Manifest path traversal not attacker-reachable (build-time pinned HF manifest); one-line `..` guard noted as cheap hardening only.
