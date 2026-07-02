# SPEC — Voice dictation (composer with review)

> Status: **FINAL — approved 2026-07-02** (pill mock v2 signed off as-is). Research-verified
> (REPORT.md); UX contract aligned with the surveyed convention — notably Claude Code's own
> `/voice` (dimmed-until-final partials, insert-then-wait-for-Enter, silence
> stops-not-submits).
> Companion: `REPORT.md` (engine evidence), `mock-voice-composer.html/.png` (visual contract),
> `IMPLEMENTATION-PLAN.md` (slices).

## 1. Goal

Speak a prompt; see it land as editable text in a composer attached to the focused Terminal
board; review/edit; press Send — the text is pasted into the agent CLI and submitted. Local
STT: works offline, no API key, audio never leaves the machine.

## 2. Product invariants (non-negotiable)

- **Review-first.** No transcribed text reaches a live PTY without an explicit user gesture
  (Send/Insert on the composer, or Enter inside it). `autoSendOnFinal` exists in config but is
  hard-`false` in v1 — no code path may honor `true` yet.
- **Send is the only `\r` emitter.** Insert pastes text only (bracketed paste — cannot
  auto-submit). Send = paste → ~150 ms settle → `\r` as its own discrete port write (the
  Claude Code TUI submit discipline, see `mcpOrchestrator.ts:373-390`).
- **Security posture unchanged or tightened.** Renderer CSP (`src/main/csp.ts`) untouched.
  A new mic-only `setPermissionRequestHandler` **plus `setPermissionCheckHandler`** lands on
  the default session (allow app-origin audio-media, deny everything else) — closing today's
  auto-grant default AND the pre-grant device-label leak (Electron exposes `enumerateDevices`
  labels without a grant unless the check handler gates them). Browser-board
  content still never reaches the PTY write channel (voice writes only via the composer,
  which is trusted user input).
- **Zero board-schema impact.** All voice state is ephemeral (Zustand `voiceStore`) or
  app-level config (`userData/voice-config.json`). Nothing enters `boardSchema` /
  `PATCHABLE_KEYS`.

## 3. UX contract

### Surfaces (reworked 2026-07-02 after mock-v1 feedback: floating pill, boards untouched)

