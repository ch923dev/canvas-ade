# Jarvis Voice Agent — Structured Plan

> **Status:** PLAN (pre-build). Research package convention: lives uncommitted on `main`;
> moves to a `feat/jarvis-voice-agent` worktree when the build starts.
> **Hard prerequisite:** the voice-to-text epic (`feat/voice-to-text`, V0–V5) is merged to `main`.
> This plan builds directly on that stack — nothing here starts before that epic lands.

## 1. Vision

A conversational AI agent inside Expanse you can *talk to* — press-to-talk (later: wake word),
speak naturally, and it answers **out loud** in a configurable persona ("Jarvis"): a name, a tone,
a voice. Beyond chat, it has *hands*: it can act on the canvas (spawn boards, relay prompts to
terminal agents, manage planning cards) through the existing `canvas-ade` MCP tool surface.

Three pillars:

| Pillar | What it is | Foundation that already exists |
|---|---|---|
| **Ear** | Mic → streaming STT → endpointed transcript | Voice epic V0–V5: capture worklet, `voice:port`, sherpa-onnx host in `utilityProcess`, silero VAD, model catalog/download |
| **Voice** | LLM reply → TTS → speakers, with persona tone | `sherpa-onnx-node` (already a dep) exports `OfflineTts` — verified on this tree. Same host/packaging pattern as STT |
| **Brain** | Streaming Claude conversation with persona system prompt + tool use | Claude API (MAIN-side); `canvas-ade` MCP tools already shipped (spawn_board, relay_prompt, cards, visualize) |

## 2. What we are NOT building (v1 scope fence)

- No always-on ambient listening. Explicit converse mode (pill toggle / hotkey); wake word is a
  **later phase**, behind the same consent posture as dictation.
- No cloud STT/TTS. Local-first stays locked (same rationale as the dictation epic).
- No new board type. Jarvis is an **overlay island** (extends the VoicePill/flyout family),
  not a board — zero board-schema impact target, same as V1–V5 achieved.
