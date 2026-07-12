# J3 — Brain + Persona: in-depth review & lane brief (2026-07-13)

> Lane doc for `feat/jarvis-j3-brain` (worktree `.worktrees/jarvis-j3-brain`, base
> `feat/jarvis-umbrella` @ `fadaeaf6`, PR target = umbrella, version bump → **0.16.0**).
> Deleted at epic doc-collapse per doc lifecycle. Companion to PLAN.md + REVIEW-2026-07-10.md.
> Exhibit F (conversation view) **user-approved 2026-07-13** — in scope.

## 1. Review of what J1/J2 left for J3 (verified on this tree)

### 1.1 The speak seam is ready and explicitly addressed to J3

- `ttsSession.ts:2-3` — "the J3 brain's sentence chunker funnels here next."
  `speakText(text): Promise<boolean>` lazily opens the TTS session and enqueues one utterance;
  `voice:tts:speak` caps text at **2000 chars** (`voiceIpc.ts`), host FIFO-queues
  (`voiceEngineHost.ts:244` — "J3's brain streams one clause each"). Sentence-level streaming
  inside one utterance is the engine's job (`maxNumSentences:1` + `onProgress`); **clause-level
  pacing is the caller's job** — J3 ships a clause chunker and calls `speakText` per clause.
- `cancelSpeech()` = duck ≤100 ms + flush + host cancel. Barge-in (transcription-gated + RMS)
  is wired in `useTtsPlayback.ts` and fires `trigger()` → `cancelSpeech()` only.

### 1.2 Gaps J3 must close (confirmed absences)

| Gap | Consequence | J3 answer |
|---|---|---|
| No barge-in notification hook | brain can't cancel the LLM stream when the user interrupts | tiny listener registry in `ttsSession.ts` (`notifyBargeIn()` called from `trigger()`); Jarvis controller cancels the turn over IPC |
| No renderer→MAIN "cancel stream" channel | in-flight Claude stream keeps burning tokens after barge-in | `jarvis:turn:cancel` → `AbortController.abort()` in MAIN |
| No per-utterance done event; cancelled vs completed indistinguishable (`speaking` flips false both ways) | island can't tell "finished speaking" from "cut off" | J3 island derives state from **turn lifecycle** (stream events + `speaking` store), not per-utterance audio; cancelled turns are marked by the barge-in path itself |
| No converse mode; finals fold into flyout `draft` only (`voiceStore.finalReceived`) | transcripts can't reach a brain | pluggable **final-consumer seam** in `voiceStore` (terminalInputRegistry precedent); Jarvis registers it while converse mode is on |

### 1.3 The big reuse finding: the "brain" substrate already exists

`REVIEW-2026-07-10.md §1.3` said "Brain — ABSENT. No @anthropic-ai/sdk". Half right. There is
no conversational session, but MAIN already ships a **provider LLM subsystem** (T-B1/2/3, built
for board-memory summarize):

- `llmKeyStore.ts` — **safeStorage-encrypted API keys** (`userData/llm-keys.json`), provider-keyed
  (incl. `anthropic`), absent-vs-inaccessible discipline (BUG-005), key never crosses IPC outbound.
  **D1 is already implemented.**
- `llmService.ts` — hand-rolled `api.anthropic.com/v1/messages` request builder + injected
  `FetchLike` transport + `CANVAS_LLM_MOCK` seam + typed never-throws results.
- `llmIpc.ts` — frame-guarded `llm:setKey/clearKey/status/setConfig`, bounded inputs.
- `LlmPane.tsx` — Settings pane with provider/model/key UI (explicit-Save, write-only key).

**Decision (J3): no `@anthropic-ai/sdk`.** The brain extends the existing pattern with a
streaming path. Rationale: zero new runtime deps (kills the worktree dep-prune hazard +
lockfile churn), same testability discipline (SSE parser is pure, transport injected), same
mock seam, same key store. PLAN.md §3.4's SDK recommendation predates knowledge of this
subsystem; repo consistency wins. The persona "Brain" key row reads/writes the **same
`anthropic` key slot** through the existing `llm:setKey`/`llm:status` IPC — one key store, no
parallel credential path.

### 1.4 Workspace manifest: in-process, token-free

`RunningMcp.describeApp(): Promise<AppModel>` (mcp.ts:239) is pure/read-only and already used
by the e2e seam. `AppModelBoard` carries `{id, type, title, status, agentKind?, x/y/w/h?}` +
`canvas.groups {id,name,boardIds}` — exactly the semantic-targeting manifest REVIEW §3.4 wants.
No orchestrator token, no HTTP, no `canvas://` wire read needed for J3. (D5 token minting is a
J4 concern — tools, not reads.)

