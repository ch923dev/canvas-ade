# FIND-010 — OSR did-navigate-in-page never clears the failed latch — SPA stuck on load-failed after client-side route (sole engine; recovery helper has no production call site)

| | |
|---|---|
| **Severity** | Low |
| **Category** | correctness |
| **Status** | CONFIRMED (independently re-verified) |
| **Primary location** | `src/main/previewOsr.ts:642-651` |
| **Discovery slice** | M-PREVIEW (run 1) |

## Summary
previewShared.ts exports clearLatchOnInPageRecovery() and the renderer (useOffscreenPreview.ts:138-147) handles ev.recovered===true to lift a stuck 'load-failed'/'crashed' board back to 'connected'. This entire recovery path exists for BUG-004: after a server returns a 4xx document (did-navigate sets e.failed=true at previewOsr.ts:625) and the SPA then client-side routes to a working in-app view, the board is permanently stranded on 'load-failed'. But the OSR did-navigate-in-page handler (the SOLE preview engine since 5C) emits a plain did-navigate WITHOUT calling clearLatchOnInPageRecovery and WITHOUT setting recovered, so e.failed is never cleared. The dead-server recovery the helper+renderer were built for can never fire via the OSR engine. NOTE: this exact gap was explicitly observed and deferred in docs/reviews/2026-06-15-bug-hunt/FIX-REPORT.md:108 ('previewOsr.ts has the same in-page-latch shape as BUG-004 ... can adopt the recovered emit later') — flagging for dedupe, it is not net-new.

## Trigger
A Browser-board dev server returns HTTP >=400 for a route (latching e.failed), then the same SPA performs a client-side route (history.pushState / hash route) to a working in-app view that fires did-navigate-in-page. The board stays stuck on the 'Couldn't load' fallback even though live content is present; only a hard reload/full navigation recovers it.

## Evidence / concrete faulty path (code-grounded)
Faulty path, all lines personally read: (1) previewOsr.ts:624-625 — `wc.on('did-navigate', (_ev, navUrl, httpResponseCode) => { if (isErrorResponseCode(httpResponseCode)) e.failed = true ...})` latches on a 4xx/5xx-bodied document; renderer useOffscreenPreview.ts:155-159 sets status 'load-failed' + clearCanvas(). (2) SPA client-side routes → previewOsr.ts:642-651 `wc.on('did-navigate-in-page', (_ev, navUrl, isMainFrame) => { if (!isMainFrame) return; emitEvent({ id, type: 'did-navigate', url: navUrl, canGoBack, canGoForward }) })` — no `e.failed` reset, no `recovered`. (3) Renderer canvas/boards/useOffscreenPreview.ts:139 `const recovered = (ev as { recovered?: boolean }).recovered === true` is false → falls to the else at line 148 which patches only liveUrl/canGoBack/canGoForward and leaves status:'load-failed'. Board stays on the "Couldn't load" fallback (canvas already cleared) despite live in-app content. Recovery helper previewShared.ts:249 `clearLatchOnInPageRecovery` exists + is unit-tested (previewShared.test.ts:271-289) but has NO production caller (verified via grep excluding *.test.ts). Known-tracked: docs/reviews/2026-06-15-bug-hunt/FIX-REPORT.md:108 + findings/BUG-004.md defer exactly this OSR case.

## Verifier reasoning (why CONFIRMED; scope & severity)
I personally verified the full faulty path and it is concrete and reachable in the shipped app (OSR is the sole preview engine since 5C; the native src/main/preview.ts that originally carried the BUG-004 fix no longer exists — confirmed `ls` returns "No such file or directory"). The recovery machinery exists but has ZERO production call sites: `grep clearLatchOnInPageRecovery` over src/ excluding *.test.ts returns only the export definition (previewShared.ts:249) — it is never invoked anywhere in shipping code. The OSR `did-navigate-in-page` handler (previewOsr.ts:642-651) emits a plain `did-navigate` with no `recovered` flag and never resets `e.failed`, while the renderer (canvas/boards/useOffscreenPreview.ts:139-147 — the candidate's path was slightly off, real file is under canvas/boards/) only lifts a stuck load-failed/crashed board when `recovered === true`, which the OSR emit can never satisfy. This is a genuine functional correctness defect (a recoverable state that is never recovered for the only engine), so it is inScope as a defect, not a perf/a11y/styling item. It is, however, NOT net-new: it is explicitly documented as a deferred follow-up in docs/reviews/2026-06-15-bug-hunt/FIX-REPORT.md:108 ("previewOsr.ts has the same in-page-latch shape as BUG-004 ... forward-compatible today; can adopt the recovered emit later") and the BUG-004 finding/INDEX, so it is a known/tracked deferred gap. Severity is Low: narrow trigger sequence, only the in-app fallback is shown, full recovery on any hard reload/full navigation; no data loss, crash, or security weakening.

## Fix direction (audit only — NOT applied)
Give the in-page did-navigate recovery helper a production call site (or clear the load-failed latch on did-navigate-in-page), so a client-side SPA route change clears a stale failed latch instead of leaving the board stuck on load-failed.

## Files this card touches
- `src/main/previewOsr.ts (642-651)`

## Collision flags (sequence with)
- None — independently fixable in parallel.