- No autonomous destructive actions. Canvas-mutating tools are confirm-gated
  (close_board human-gate precedent, PR #281).

## 3. Architecture

### 3.1 Pipeline (one conversational turn)

```
mic ──capture worklet──▶ voice host (STT + VAD endpoint ~0.8–1.0s)
      final transcript ──▶ MAIN: agent session (Claude API, streaming)
      token stream ──sentence chunker──▶ TTS host (sherpa OfflineTts, per-sentence)
      PCM chunks ──voice:tts port──▶ renderer WebAudio playback queue
      (barge-in: VAD detects user speech during playback ▶ stop playback + cancel stream)
```

Latency budget target: **≤ ~2s** from end-of-speech to first audio out
(endpoint 0.8s + LLM TTFT ~0.5–1s streamed + first-sentence TTS ~0.2–0.4s).

### 3.2 Ear (exists — reuse verbatim)

- Capture, permission posture, `voice:port`, engine host, VAD, model download — all from V0–V5.
- New: a "converse" session mode alongside "dictate". Same port, a mode flag; final transcript
  routes to the agent session instead of the flyout draft.

### 3.3 Voice (new — TTS)

- **Engine:** `sherpa-onnx-node` `OfflineTts` in the SAME utilityProcess host (or a sibling
  worker inside it — decided by the J1 spike, mirroring the V2 spike gate). No new native dep.
- **Model:** cataloged via the existing pinned per-file HuggingFace manifest pattern
  (immutable revision URLs, hash-while-stream, atomic rename). Candidates, spike decides:
  - `kokoro-en-v0_19` int8 (~90 MB) — best quality, multiple voices (persona-voice mapping).
  - `vits-piper-en_US-*` (~60–80 MB) — smaller/faster fallback.
- **Playback:** MAIN synthesizes per sentence → PCM over a `voice:tts` MessagePort (COPY,
  never transfer — [[electron-port-transfer-null-payload]]) → renderer `AudioContext` queue.
- **Barge-in:** mic stays open during playback with `echoCancellation: true` (AEC is the echo
  defense; J2 must verify AEC actually suppresses TTS self-capture on Windows). VAD speech-start
  during playback → fade-out 100ms, flush queue, cancel in-flight LLM stream + TTS.

### 3.4 Brain (new — agent session in MAIN)

- **SDK:** `@anthropic-ai/sdk` in MAIN only (renderer never holds keys; CSP untouched).
- **Model:** default `claude-opus-4-8`, streaming, `thinking: {type: "adaptive"}`; Settings
  dropdown offers `claude-haiku-4-5` as a "fast conversation" mode (lower TTFT, cheaper).
  Effort `low`/`medium` for conversational snappiness.
- **Session:** rolling message history per project, prompt-cached persona system prompt
  (persona block frozen; volatile context appended after last cache breakpoint). History is
  ephemeral-ish: kept in MAIN memory, optionally persisted to `.canvas/memory/` (consent-gated,
  same posture as recap/context subsystem).
- **Auth (DECISION D1):** API key in `safeStorage`-encrypted app config (userData) vs. reusing
  the user's Claude Code CLI OAuth (Agent SDK / `ant auth` profile). Recommendation: **API key
  v1** (simple, official, streaming-native); CLI-auth path noted as follow-up research since
  every Expanse user already authenticates `claude` in terminal boards.

### 3.5 Persona / tone (the "must have a tone" requirement)

Persona = a first-class config object (app-level, userData — not in canvas.json):

```jsonc
{
  "name": "Jarvis",                  // used in prompt + UI label
  "tonePreset": "butler-dry-wit",    // one of the presets below, or "custom"
  "customToneText": "",              // free text when preset = custom
  "voiceId": "kokoro:af_sky",        // TTS voice — persona ⇄ voice pairing
  "speakingRate": 1.05,
  "verbosity": "concise"             // concise | normal | narrative
}
```

Tone presets (each = a hand-tuned system-prompt block + suggested voice):
- **Butler, dry wit** (the Jarvis default): impeccably polite, understated humor, never gushes.
- **Mission control**: terse, procedural, confirmations and callouts.
- **Pair programmer**: casual, direct, thinks out loud briefly.
- **Custom**: user-authored tone text.

The persona system prompt template composes: identity (name) + tone block + response contract
(SHORT spoken-style answers — TTS punishes walls of text; "lead with the answer; one breath per
sentence") + tool-use guidance + canvas context snapshot.

### 3.6 Hands (canvas tool use)

- Expose a curated subset of `canvas-ade` MCP tools to the agent session as Claude tool
  definitions (MAIN already hosts the MCP server integration): `spawn_board`, `relay_prompt`,
  `add_card`/`update_card`/`move_card`, `visualize_plan`, read-only canvas state.
- **Gating:** read-only tools auto-allow; mutating tools show a one-tap confirm chip on the
  Jarvis island ("Spawn a terminal running claude in the auth zone? ✓ / ✗"). Destructive
  (close/delete) NOT exposed in v1.
- Spoken confirmations: after a gated tool runs, Jarvis says what it did (grounded in the tool
  result, not the plan — prevents fabricated status).

## 4. UX (design artifact BEFORE code — repo rule)

- **Jarvis island:** the VoicePill grows a persona mode — distinct visual state (accent ring /
  avatar dot), live state machine: idle → listening → thinking → speaking → confirm-gate.
- **Transcript tail:** flyout-style overlay showing the last user utterance + streaming reply
  text (readable while it speaks), reusing flyout chrome.
- **Settings › Voice › Persona section:** name, tone preset picker (with 1-line preview),
  voice picker + "preview voice" button, model dropdown, key management.
- Deliverables before any implementation PR: static HTML mocks with real tokens
  (`mock-jarvis-island.html`, `mock-persona-settings.html`) + screenshots, user sign-off.
  Mind [[meridian-redesign-epic]] — desktop-first styling direction, sage reserved.

## 5. Phases (each ends runnable + committed, V-epic style)

| Phase | Deliverable | Gate |
|---|---|---|
| **J0 — Kickoff** | Decisions D1–D4 locked; design mocks signed off | User nod on mocks (blocking) |
| **J1 — TTS spike + engine** | `OfflineTts` in the voice host; model cataloged/downloadable; synth-to-WAV integration test | **Spike gate** (V2 pattern): works in dev AND `pack:dir` win-x64 through app.asar; perf: first-sentence latency measured |
| **J2 — Playback + duplex** | `voice:tts` port, renderer playback queue, sentence chunker, barge-in (VAD-during-playback), AEC verification | e2e: stub-TTS playback + barge-in drill; manual echo test on speakers (not headphones) |
| **J3 — Brain + persona** | Agent session in MAIN, streaming, persona config + tone presets, Settings UI, key storage, transcript tail UI | Live dev-check: full voice round-trip conversation, title-stamped build; unit: prompt composition, config read-repair |
| **J4 — Hands** | Curated tool defs, confirm-gate chip, spoken grounded confirmations | e2e: voice-driven `add_card` behind confirm gate; injection audit (Browser-board content must never reach tool args unvetted) |
| **J5 — Polish** | Wake word via `KeywordSpotter` (opt-in), `.canvas/memory` context integration, win-arm64 gate parity, docs + full matrix | Full e2e matrix both legs; epic PR with doc collapse |

Phases J1/J2 are parallelizable with J3 (disjoint files) if run as two lanes.

## 6. Decisions to lock at J0

| ID | Decision | Recommendation |
|---|---|---|
| D1 | Brain auth: API key vs CLI OAuth reuse | API key in safeStorage (v1) |
| D2 | Default persona voice/model pairing | Kokoro int8, butler preset, opus-4-8 |
| D3 | Wake word in v1? | Defer to J5, opt-in, off by default |
| D4 | Conversation history persistence | In-memory v1; `.canvas/memory` opt-in J5 |

## 7. Risks & gotchas (carried from the voice epic + new)

- **Echo/self-capture:** TTS out + mic open = feedback loop if AEC fails. Mitigation: AEC
  constraint + half-duplex fallback (pause STT frames while speaking) behind a config flag.
- **Cost:** opus-4-8 at $5/$25 per MTok; a chatty session ≈ cents/turn with prompt caching
  (persona block cached; verify `cache_read_input_tokens` > 0). Haiku mode for cost-sensitive.
- **Latency under load:** cold recognizer/TTS init blocks (V3 lesson: >10s under machine load) —
  init TTS at converse-mode enter, not first utterance; keep the V5 worker-thread pattern.
- **Packaged loading:** sherpa TTS through app.asar — proven pattern for STT (V2/V5 spikes),
  but TTS models load different files; the J1 spike re-proves it. macOS rpath still owed the
  same treatment as STT (paseo loader).
- **Security:** keys MAIN-only; tool args validated in MAIN; preview/Browser-board content is
  untrusted and must never be relayed into tool calls or the PTY channel; persona free-text is
  user-trusted but still length-capped.
- **Dep-prune hazard:** until merged, another lane's `pnpm install` on MAIN prunes worktree-only
  deps ([[voice-to-text-epic]] hazard) — same recurrence risk for any new SDK dep.

## 8. Effort shape (rough)

- J1 ≈ V2-sized (spike + engine + catalog): ~1 session.
- J2 ≈ half of V3: ~1 session.
- J3 = the biggest net-new (brain + persona + settings + design): ~1.5–2 sessions.
- J4–J5: ~1–1.5 sessions.
- Total ≈ 5–6 focused sessions after the dictation epic merges.
