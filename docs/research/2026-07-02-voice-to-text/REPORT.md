# REPORT — Voice-to-text (dictation) for Canvas ADE

> Synthesis of a 4-agent web-verification sweep + 3-agent codebase exploration (2026-07-02).
> Evidence key: ✅ verified against a fetched primary source (cited) · ◑ reported but not
> independently confirmed. This doc is **uncommitted research** — move onto the
> `feat/voice-to-text` branch when the build starts.
> Companions: `SPEC.md` (feature contract) · `mock-voice-composer.html/.png` (design artifact)
> · `IMPLEMENTATION-PLAN.md` (slices).

## 1. Executive summary

**Build it local-first on `sherpa-onnx-node` in an Electron `utilityProcess`, with a
review-first composer footer inside the Terminal board.** Every load-bearing claim survived
verification:

- ✅ **sherpa-onnx-node installs with zero compile** (prebuilt N-API platform packages,
  no node-gyp/cmake, no electron-rebuild) — the spaced-repo-path hazard that bit node-pty
  does not apply. Streaming partials + endpointing confirmed in the actual JS API. Apache-2.0.
  Three shipping Electron consumers, including **paseo** (9.6k★, an Electron
  multi-coding-agent orchestrator — our product category — using sherpa for local speech).
- ✅ **The composer-with-review UX is the industry-validated default**: Claude Code's own
  `/voice` ships dimmed-until-final partials + insert-then-wait-for-Enter, with auto-submit
  strictly opt-in; VS Code's opposite default (silence auto-submit) is its most-complained-
  about voice behavior.
- ✅ **The architecture drops onto existing repo seams**: `voice:port` clones the `pty:port`
  MessagePort pattern; injection reuses the `term.paste()` bracketed-paste seam; the composer
  copies the Command board `SubmitWell` interaction contract; config mirrors `llmConfig.ts`.
  Renderer CSP untouched; zero board-schema impact.
- Two decisions remain open for the user (§8): the default model's license trade-off, and
  the win-arm64 gap posture.

## 2. Engine landscape (verified)

### Primary — sherpa-onnx-node (k2-fsa) ✅ CONFIRMED VIABLE