- **VoicePill** — a **screen-fixed, draggable pill widget** (the Wispr-Flow floating-widget
  pattern, per the user's reference): app logo + a live waveform-bars indicator, grip dots
  for drag. Rendered as an app-level overlay island (like toast/minimap), **NOT inside any
  board** — Terminal board DOM is completely unchanged. Draggable anywhere; position clamped
  to the viewport and **persisted app-level** (`voiceConfig.pillPosition`); `showPill`
  Settings toggle. Click = toggle listening; the pill alone shows `idle`/`listening` (bars
  flat/faint vs animated accent).
- **VoiceFlyout** — a compact panel anchored above the pill (flips below near the top edge),
  which opens **only when there is a transcript to review or a state needing attention**.
  Carries: target row ("→ *board title*"), the editable transcript (dimmed-italic partial
  tail), Insert + Send buttons, hint row. This is where review-first lives.
- **In-app hotkey** `Ctrl/Cmd+Shift+M` (configurable), **one key, two behaviors** (the
  superwhisper convention): **quick-press = toggle** listening on/off (prompt-length
  dictation, 10–60 s), **press-and-hold = push-to-talk** (release stops). App-focused only;
  OS-global push-to-talk is deferred (globalShortcut conflicts silently + Wayland portal is
  patchy).

### Targeting rules

- Target = `useCanvasStore.selectedId` where board type is `terminal`; the flyout header
  always names the target so there is no ambiguity about which agent receives the text.
- Listening requires nothing from the PTY; **Send/Insert require a live PTY**
  (`useTerminalRuntimeStore.running[id]`) — no running terminal selected → the `no-target`
  flyout state ("click a terminal board to target it — draft is kept"), buttons disabled.
- Selection change while a draft exists retargets the flyout (header updates); the draft
  itself is never lost on selection change, board delete, or PTY kill (kept in `voiceStore`
  until sent or explicitly closed).

### States (the mock renders each)

| State | Trigger | Visual |
|---|---|---|
| `idle` | mic off, no draft | pill only; bars flat/faint |
| `listening` | mic on | pill bars animate (accent) + accent border; flyout appears once first partial text arrives, partial as **dimmed italic tail** |
| `finalizing` | endpoint / mic stopped | tail solidifies into ordinary editable text |
| `reviewing` | final text present, mic off | flyout stays open for edit; Send primary, Insert secondary; pill returns to idle look |
| `no-target` | no running terminal selected | flyout notice row; draft kept; buttons disabled |
| `model-missing` | engine reports no model | flyout row: "Voice model not downloaded (~XX MB)" + **Download** CTA + progress |
| `mic-denied` | OS-level denial | pill gains a red status dot; flyout row "Microphone blocked by the OS" + "Open settings". Detection MUST NOT rely on a `getUserMedia` rejection — a missing OS grant yields a live **all-zeros stream, no error** (electron#42714); detect via the level watchdog + `systemPreferences.getMediaAccessStatus('microphone')` |
| `error` | engine crash / port loss | flyout row with Restart; draft preserved |

### Interactions

- Enter = Send (`isComposing` IME guard, mirrors `SubmitWell.tsx`); Shift+Enter = newline.
- Esc: first press stops listening; second closes the flyout (draft kept).
- Dragging the pill never toggles listening (drag-threshold before click fires).
- Mic button toggles listening. **Silence auto-STOPS recording (~15 s), never submits**
  (the VS Code auto-submit default is that product's most-complained-about voice behavior;
  Claude Code separates the concerns exactly this way). Hard cap ~2 min per toggle session.
- Partial tail anchors at the end of the text; on `final`, only the dimmed tail is replaced —
  already-finalized text never reflows (avoids the replace-on-final "blink").
- Mixing typing + speech in one prompt is supported: the textarea stays editable throughout;
  dictation appends.
- Textarea auto-grows to ~6 rows then scrolls (the `SubmitWell` `MAX_INPUT_PX` pattern).
- Multi-line is first-class: dictated paragraphs Insert as bracketed paste (LF newlines
  in-text; never per-line submits).

## 4. Architecture (summary — full detail in IMPLEMENTATION-PLAN.md)

```
Renderer: getUserMedia → AudioWorklet (bundled module worker; 48k→16k mono Int16, ~120ms
frames, RMS level + cheap energy endpointer v1) → voice:port (transferable ArrayBuffers)
MAIN: voiceIpc.ts brokers ports + models + config; never touches audio payloads
Engine host: utilityProcess running the local STT engine (recommended: sherpa-onnx-node
streaming zipformer; silero VAD engine-side in v1.5) → {partial|final|status|error} back
over the same port
Injection: terminalInputRegistry (boardId → {paste, submit}) populated in useTerminalSpawn
beside e2eTerminals; paste = term.paste(); submit = discrete '\r' after settle
```

- `voice:port` clones the `pty:port` MessagePort pattern (`src/preload/index.ts:995-1008`).
- Control IPC: `voice:session:start|stop`, `voice:models:list|download|delete|status`,
  `voice:config:get|set` — `namespace:verb`, `ipcRenderer.invoke`.
- Models never bundled: MAIN downloads pinned manifest (URL + sha256 + size) to
  `userData/voice-models/<modelId>/` (`.part` → hash-verify → atomic rename).

## 5. Settings (SettingsModal › Voice)

`src/main/voiceConfig.ts` mirrors `llmConfig.ts` (userData JSON, atomic write, read-repair):

```ts
interface VoiceConfig {
  engine: 'sherpa-onnx' | 'cloud'   // 'cloud' greyed "coming soon" in v1
  modelId: string                   // key into the pinned model catalog
  language: string                  // 'auto' | ISO 639-1
  micDeviceId?: string
  hotkey?: string                   // in-app accelerator, default Ctrl/Cmd+Shift+M
  autoSendOnFinal: false            // reserved; MUST stay false in v1
  cloudProvider?: string            // placeholder, unused in v1
  showPill: boolean                 // default true; the widget can be hidden entirely
  pillPosition?: { x: number; y: number }  // screen-fixed px, viewport-clamped on restore
}
```

UI: engine select, model picker (size + downloaded/download/delete state), language, mic
device (`enumerateDevices`), hotkey. Future cloud key → `voiceKeyStore.ts` on the
`llmKeyStore.ts` safeStorage pattern (file reserved, not built).

## 6. Packaging / permissions

- Engine dep = runtime `dependencies` + `asarUnpack` (node-pty recipe). Hard requirement:
  **prebuilt NAPI binaries only** (spaced repo path forbids install-time node-gyp/cmake).
- macOS: `NSMicrophoneUsageDescription` (mac.extendInfo) +
  `com.apple.security.device.audio-input` in both entitlements plists (`electron-builder.yml`).
- Mic-only permission handler on the default session (V0 slice — ships first as a pure
  security win).

## 7. Non-goals (v1) / deferred

- OS-global push-to-talk (`globalShortcut`) — silent conflict failures + Wayland portal
  patchiness; in-app hotkey first.
- Cloud engine tier (config placeholder only).
- Dictation into Planning cards (NoteCard/FreeText/Checklist).
- Whisper-class offline "accuracy mode" — later = a model swap on the same
  `OfflineRecognizer` API, no new dependency.
- **v1.5 — recognition hints (hotwords)**: board title / project name / git branch via
  sherpa `modified_beam_search` hotwords (the Claude Code context-hints pattern; transducer
  models support it, Nemotron doesn't).
- **Future opt-in auto-submit**: if ever added, copy Claude Code's guard verbatim —
  opt-in flag + only fires on transcripts ≥3 words.
- LLM transcript cleanup ("tidy" pass — filler removal + punctuation only, never
  rephrasing): safe for us *because* the composer reviews before send, but v2.

## 8. Open decisions

All resolved (REPORT.md §8): pill mock approved as-is · Kroko default model (both cataloged,
license note in Settings) · win-arm64 feature-gated off in v1.