### 1.5 UI substrate

- Island mount = App.tsx fixed-root sibling (VoicePill/ToastIsland precedent), own
  `styles/islands/*.css`, z=120 tier (below full-view scrim 200).
- All mock tokens verified byte-identical against `styles/tokens.css`. Neural-core canvas uses
  literal hex copies of 4 tokens (exportColors.ts precedent — canvas can't read CSS vars).
- Reduced motion: paint one frame, don't re-schedule rAF (`matchMedia` once) + enumerated CSS
  animation nulls — both are established conventions.
- Settings = pane registry (`settingsSections.ts` + `SettingsSectionBody.tsx`); Persona pane
  joins the **Voice** group. Immediate-apply for persona fields; key row keeps LlmPane's
  explicit-commit posture.

## 2. J3 architecture (locked for this lane)

```
finals (voiceStore) ──final-consumer seam──▶ jarvisSession (renderer controller)
   ──jarvis:turn:start {text, projectKey}──▶ MAIN jarvisIpc → jarvisTurn (history+persona+manifest)
   → streaming fetch v1/messages (SSE, AbortController, prompt-cached persona block)
   ──jarvis:turn:event {delta|done|error}──▶ renderer: clauseChunker → speakText() per clause
                                             jarvisStore: state machine + tail/view transcript
barge-in (useTtsPlayback.trigger) → notifyBargeIn() → jarvisSession → jarvis:turn:cancel → abort()
```

MAIN files: `jarvisConfig.ts` (persona config, read-repair, `userData/jarvis-config.json`) ·
`jarvisPersona.ts` (tone presets + system-prompt composition, pure) · `jarvisBrain.ts`
(request build + SSE parse + stream loop, injected transport, `CANVAS_LLM_MOCK` honored) ·
`jarvisManifest.ts` (AppModel → compact manifest text, pure) · `jarvisIpc.ts` (frame-guarded
channels, per-project in-MAIN history, one live turn at a time) · `jarvisBoot.ts` (wiring;
index.ts gets hook calls only).

Renderer files: `jarvis/clauseChunker.ts` (pure) · `store/jarvisStore.ts` (ephemeral) ·
`jarvis/jarvisSession.ts` (controller + consumer registration + barge-in cancel) ·
`jarvis/JarvisIsland.tsx` + `jarvis/neuralCore.ts` + `styles/islands/jarvis-island.css`
(pill/states/tail/history view per mock) · `canvas/settings/panes/PersonaPane.tsx`.

Cross-zone touches (all declared on the board): `App.tsx` (mount), `voiceStore.ts` (consumer
seam), `ttsSession.ts` (+`notifyBargeIn` registry), `useTtsPlayback.ts` (call it),
`settingsSections.ts`/`SettingsSectionBody.tsx` (pane row), `preload` (jarvis api),
`main/index.ts` (boot hooks).

Persona config shape (PLAN §3.5 + mock): `{name, tonePreset: 'butler'|'mission-control'|
'pair-programmer'|'custom', customToneText, voiceId, speakingRate, verbosity, model, converseHotkey?,
historyMode: 'session'|'off'}` — `historyMode: 'project'` (persisted) is J5; v1 default `session`.

Deliberate v1 scope cuts (flagged, not forgotten): no extended thinking (TTFT latency; voice
budget ≤2 s), no per-day budget on Jarvis turns (user-initiated; recap's 200/day cap must not
starve conversation — revisit at J5), notification chips + confirm chip + `acting` state = J4
(D8), persistent history + rolling summary = J5 (D4′).

## 3. Gate (from PLAN §5 + repo MUSTs)

- Units: prompt composition (`jarvisPersona`), config read-repair (`jarvisConfig`), SSE parse +
  abort (`jarvisBrain`), clause chunker, manifest compaction, store transitions.
- e2e (@voice tag): stub voice final → converse turn → mock brain stream → tail text + state
  transitions + history view open (LLM mock seam, stub TTS).
- Cheap trio + full units + FULL e2e matrix (MAIN+preload touched ⇒ LINUX_SENSITIVE).
- Manual dev check `CANVAS_DEV_TITLE='PR#NNN jarvis-j3'`: real key round-trip if key present;
  else mock-brain round-trip + real TTS voice out.
- PR → `feat/jarvis-umbrella`; claude-review inline dispositions; version 0.16.0.