| Claim | Evidence |
|---|---|
| Current 1.13.3 (2026-06-15); 40 releases in 12 mo | ✅ npm registry |
| Prebuilt platform pkgs: darwin-arm64/x64, linux-x64/arm64, win-x64, win-ia32 | ✅ registry `optionalDependencies` |
| **No win-arm64 package** | ✅ registry 404 — gap, see §8 |
| **Zero install scripts** — no node-gyp/cmake/postinstall anywhere | ✅ registry scripts fields |
| N-API (`node-addon-api ^8.3`) → no electron-rebuild | ✅ build recipe pkg |
| Streaming API: `OnlineRecognizer` + `createStream` → `acceptWaveform`/`decode`/`getResult` partials + `isEndpoint`/`reset` | ✅ shipped example `test_asr_streaming_transducer.js` |
| Offline `OfflineRecognizer` same pkg (whisper/moonshine/parakeet) → later "accuracy mode" = model swap | ✅ examples README |
| Repo: 13.3k★, pushed 2026-06-30; **bus factor ≈ 1** (`csukuangfj` 1,549 commits vs #2's 18) | ✅ GitHub API |
| Electron consumers: paseo (9.6k★), WeFlow (12k★), eve | ✅ GitHub code search |
| Packaged-app loading needs care: asarUnpack + macOS rpath (SIP strips `DYLD_LIBRARY_PATH`) — issues #3108/#2866/#2622/#1945 | ✅ issue tracker |
| utilityProcess use specifically | ◑ unverified — no issues either way; V2 spike proves it |
| <300 ms partial lag | ◑ plausible: lag ≈ chunk size + compute; needs a low-latency chunk model (Kroko/Nemotron 80–160 ms), not the 2023 defaults (~320 ms chunks) |

### Fallback — onnxruntime-node + Moonshine (via transformers.js) ✅

- ✅ ORT 1.27.0, MIT, prebuilt CPU binaries for **all six targets incl. win-arm64**;
  postinstall downloads only (no compile). Electron officially supported (v15+).
- ✅ Gotchas: `.node` must be asarUnpacked (already globbed); **crashes when loaded in
  worker threads** — load once in MAIN/utilityProcess, never per-job workers.
- ✅ Moonshine English models MIT; base ≈ 60 MB int8, WER 10.07 (streaming-small 7.84
  beats whisper large-v3-class); **non-English models = restrictive community license** —
  English-only keeps it clean. transformers.js handles tokenizer/decoder in Node.
- ◑ True-streaming Moonshine generation exists but the JS/ONNX path is unproven —
  fallback would ship chunk-based partials.

### For the record

| Candidate | Verdict |
|---|---|
| @kutalia/whisper-node-addon | Only prebuilt whisper.cpp binding (✅ MIT, Electron-aware); solo maintainer, no win-arm64; "boring Whisper" insurance only |
| smart-whisper / nodejs-whisper / whisper-node | ❌ install-time cmake/node-gyp in a spaced path + stale-to-dormant |
| Parakeet/Nemotron ONNX | Best accuracy; already served **through sherpa-onnx** → a model option, not a separate engine |
| Vosk | ❌ stagnant releases, Kaldi-era accuracy |
| Kyutai STT | ❌ server-class (1–2.6B params, no Node embedding) |
| WhisperKit | ❌ mac-only |
| Renderer WASM (any) | ❌ blocked by prod CSP (`script-src 'self'`, no wasm-unsafe-eval) — rejected by design |

**Decision: sherpa-onnx-node primary; ORT+Moonshine behind the same `VoiceEngine`
interface as fallback (also covers win-arm64 if we ever need it). Synergy: both are
ONNX — one models-directory story.**

## 3. Model catalog (defaults for the pinned manifest)

All at `github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/…` — the documented
distribution channel ✅.

| Model | Size | sha256 published | License | Notes |
|---|---|---|---|---|
| **streaming-zipformer-en-kroko-2025-08-06** | **55 MB** | ✅ (release API digest) | **CC-BY-SA** (engine Apache; community model share-alike; OEM licenses sold) | Low-latency chunks → best shot at <300 ms partials; 8.01 % avg WER int8 (paper) |
| streaming-zipformer-en-2023-06-26 (int8 repack ~70 MB) | 310 MB full / ~70 MB int8 parts | ❌ (we compute + pin ourselves) | ✅ Apache-2.0 | The clean-license default; ~320 ms chunks |
| streaming-zipformer-en-20M-2023-02-17 | 128 MB | ❌ | Apache-2.0 | Smaller/older |
| nemo-streaming-fast-conformer-80ms-int8 | 103 MB | ✅ | ◑ NVIDIA-derived — verify before manifest | 80 ms latency |
| nemotron-3.5-asr-streaming-0.6b (2026-06) | ~464–474 MB | ✅ | ◑ verify | Accuracy tier, near-Whisper-Turbo at 4× speed; no hotwords support |
| silero-vad ONNX | ~2 MB | — | ✅ MIT | v1.5 endpointing |

Manifest integrity: pin self-computed sha256 for anything unpublished (download once at
manifest-authoring time, hash, pin) — the runtime verifies regardless of upstream publishing.

## 4. Electron platform verification — deltas vs assumptions

- ✅ Electron 42 = Chromium 148 / **Node 24.15** (not 22-class — only tooling uses 22).
- ✅ `MessageChannelMain` → `utilityProcess.fork` + `child.postMessage(msg, [port])` is the
  documented canonical pattern; other port → renderer via the exact `pty:port` re-post we
  already ship. utilityProcess = full Node (addons load normally), crash-isolated from MAIN.
- ✅ macOS: `utilityProcess.fork({ allowLoadingUnsignedLibraries: true })` exists for
  unsigned-dylib loading (relevant to sherpa's shared libs before certs land).
- ⚠️ ✅ **Silent-zeros gotcha**: with OS-level mic permission missing (macOS TCC), 
  `getUserMedia({audio:true})` returns a live stream of **zeros — no error** (electron#42714).
  Detection = level monitoring + `systemPreferences.getMediaAccessStatus('microphone')`.
- ✅ Permissions: with no handler, Electron **auto-grants everything**; device labels leak
  pre-grant. Ship BOTH `setPermissionRequestHandler` (audio-only `details.mediaTypes`, own
  origin) AND `setPermissionCheckHandler` on the default session.
- ✅ macOS packaged: `NSMicrophoneUsageDescription` (mac.extendInfo) +
  `com.apple.security.device.audio-input` in entitlements **and entitlementsInherit** (helpers
  do the capture) + hardenedRuntime — sufficient. Windows: OS toggle only, nothing at build
  time. Linux (deb/AppImage): no gate; `libasound` present.
- ✅ Fake-media testing: `--use-fake-device-for-media-stream` +
  `--use-file-for-fake-audio-capture=<wav>` (16-bit PCM WAV, loops unless `%noloop`);
  ◑ Playwright launch-args propagation is unreliable (playwright#16621) → **env-gated
  `app.commandLine.appendSwitch` in MAIN** (`CANVAS_FAKE_MEDIA=1`), matching the
  `CANVAS_SMOKE` pattern.
- ✅ globalShortcut (deferred PTT): silent registration failures on conflicts; Wayland needs
  the GlobalShortcutsPortal (patchy) — in-app hotkey is the right v1 call.
- ✅ Prior art: **VS Code Speech = the architectural precedent** — fully on-device Azure
  Speech embedded models, platform-specific extension packages, inference in the Node
  extension host (utilityProcess-analog), capture elsewhere. Same split we designed.

## 5. UX prior art → contract refinements (all folded into SPEC.md)

| Finding | Source | Consequence for us |
|---|---|---|
| **Claude Code `/voice`**: partials stream **dimmed until finalized**; release → insert at cursor → **waits for Enter**; autoSubmit opt-in with **≥3-word guard**; silence (15 s) stops recording, never submits; 2 min cap | ✅ official docs | Our exact design, shipped by the most relevant product. Copy the thresholds + the 3-word guard (future opt-in). |
| VS Code auto-submits at ~1.2 s silence → most-complained-about voice behavior (vscode#274462) | ✅ | **Never auto-submit on silence.** |
| superwhisper: **one key, two behaviors** — quick-press = toggle, hold = push-to-talk | ✅ | Adopt for our in-app hotkey (10–60 s prompts need toggle; short bursts prefer hold). |
| Aqua's replace-on-final "blink" complaint; Wispr's over-editing complaint | ✅/◑ | Dimmed-tail replaces only the tail; v1 ships RAW transcript (no LLM cleanup). |
| Claude Code injects project/branch as recognition hints | ✅ | v1.5: hotwords (board title/project/branch) via `modified_beam_search` — transducers support it; Nemotron doesn't. |
| Modifier-combo hotkey avoids bare-key warmup hacks | ✅ CC docs | Keep `Ctrl/Cmd+Shift+M`. |

## 6. Final architecture (post-verification)

Unchanged from the design phase except the four platform corrections (§4):

```
RENDERER (sandboxed, CSP untouched)          MAIN                        ENGINE HOST
VoiceComposer in TerminalBoard   ◄──────  voiceIpc.ts  ──────►  utilityProcess: sherpa-onnx-node
  mic btn + hotkey (hold|toggle)          voice:session/models/     OnlineRecognizer streaming
  dimmed partial tail, editable           config (invoke)           loop; endpointing; (silero
  Insert | Send                           MessageChannelMain:       VAD v1.5); custom loader for
    │                                     port1→renderer            asar.unpacked paths (paseo
getUserMedia + AudioWorklet               ('voice:port' re-post)    precedent)
  48k→16k mono Int16 ~120ms               port2→utilityProcess
  frames + RMS level  ────────────── voice:port ──────────────►  partial/final/status/error ◄──
terminalInputRegistry.paste = term.paste() · Send = paste + settle + discrete '\r'
```

## 7. Risks (updated)

1. **Packaged-app addon loading** (the real #1, per sherpa issue tracker): asarUnpack the
   `sherpa-onnx-*` platform packages; custom loader resolving `app.asar.unpacked`; macOS
   rpath layout (not DYLD env — SIP); V5 packaged smoke on all 3 OSes. paseo's loader = ref.
2. **utilityProcess + this addon** ◑ unproven → V2 spike first; in-MAIN fallback host is
   one file behind the `VoiceEngine` interface.
3. **Bus factor 1** on sherpa-onnx → fallback engine lane (ORT+Moonshine) kept warm;
   Apache-2.0 permits a fork if ever needed.
4. **Silent-zeros mic failure** → level watchdog + `getMediaAccessStatus` surface, V1.
5. **Unreviewed text to agent** → `autoSendOnFinal` hard-false; Send = only `\r` emitter;
   e2e asserts exact byte sequence.
6. Model download integrity/failure → pinned sha256 (self-computed where unpublished),
   `.part` + atomic rename, clear composer states.

## 8. Open decisions — RESOLVED (user, 2026-07-02)

1. **Default model**: ✅ **Kroko default, both cataloged.** Kroko 55 MB (published sha256,
   low-latency chunks, better WER; CC-BY-SA community model — our manifest points at their
   URLs, we never redistribute) ships as default with a license note in Settings; the
   fully-Apache repacked int8 zipformer (~70 MB, self-pinned sha256) stays as the
   alternative pick.
2. **win-arm64**: ✅ **feature-gated off in v1** (sherpa ships no binary; tiny audience).
   Revisit when sherpa adds binaries or if the ORT+Moonshine fallback lane lands.
3. **Design artifact**: ✅ mock v2 (floating draggable pill + review flyout) **approved
   as-is**.
