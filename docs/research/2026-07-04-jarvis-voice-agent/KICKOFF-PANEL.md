# KICKOFF — Jarvis Panel (surface revision, post-J3)

**Lane:** `feat/jarvis-panel` → PR into `feat/jarvis-umbrella` (NOT main).
**Depends on:** PR #339 (J3 brain + persona) landed in the umbrella — this lane swaps J3's
*surface*, and carries its guts unchanged.
**Decided:** 2026-07-13 with the user (design discussion + /btw fork). Sign-off artifact:
`mock-jarvis-panel.html` (rev 1, this directory) — approved as the gate for this lane.

## 1. Why this lane exists

Two independent forcing functions killed the floating-island surface J3 shipped with:

1. **Cost separation (the decisive one).** Dictation (VoicePill) is free and local; Jarvis is a
   paid, opt-in API feature. Merging them into one pill — or even parking two look-alike pills
   side by side — puts a paid affordance in every user's chrome and makes the two features read
   as one. Users who never enable Jarvis must never see it floating over their canvas.
2. **The twin-pill problem.** JarvisIsland and VoicePill are visually siblings (same chrome
   family, same corner) — the user flagged them as confusable on sight.

Resolution: **Jarvis becomes a right-side panel** (the Context/Library pattern), with a
collapsed **edge tab** when closed. The floating island and the transcript tail **retire
entirely**. This also upgrades the privacy story from a policy to a structural invariant (§3).

## 2. What retires / what carries

| Retires (this lane deletes) | Carries unchanged from J3 |
|---|---|
| `JarvisIsland.tsx` (floating pill + drag/dock) | `jarvisBrain.ts` (SSE stream, stall watchdog) |
| `JarvisTail.tsx` (floating tail + Exhibit-F view) | `jarvisIpc.ts` + turn lifecycle channels |
| `jarvis-island.css` | `jarvisPersona.ts`, `jarvisConfig.ts`, `jarvisManifest.ts` |
| `islandPosition` config field (repair funnel keeps reading+dropping it) | `clauseChunker.ts` + serialized speak chain + `speakEpoch` |
|  | barge-in registry (`onBargeIn`/`notifyBargeIn`) |
|  | `finalConsumer.ts` seam + `composerSuppressed` |
|  | `jarvisStore.ts` (rename `viewOpen`/`tailOpen` → `panelOpen`) |
|  | `PersonaPane.tsx` (Settings) |
|  | all 52 units + both e2e specs (asserts are store-level; selectors re-point) |

The Exhibit-F conversation view (day separators, timestamps, error row with Settings CTA)
**moves into the panel body** — it was built for this; only its container changes.

## 3. The mic-gate invariant (structural, not policy)

> **Open panel = the mic may listen. Closed panel = no capture path exists.**

- Converse mode can only be armed while the panel is open (the arm control lives inside it).
- Closing the panel — ✕, Esc, edge-tab click, project close — runs the **existing**
  `setConverseMode(false)` teardown: unregister final consumer, `composerSuppressed=false`,
  cancel the in-flight turn, bump `speakEpoch` (queued clauses die), stop capture.
- There is deliberately **no** "keep listening in the background" setting. If you can't see the
  conversation, it can't hear you.
- Speaking is NOT gated: D8 announcements may still speak with the panel closed (output needs
  no mic). Only *capture* is panel-bound.

### Wake-word carve-out (J5, unchanged in spirit)
The local `KeywordSpotter` (no cloud, no STT) may run with the panel closed, **opt-in only**,
and its sole power is to OPEN the panel. Turns still require the open panel. This is the one
sanctioned exception, and it is capture-of-one-keyword, not transcription.

## 4. The surface (mock exhibits A–E)

- **Panel** (Context/Library family): full-height right dock, canvas keeps working beside it.
  - **Header (44px core):** the neural-core renderer at 44px — same five-state machine and
    tuning table as the island core, one renderer parameterized by size. Name + persona/voice
    meta line + live state label + ✕. No gifs, no mascots — token hexes only (design contract).
  - **Mic strip** directly under the header: visible exactly while the mic can hear
    (`mic live — only while this panel is open` + the shortcut). This IS the contract, on screen.
  - **Body:** the conversation (Exhibit-F view relocated): `You ·` rows, streaming reply with
    caret, `turn-act` chips for J4 tool calls, day separators, history-summary chip.
  - **Foot:** `speak to interrupt · esc closes / mic off` + (J4) `grounded in tool results`.
  - **Agent events (D8 relocation):** notification chips dock at the panel foot; chip click →
    `focus_viewport`. The old floating chip stack retires with the island.
- **Edge tab** (collapsed): lib-reopen family, right edge — 18px mini core (STATIC, no rAF while
  closed) + vertical `JARVIS` label + unread badge (D8 count). Click / shortcut opens the panel
  AND arms the mic in one gesture.
- **Keyboard:** one shortcut toggles panel+mic (mock shows ⌃⇧J — final binding checked against
  the shortcut registry at implementation). Esc closes from anywhere in the panel.

## 5. J4/J5 rescope (hands build into the panel)

- **J4 (hands):** confirm-gate chip renders **inside the panel body** as part of the turn
  transcript (a `turn-act` row with confirm/deny), not as a floating chip. Spoken grounded
  confirmations unchanged. The injection audit gate from PLAN §5 stands.
- **J5 (polish):** wake word opens the panel (§3 carve-out); `.canvas/memory` integration and
  matrix parity unchanged.

## 6. Sequencing & gates

1. **#339 lands in the umbrella first** (as-built, island included) — this lane then deletes the
   island in one reviewable diff instead of #339 growing a second surface rewrite.
2. This lane: panel + edge tab + mic-gate + D8 relocation + store/e2e re-pointing.
   Version bump: **0.17.0** (surface subsystem swap). PR → umbrella.
3. Epic-end umbrella → main PR pays the full e2e matrix (both legs), per lane precedent.

Gates for this lane: unit suite green (store/session tests unchanged in intent), both jarvis
e2e specs re-pointed at panel selectors and green on the Windows leg, manual title-stamped
dev-check (`CANVAS_DEV_TITLE='PR#NNN jarvis-panel'`), reviewer dispositions inline.

## 7. Supersedes

- PLAN.md §4's "Jarvis island" + "Transcript tail" bullets — superseded by this surface. (PLAN
  body left untouched on this branch to avoid an epic-end merge collision with main's §9/§10.)
- KICKOFF-J3 §Exhibit F placement (floating view) — the view itself carries; its home is now
  the panel body.
- The `islandPosition` persona-config field — dropped from the view; the repair funnel keeps
  accepting old config files silently.
