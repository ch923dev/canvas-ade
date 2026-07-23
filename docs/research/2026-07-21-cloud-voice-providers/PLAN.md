# Cloud Voice Providers — STT + TTS

**Date:** 2026-07-21
**Status:** plan, unapproved
**Scope:** make Expanse's dictation (STT) and Jarvis speech (TTS) selectable between the
current on-device sherpa-onnx engines and cloud providers, without touching the renderer's
capture / playback / barge-in / Jarvis-turn machinery.

**Companion doc:** `STT-ACCURACY.md` — the push-to-talk / batch-ASR / keyterm-biasing design.
It **supersedes §2.1** of this file and rewrites Phase 2. Read both.

---

## 1. The finding that shapes everything

The renderer↔engine **session-port protocol is already provider-agnostic**. It is a plain-JSON
MessagePort contract, and nothing in it mentions sherpa, ONNX, or local files:

| Direction | Message | Source |
|---|---|---|
| renderer → engine | `{t:'frame', d:ArrayBuffer}` — 120 ms of 16 kHz mono Int16 PCM | `src/main/voiceEngineHost.ts:33` |
| renderer → engine | `{t:'eos'}` — last message of a session, host drain sentinel | `src/main/voiceEngineHost.ts:34` |
| engine → renderer | `{t:'partial', text}` / `{t:'final', text}` / `{t:'stop'}` | `src/main/voiceEngineHost.ts:32-49` |
| engine → renderer | `{t:'tts:chunk', id, seq, sampleRate, pcm16}` (base64 PCM16LE, **self-describing rate**) | `src/main/voiceTtsRunner.ts:53-56` |
| engine → renderer | `{t:'tts:done', id, cancelled}` / `{t:'tts:error', id, error}` | `src/main/voiceTtsRunner.ts:53-56` |
| engine → renderer | `{t:'wake', keyword}` | `src/main/voiceEngineHost.ts:334-356` |

And `VoiceEngineHandle` (`src/main/voiceEngine.ts:44-85`) is a real, already-swapped interface —
`createStubVoiceEngine` (`src/main/voiceEngineStub.ts:40-162`) is a second implementation proving
the seam works.

**Consequence: a cloud engine is a third `VoiceEngineHandle` implementation.** Zero renderer
changes. `useVoiceCapture`, `ttsPlayback`'s Web Audio scheduler, `ttsBargeIn`, `utteranceHold`,
`finalConsumer`, `jarvisSession` — all untouched. That is the whole reason this is tractable.

Two mismatches to fix at the seam:

1. `VoiceEngineHandle.startSession(port, model: VoiceModelPaths | null)` is typed on **local file
   paths**. A cloud engine needs an endpoint + credential instead. → widen to a
   `VoiceSource` union (§3.1).
2. `VoiceConfig.engine: 'sherpa-onnx' | 'cloud'` and `cloudProvider?: string` already exist
   (`src/main/voiceConfig.ts:21-24, 39-40`) but are **completely dead** — parsed by
   `repairVoiceConfig`, branched on nowhere. Flipping `engine:'cloud'` today silently runs sherpa.
   → replace with a real discriminated config (§3.2), do not build on the free-text placeholder.

---

## 2. Provider selection (research, July 2026)

### 2.1 STT — SUPERSEDED by `STT-ACCURACY.md`

> **Revised 2026-07-21.** The premise below assumes we keep live streaming with partial transcripts.
> We are instead moving to **push-to-talk** (hold key → speak → release → transcribe whole
> utterance), which unlocks batch models. Deepgram publishes both numbers for Nova-3: **streaming
> 6.84% WER vs pre-recorded 5.26%** — ~23% relative error reduction from the same model just by
> giving it the whole utterance. That reverses the pick.
>
> **Read `STT-ACCURACY.md` for the current STT design.** Headlines: default becomes
> **Groq whisper-large-v3-turbo** ($0.00067/min, sub-second, effectively free) with **AssemblyAI
> Universal-3 Pro** as the accuracy tier; the real accuracy lever is **keyterm biasing seeded from
> the user's own repo symbols** (capped at ~30 terms — longer lists measurably backfire); and the
> architecture is **two-pass** — keep the existing local streaming engine as a dimmed ghost draft
> while recording, swap in the batch result on release.
>
> The table below remains valid for one thing only: **if we ever want live streaming back**, this is
> the correct ranking, and Deepgram is still the right streaming pick.



The decisive axis is **format**: we already emit exactly 16 kHz mono Int16 PCM in 120 ms frames.

| Provider | Takes our frames as-is? | Partials | Endpointing controls | Price | Verdict |
|---|---|---|---|---|---|
| **Deepgram Nova-3** | ✅ `encoding=linear16&sample_rate=16000`, raw WS binary | ✅ `interim_results` | `endpointing`, `utterance_end_ms`, `vad_events` | ~$0.0077/min | **default** |
| **AssemblyAI Universal-Streaming** | ✅ `pcm_s16le` @16 k raw | ✅ partial turns | `min/max_turn_silence`, EOT confidence | ~$0.15/hr | **fallback** |
| Speechmatics | ✅ `pcm_s16le` | ✅ | `max_delay`, EOU silence trigger | ambiguous | third option |
| OpenAI Realtime (transcription session) | ❌ pcm16 **24 kHz only** → resample | ✅ delta/completed | `server_vad` / `semantic_vad` | ~$0.003–0.017/min | later, if user already has an OpenAI key |
| Google STT v2 (Chirp 3) | format ✅ / transport ❌ gRPC-only + service-account OAuth + 5-min stream cap | ✅ | `single_utterance` | ~$0.016/min | skip |
| Azure Speech | ✅ via SDK only (no first-party raw-WS protocol) | ✅ | segmentation timeout | ~$1/hr | skip |
| Groq whisper-turbo | ❌ needs a container file, **no streaming, no partials** | ❌ | — | $0.04/hr | architecturally incompatible |

Deepgram also has the tightest ops story for us: `/auth/grant` short-lived JWTs, a documented
`KeepAlive` (every 3–5 s, 10 s idle timeout → `NET-0001`), a `Finalize` flush, and
`CloseStream` for graceful shutdown. Its docs also say 100 ms chunks are optimal on stable links,
200 ms when degraded — **our existing 120 ms frame size is already in the sweet spot.**

Privacy: Deepgram real-time is zero-retention by default, no training unless you opt into the
Model Improvement Partnership, EU endpoint GA since 2026-01-10. AssemblyAI offers zero-retention
on Streaming when opted out of training, plus EU (Dublin) residency. Both acceptable defaults for
a dev tool; both must be stated in the Settings UI.

### 2.2 TTS — start on OpenRouter (no new key), Aura-2/Cartesia as the latency upgrade

> Revised 2026-07-21 after verifying OpenRouter's audio endpoints live. See §2.3 — OpenRouter
> reuses the key we already hold, and hosts the *same Kokoro model we already ship locally*.
> It has no WebSocket and no input-text streaming, so it is the cheap entry point, not the
> endgame. The direct-vendor comparison below still governs the Phase-4 upgrade choice.


The decisive axes are **raw PCM out** (keeps our Web Audio scheduler intact) and
**input-text streaming** (we feed Jarvis LLM deltas clause-by-clause today, `jarvisSession.ts:294-311`).

| Provider | Raw PCM out | Input text streaming | TTFB | Cancel mid-stream | ~$/mo @1 hr/day |
|---|---|---|---|---|---|
| **Deepgram Aura-2** | ✅ linear16 @8/16/24/32/48 k | ✅ `Speak` + `Flush`/`Clear`/`Close` | ~90–200 ms | ✅ `Clear` = destructive buffer abort | ~$42–46 |
| **Cartesia Sonic (Turbo/3.5)** | ✅ pcm_s16le/f32le × 6 rates | ✅ `context_id` + `continue` | **~40 ms** Turbo | ✅ explicit Cancel-Context msg | ~$68–77 |
| ElevenLabs Flash v2.5 | ✅ pcm_16000/22050/24000/44100 | ✅ multi-context WS | ~75 ms model | context close | ~$77 |
| Google Chirp 3 HD | ✅ LINEAR16 | ✅ bidi gRPC streamingSynthesize | ~200 ms | close stream | ~$16 (1 M chars free) |
| Azure Neural | ✅ Raw24Khz16BitMonoPcm | ✅ but **v2 WS endpoint only** | unpublished | ⚠️ `StopSpeakingAsync` community-reported unreliable on long text | ~$16–23 |
| OpenAI gpt-4o-mini-tts | ✅ raw 24 kHz PCM | ❌ no incremental input | unpublished | close connection | ~$27 |

Aura-2's `Clear` maps 1:1 onto our existing barge-in epoch flush (`voiceTtsRunner.ts:118-171`),
and linear16 drops straight into `{t:'tts:chunk', sampleRate, pcm16}` with only a
`Buffer→base64` step. Cartesia wins on raw TTFB and is the upgrade path if 200 ms feels slow.

ElevenLabs caveat if we add it: **non-Enterprise tiers train on your data by default** — the only
surveyed vendor that does. Must be surfaced in the UI, not buried.

### 2.3 OpenRouter — reuse the key we already have

**Verified live 2026-07-21** against `openrouter.ai/docs/guides/overview/multimodal/{tts,stt}`.

| | Endpoint | Shape |
|---|---|---|
| TTS | `POST /api/v1/audio/speech` | OpenAI-compatible. `model`, `input`, `voice`, `response_format`, `speed`, `provider`. Docs: *"Audio output format: `mp3` or `pcm`. **Defaults to `pcm`**"*. HTTP response-body streaming (SDK examples use `getReader()` / `with_streaming_response`). |
| STT | `POST /api/v1/audio/transcriptions` | base64 JSON or multipart, wav/mp3/flac/m4a/ogg/webm/aac. 25 MB multipart cap, upstream 60 s timeout. **Batch only — no streaming, no partials.** |

**The wiring already exists.** No new key, no new base URL, no new store:

- `llmConfig.ts:11` — `ProviderName` already includes `'openrouter'`
- `llmService.ts:29-32` — `OPENAI_SHAPE_BASE.openrouter = 'https://openrouter.ai/api/v1'`
- `llmKeyStore` already holds the key under that name; `keyForProvider` (`llmService.ts:150`) does
  store-first / `OPENROUTER_API_KEY` env fallback

**TTS catalog** (OpenRouter's own listing, quoted verbatim in its units):

| Model | Listed price |
|---|---|
| **hexgrad: Kokoro 82M** | **$0.62/M input tokens** |
| Canopy Labs: Orpheus 3B · Sesame: CSM 1B | $7/M input tokens |
| xAI: Grok Voice TTS 1.0 | $15/M input tokens |
| Mistral: Voxtral Mini TTS | $16/M input tokens |
| Microsoft: MAI-Voice-2 | $22/M input tokens |
| **Deepgram: Aura-2** | **$30/M input tokens** |
| MiniMax Speech 2.8 Turbo / HD | $60 / $100 per M input tokens |
| Google: Gemini 3.1 Flash TTS Preview | $1/M in + $20/M out |

**The standout: Kokoro 82M is the model we already ship locally** (`voiceTtsModels.ts` catalog).
Hosting it means cloud TTS that sounds *identical to the local engine* — switching engines does not
change how Jarvis sounds. At ~1 hr/day of speech that is on the order of **$1/month or less**.

Aura-2 on OpenRouter lists at the same headline number as going direct to Deepgram ($30) — so
routing through OpenRouter appears to cost no markup while removing a credential.

⚠️ **Two unverified numbers — do not quote to a user yet.**
1. **Unit ambiguity.** OpenRouter labels these *"per M input tokens"*; Deepgram bills Aura-2 *"per M
   characters"*. If OpenRouter's "tokens" are real text tokens (~4 chars), every figure above is
   ~4× cheaper than a naive char-reading — which would make OpenRouter *cheaper than the vendor it
   resells*, and that is implausible enough to assume the UI is loosely labelling characters. The
   conclusion (Kokoro is dirt cheap, Aura-2 is not marked up) holds either way; the precision does
   not. Resolve empirically with one metered request before any UI shows a dollar estimate.
2. **PCM sample rate is undocumented** on every OpenRouter page fetched. Our chunk message
   self-describes its rate (`{t:'tts:chunk', sampleRate, pcm16}`), so we *must* know it. Probe each
   model once and pin the value in our own catalog. Blocking, but cheap.

**Limits that keep it from being the endgame:**
- **No WebSocket, no input-text streaming.** No `context_id`/`continue` gapless continuation, no
  `Clear` barge-in primitive. One HTTP request per clause. Our `speakChain` already serializes
  clauses (`jarvisSession.ts:294-311`) so it maps cleanly, but we pay TTFB *per clause* instead of
  amortizing it across an utterance.
- **Barge-in becomes `AbortController` on the fetch.** Known gotcha: `reader.read()` does not
  resolve on abort — you must register an abort listener that explicitly calls `reader.cancel()`,
  or the read hangs. The renderer's local duck-and-flush (`ttsPlayback.ts:216-247`) already fires
  in ~80 ms without waiting on us, so perceived barge-in latency is unchanged; only the
  stop-paying-the-vendor half depends on this.

**STT: re-evaluate — batch-only is no longer a disqualifier.** This was written assuming live
streaming. Under push-to-talk (`STT-ACCURACY.md`) **batch-only is exactly the right shape**, and
OpenRouter becomes a genuine zero-new-key STT candidate rather than a consolation prize. Two things
to check before promoting it: (a) does `/api/v1/audio/transcriptions` expose a **biasing param**
(`prompt`/keyterms)? Without one it can't take our repo symbols, which §3.1 of `STT-ACCURACY.md`
rates as the single biggest accuracy lever — **unverified**. (b) STT pricing is token-based (Nova-3
$4,300/M input tokens, Whisper Large V3 $1,500/M) with no published audio-seconds conversion, so a
$/min comparison against Groq's $0.00067/min is **not yet derivable**.

It remains the natural **no-second-key fallback** when local is unavailable, and it already suits
converse mode, since `utteranceHold` buffers whole utterances before sending.

OpenRouter has no realtime voice surface either, so §2.4's verdict is unaffected.

### 2.4 Do NOT move converse mode to a unified realtime API

Evaluated OpenAI Realtime (`gpt-realtime-2.1`, GA), Gemini Live, AWS Nova 2 Sonic. Verdict: **keep
the 3-stage pipeline.** Three reasons:

1. **They own the brain.** None of them let you substitute your own LLM as the mid-loop reasoner.
   Your control surface is system prompt + tool definitions. Jarvis's whole point is our own brain
   + our own tool layer (`jarvisTools.ts`, `jarvisToolContext.ts`, confirm-gates). Using them in
   STT-only / TTS-only mode reconstructs the 3-stage pipeline anyway, minus the benefits.
2. **Always-on billing.** Audio-input tokens accrue for wall-clock streamed audio including
   silence. Our architecture is wake-word-gated (`voiceKwsModels.ts`) — a local KWS gate costs
   $0 during silence; a permanently-open realtime session does not.
3. **Cost spread.** Pipeline ≈ $34/mo at 1 hr/day. OpenAI Realtime real-world measurements land
   at $0.18–0.46/min uncached (~$324–828/mo), $0.05–0.10/min cached (~$90–180/mo). Nova 2 Sonic
   ≈ $27/mo is the one competitive unified option, but it still owns the brain.

Latency does not rescue the case either: a tuned pipeline lands ~600 ms–1.2 s voice-to-voice,
realtime APIs 210–800 ms in practice. Not worth ceding the agent loop.

Anthropic has **no** developer-facing realtime voice API as of July 2026 — Claude Code voice mode
is push-to-talk dictation, Claude.ai-account-only, no barge-in, not exposed via API key.

Optional far-future: a bounded "quick voice command" surface could use a realtime API without
touching Jarvis. Out of scope here.

---

## 3. Design

### 3.1 The seam — a third `VoiceEngineHandle`

```
renderer (UNCHANGED)
  useVoiceCapture ── {t:'frame'} ──▶ MessagePort
                                        │
                            voiceIpc.ts resolves ONE handle:
                            explicit test dep → e2e stub → cloud → local sherpa host
                                        │
              ┌─────────────────────────┴───────────────────────────┐
    createVoiceEngine (existing)                      createCloudVoiceEngine (NEW)
    utilityProcess out/main/voiceEngineHost.js        utilityProcess out/main/voiceCloudHost.js
    sherpa-onnx-node native addon                     ws → Deepgram / AssemblyAI / Aura-2
              └─────────────────────────┬───────────────────────────┘
                                        │
        {t:'partial'|'final'|'tts:chunk'|'wake'} ──▶ renderer (UNCHANGED)
```

**Why a separate utilityProcess, not main and not the existing host:**

- Not **main**: main-process freezes during native window drag pause `setInterval`, which would
  stall Deepgram's 3–5 s `KeepAlive` and drop the socket (Electron #11782).
- Not **renderer**: the API key must never cross into renderer memory (Electron security guidance);
  also `ws` throws in an Electron renderer (loads its browser shim, websockets/ws#1459) so we would
  be stuck on Chromium's `WebSocket`, which `session.setProxy()` does not reliably cover
  (Electron #34810) and which cannot take a custom CA for corporate TLS interception
  (Electron #41590 — `NODE_EXTRA_CA_CERTS` is not respected).
- Not **inside `voiceEngineHost`**: that entry `require()`s `sherpa-onnx-node` at boot. A
  cloud-only user should not pay a native-addon load. Keeping it separate also keeps the
  asarUnpack'd native surface out of the cloud path entirely.
- ✅ **New utilityProcess**: reuses the *exact* proven port mechanics (transfer a
  `MessagePortMain` in via `postMessage(msg, [port])`, post plain JSON back) that
  `voiceEngineHost` already does today, plus full Node `ws` with proxy-agent and `ca:` options.

**Key delivery:** decrypted at session-start in MAIN, passed in the `session:start` **message
payload**, never in the child's env (env is readable from a process listing on some platforms) and
never in `launchCommand`. Same discipline as the `__TERMINAL_OPENROUTER__` lane
(`ptySpawnEnv.ts:74-98`).

**Type change** (`src/main/voiceEngine.ts:44-85`):

```ts
export type SttSource =
  | { kind: 'local'; model: VoiceModelPaths }
  | { kind: 'cloud'; provider: CloudSttProvider; apiKey: string; opts: CloudSttOpts }

export type TtsSource =
  | { kind: 'local'; model: TtsModelPaths }
  | { kind: 'cloud'; provider: CloudTtsProvider; apiKey: string; opts: CloudTtsOpts }

startSession(port: MessagePortMain, src: SttSource | null): void
startTtsSession(port: MessagePortMain, src: TtsSource | null): void
```

The local host ignores `kind:'cloud'` and vice versa — `voiceIpc` never routes the wrong one, but
each host rejects defensively (post an error over the port rather than crash).

`stopSession` / `ttsSpeak` / `ttsCancel` / `stopTtsSession` / `onEngineFailure` / `onTtsFailure` /
`dispose` keep their current signatures unchanged. The restart-once policy and failure escalation
in `voiceIpc` work as-is for both.

### 3.2 Config

Delete the dead placeholders. Mirror `llmConfig.ts`'s proven pattern (`ProviderName` union +
`DEFAULT_*: Record<ProviderName, …>` so the list cannot drift, unknown values repaired to default).
`VoiceConfig` (`src/main/voiceConfig.ts`) gains:

```ts
export type CloudSttProvider = 'openrouter' | 'deepgram' | 'assemblyai'
export type CloudTtsProvider = 'openrouter' | 'deepgram' | 'cartesia'

// replaces engine:'sherpa-onnx'|'cloud' + cloudProvider?:string (both removed)
sttEngine: 'local' | CloudSttProvider
ttsEngine: 'local' | CloudTtsProvider

sttCloud: {
  openrouter: { model: string }            // batch — fallback / transcribe-on-release only
  deepgram:   { model: string; keyterms: string[]; endpointingMs: number; utteranceEndMs: number }
  assemblyai: { model: string; minTurnSilenceMs: number; maxTurnSilenceMs: number }
}
ttsCloud: {
  openrouter: { model: string; voice: string }  // default model: hexgrad Kokoro 82M
  deepgram:   { voice: string }
  cartesia:   { voiceId: string; model: string }
}

// §3.6 cost rails
cloudMonthlyCapUsd: number   // 0 = uncapped
cloudGateSilence: boolean    // don't upload silence
```

No `schemaVersion` — voice config uses **field-level read-repair** (`repairVoiceConfig`,
`voiceConfig.ts:86-124`), not the two-tier doc-schema convention. Adding a field means adding it to
the interface + repair with a default; old configs just get defaults. Keep it that way.

`ttsModelId` / `ttsDuplex` / `modelId` stay — they are the `local` engine's settings and remain
live whenever the user flips back.

### 3.3 Keys

`createKeyStore` (`src/main/llmKeyStore.ts:54-105`) is the right mechanism but is **typed on
`ProviderName` imported from `llmConfig.ts`** (LLM providers only). Two changes:

1. Generic-parameterize: `createKeyStore<P extends string>(userDataDir, encryptor, file)`.
   Existing LLM call site becomes `createKeyStore<ProviderName>(dir, enc, 'llm-keys.json')` —
   behavior identical.
2. New instance for voice: `createKeyStore<CloudSttProvider | CloudTtsProvider>(dir, enc,
   'voice-keys.json')`. Separate file, so an LLM key and a voice key for the *same vendor name*
   (e.g. `openai`) never collide, and revoking one never touches the other.

**Exception — `openrouter` reads the EXISTING LLM store, never `voice-keys.json`.** The whole point
of the OpenRouter lane (§2.3) is that there is one OpenRouter key with one revoke point, already
resolved by `keyForProvider` (`llmService.ts:150`) with its store-first / `OPENROUTER_API_KEY`
env fallback. Duplicating it into a voice store would create exactly the split-brain the separate
file exists to prevent. So key resolution branches:

```ts
const keyFor = (p: VoiceProvider): string | undefined =>
  p === 'openrouter' ? keyForProvider('openrouter', env, llmKeys) : voiceKeys.getKey(p)
```

Settings must reflect this: the OpenRouter row shows "using your Context·LLM key" with a link to
that section, **not** its own key field.

Keep the existing safety properties: `setKey` refuses when `safeStorage.isEncryptionAvailable()`
is false; `getKey`/`hasKey` share one `tryDecrypt` so an undecryptable entry reports absent
(the BUG-005 split-brain fix).

**New Linux guard:** call `safeStorage.getSelectedStorageBackend()`. When it returns `basic_text`
the "encrypted" blob is PBKDF2-HMAC-SHA1 with a hardcoded salt and **1 iteration** — trivially
recoverable from disk. Electron's DE detection is also brittle: tiling WMs (Hyprland, Sway, i3,
bspwm) fall through to `basic_text` even with a working libsecret daemon (electron#39789).
Behavior: refuse to persist, show a Settings banner explaining why, offer a session-only key held
in main memory instead.

**Ephemeral tokens do not help us.** Deepgram `/auth/grant` (30 s default, 1 h max), AssemblyAI
temp tokens (60 s–3 h), OpenAI `client_secret` — every one of them requires a trusted minting party
holding the durable key. We have no backend. So: **BYO-key only.** The user supplies their own
Deepgram/AssemblyAI/Cartesia key, we hold it in main via `safeStorage`, it never reaches the
renderer. Shipping a vendor key in the binary is not an option (no real protection, abuse liability
lands on us).

### 3.4 STT cloud host — protocol details

- **Connect** on `session:start`, not on host boot, so no socket exists while idle.
- Deepgram URL params: `encoding=linear16&sample_rate=16000&channels=1&interim_results=true&endpointing=<cfg>&utterance_end_ms=<cfg>&vad_events=true&model=<cfg>` plus `keyterm=` per configured term (Nova-3 only), `language=multi` + `endpointing=100` for code-switching.
- **Frames go out unchanged** — `{t:'frame', d}` → `ws.send(Buffer.from(d))`. No resample, no
  re-encode, no container. This is why Deepgram/AssemblyAI were chosen.
- **Map results onto the existing port protocol**: `is_final:false` → `{t:'partial', text}` (only
  when text changed, matching the local host's dedupe at `voiceEngineHost.ts:151-194`);
  `speech_final` / `UtteranceEnd` → `{t:'final', text}`. Renderer cannot tell the difference.
- **`{t:'eos'}` → send `Finalize`**, await the trailing final, then `CloseStream`, then reply
  `{t:'session:stopped', frames}` to MAIN. Preserves the existing exact drain-count contract.
- **KeepAlive** every 3 s on a timer owned by the utilityProcess (not main — see §3.1).
- **Backpressure**: check `ws.bufferedAmount` before each send; above ~64 KB drop the oldest
  queued frame rather than unbounded-buffering (a 120 ms frame is 3840 B, so 64 KB ≈ 2 s of audio —
  past that we are losing realtime anyway).
- **Reconnect**: exponential backoff 1/2/4/8 s capped at 30 s, with jitter, replaying a rolling
  ~3 s pre-roll buffer into the new socket. Deepgram closes a connection that receives no audio
  within 10 s of open, so the replay must start immediately. After N failures escalate
  `{t:'decoder:error'}` — which `voiceEngine.ts:121-133` already turns into the restart-once policy
  and, if the budget is spent, the existing "Restart" UI. **No new failure UX needed.**
- **AssemblyAI billing note**: billed on **wall-clock WS session duration**, not audio duration.
  Idle sockets cost money → close promptly on `{t:'eos'}`, never hold one open "just in case".

### 3.5 TTS cloud host — protocol details

**OpenRouter (HTTP, the entry point).** `POST /api/v1/audio/speech` with
`{model, input: clause, voice, response_format:'pcm'}`, read the response body as a stream, slice
into chunks, emit `{t:'tts:chunk', id, seq, sampleRate: <pinned per model>, pcm16}`. One request per
`ttsSpeak`, which matches how Jarvis already enqueues clauses. `ttsCancel()` → `AbortController.abort()`
**plus an explicit `reader.cancel()` in the abort listener** (without it `read()` never resolves and
the request hangs), then close open ids with `{t:'tts:done', cancelled:true}` — same settle contract
as `createTtsRunner.cancel()` (`voiceTtsRunner.ts:166-171`). Sample rate must be probed and pinned
per model before this ships (§2.3).

**Deepgram Aura-2 WS** (Phase 4 upgrade):

- Deepgram Aura-2 WS: `encoding=linear16&sample_rate=24000&model=<voice>`. Audio frames arrive as
  binary → `floatToPcm16Base64`'s job is already done for us (it is already PCM16LE), so we only
  base64 it into `{t:'tts:chunk', id, seq, sampleRate: 24000, pcm16}`. The chunk message already
  self-describes its rate (`voiceTtsRunner.ts:51-52`), so mixed local-22.05 k / cloud-24 k playback
  needs no scheduler change.
- Jarvis streams clauses (`jarvisSession.ts:294-311`) → map each `ttsSpeak` to a `Speak` message +
  `Flush`. Watch Deepgram's 20-flushes-per-60 s rate limit; coalesce very short clauses.
- **Barge-in**: `ttsCancel()` → send `Clear` (destructive buffer abort, stops billing for
  ungenerated audio) then close all open ids with `{t:'tts:done', cancelled:true}` — identical to
  what `createTtsRunner.cancel()` does today (`voiceTtsRunner.ts:166-171`). Renderer's
  `duckAndFlush` already ducks locally in ~80 ms without waiting on us, so perceived latency is
  unchanged.
- **Cartesia** variant: `context_id` + `continue:true` per clause gives gapless multi-sentence
  output across a single logical utterance, and an explicit Cancel-Context message for barge-in.
  Strictly better shape than Aura-2 for our clause-streaming pattern — reason it is the premium tier.
- **Avoid Azure for TTS** if we ever add it: `StopSpeakingAsync()` is community-reported to not
  reliably cut long-text synthesis (up to ~30 s of audio continues). Barge-in is non-negotiable here.

### 3.6 Cost + privacy rails (this is the part that decides whether people turn it on)

1. **Wake-gated cloud.** We already ship local KWS ("Hey Jarvis", `voiceKwsModels.ts`). Wake word
   stays **local, always** — never a cloud provider. Cloud STT connects only after wake or after an
   explicit hotkey/pill press. Idle cost: $0. This is the single biggest lever and it is already
   half-built.
2. **Silence gating** (`cloudGateSilence`). `captureMath.ts` already computes per-frame RMS. Gate
   frame forwarding on RMS + a hangover window, with a ~300 ms pre-roll ring so the leading
   consonant is not clipped. Caveat: providers endpoint on *silence*, so on gate-close send a short
   trailing silence + `Finalize` rather than just going quiet. Ship gating **off** in Phase 1,
   on in Phase 3 once endpointing behavior is measured.
3. **Meter.** Count streamed seconds per session in the cloud host, report to MAIN on stop,
   accumulate per calendar month in `userData`. Settings shows "this month: 42 min ≈ $0.32".
   Estimates only, labeled as such.
4. **Cap.** `cloudMonthlyCapUsd` — on breach, refuse to open a cloud session and auto-fall-back
   to local, with a toast. Never silently keep spending.
5. **Offline / no-key fallback.** Cloud selected but socket fails to open, or no key, or cap hit →
   fall back to the local engine for that session if its model is installed, toast the reason. If
   no local model is installed either, the existing `modelStatus:'absent'` path already handles it.
6. **Privacy copy in Settings, per provider**: retention default, training default, residency
   option. Deepgram = zero-retention + no-training default. AssemblyAI = zero-retention on
   Streaming when opted out. ElevenLabs (if added) = **trains by default below Enterprise** — say so.

### 3.7 What does NOT change

`useVoiceCapture.ts`, `captureWorklet.ts`, `captureMath.ts` (except the optional gate),
`ttsPlayback.ts`, `ttsSession.ts`, `ttsBargeIn.ts`, `ttsStore.ts`, `voiceStore.ts`,
`finalConsumer.ts`, `utteranceHold.ts`, `jarvisSession.ts`, `VoicePill.tsx`, `VoiceFlyout.tsx`,
`src/preload/voice.ts` (the control-plane surface is provider-agnostic already), and the whole
Jarvis brain/tool layer.

The `ttsDuplex: 'full'|'half'` echo strategy also carries over unchanged — the bigram-overlap echo
filter (`ttsBargeIn.ts:69-91`) operates on transcript *text*, so it is provider-independent. Worth
noting that Chromium's `echoCancellation:true` never cancelled our own Web Audio TTS playback in
the first place (chromium#687574 — AEC only engages on WebRTC "remote" streams), which is exactly
why 'half' duplex exists. Cloud STT raises the stakes: unfiltered echo now costs money *and*
produces false barge-ins. Keep 'half' as the recommended default for cloud until measured.

---

## 4. Phases

Each phase is independently shippable, reviewer-clean, and behind config — the default stays
`local` throughout, so no existing user's behavior changes until they opt in.

### Phase 0 — Foundations (no behavior change)
- Generic-parameterize `createKeyStore`; add the `voice-keys.json` instance.
- `safeStorage.getSelectedStorageBackend()` guard + Settings banner for `basic_text`.
- Replace dead `engine`/`cloudProvider` with `sttEngine`/`ttsEngine`/`sttCloud`/`ttsCloud` +
  repair defaults. All values still resolve to `local`.
- Widen `VoiceEngineHandle` to `SttSource`/`TtsSource`; update the local host, the stub, and
  `voiceIpc`'s resolution to the new shape. Pure refactor — existing tests must pass unchanged
  apart from the type update.
- **Gate:** full unit suite green, e2e voice specs green, zero behavior delta.

### Phase 1 — Cloud TTS via OpenRouter (cheapest path to shipping anything)
Promoted ahead of STT after §2.3: **no new credential, no new store, no new base URL**, and hosted
Kokoro is the same voice we already ship locally — so the risk of "cloud sounds different" is zero.
- New `src/main/voiceCloudHost.ts` utilityProcess + `createCloudVoiceEngine` in
  `src/main/voiceCloudEngine.ts`. esbuild it self-contained like the ptyhost staged bundle
  (`ptyhost-staged-bundle-fix` precedent — a chunked `require` in a staged daemon already burned us).
- **First task: probe and pin the PCM sample rate** per OpenRouter TTS model. Blocking; everything
  downstream is wrong without it.
- HTTP streaming speak, per-clause requests, abort+`reader.cancel()` barge-in.
- Settings › Voice › Speech: engine picker with an OpenRouter row reading "using your Context·LLM
  key", model picker (Kokoro default), preview button.
- **Gate:** unit tests over a fake HTTP server; explicit barge-in dev check with a real key (this is
  the failure mode that will actually annoy users); full e2e matrix green.

### Phase 1.5 — STT eval harness (do this before choosing an STT provider)
No benchmark anywhere measures WER on code vocabulary (`STT-ACCURACY.md` §2). Every provider choice
is currently a guess. ~A day of work converts three guesses into measurements.
- Record ~50–100 real technical utterances (function names, CLI flags, file paths, library names).
- A WER scorer + a runner that fans the same audio at 2–3 candidate providers, with and without
  keyterm biasing, and at the local offline model.
- **Gate:** a table of measured WER on OUR audio. This decides Phase 2.

### Phase 2 — Push-to-talk + batch STT (two-pass)
Supersedes "Cloud STT (Deepgram)". Full design in `STT-ACCURACY.md` §5.
- Push-to-talk capture: ring buffer with ~250 ms pre-roll, hold-vs-tap detection with warmup,
  15 s-silence / 2 min caps, plus a toggle mode (RSI — sustained key-hold is a real accessibility
  failure mode).
- Two-pass: existing local streaming engine renders a **dimmed ghost draft** while recording; on
  release lock the input, run the batch pass, atomically replace the span, un-dim. Never blank the
  draft during the gap.
- Batch pass over HTTP (WAV-header wrap — only Deepgram documents raw headerless PCM). Provider per
  the Phase 1.5 result; presumed Groq turbo default, AssemblyAI accuracy tier.
- **Keyterm injection**, capped ~30 terms, ranked focused-file → project → static dev-jargon list.
- Deterministic replacement layer for code formatting (`.ts`, `--flag`, casing).
- Audio hygiene: disable aggressive noise suppression on this path; audit the resampler.
- Keep the audio buffer alive until a final commits from *either* engine; on cloud failure re-run
  the same buffer locally rather than making the user re-record.
- **Gate:** measured WER beats the current streaming baseline on the Phase 1.5 corpus; release→text
  latency under 800 ms; full e2e matrix green.

### Phase 3 — Cost, hygiene, resilience
- Streamed-seconds meter + monthly accumulator + Settings display.
- `cloudMonthlyCapUsd` enforcement + local fallback + toasts.
- `cloudGateSilence` (RMS gate + pre-roll + trailing-silence-then-Finalize), shipped **off**,
  measured, then defaulted on if endpointing holds.
- Offline/no-key/cap → local fallback path with a clear toast.
- Corporate-network hardening: proxy agent from Electron's resolved proxy + optional custom CA
  (`ws` `agent:` / `ca:` options — Chromium's session proxy does not cover our Node socket).
- **Gate:** cost meter verified against a real vendor console for one session; airplane-mode drill.

### Phase 4 — Direct-vendor TTS + second STT (the latency upgrade)
Only worth doing if per-clause TTFB on OpenRouter's HTTP path measurably hurts. Measure first.
- Deepgram Aura-2 WS: `Speak`/`Flush`/`Clear`/`Close`, binary→base64 chunk mapping,
  `ttsCancel` → `Clear` (a real destructive abort, unlike an HTTP abort).
- Cartesia `context_id`/`continue` gapless clause streaming — the actual latency win, ~40 ms TTFB.
- AssemblyAI STT as the second streaming vendor.
- Prove the abstraction: adding these must require **no change to `voiceCloudEngine`'s public
  shape**. If Phase 4 forces a seam change, the seam was wrong.
- Verify barge-in end-to-end per vendor: duck ≤80 ms local, cancel sent, no residual audio, Jarvis
  turn cancelled (`jarvisSession.ts:324-336` confirm-gate carve-out must still hold).
- **Gate:** switching providers at runtime works without an app restart.

### Not in scope
Unified realtime speech-to-speech (§2.3). Google/Azure STT. Groq. Cloud wake-word. Shipping a
vendor key / any billing relay.

---

## 5. Test plan

Following the existing tiering (`vitest.config.ts:26-63`): `unit-node`, `unit-dom`,
`integration-node`, `integration-dom` by filename suffix.

- **Unit (`voiceCloudHost.test.ts`)** — pure functions over a `WebSocketLike` structural interface
  (exactly the `RecognizerLike`/`OfflineTtsLike` fake pattern at `voiceEngineHost.ts:96-113`):
  result→port mapping, partial dedupe, eos→Finalize→stopped drain, KeepAlive scheduling,
  backpressure drop, reconnect backoff, pre-roll replay ordering.
- **Unit (`voiceCloudEngine.test.ts`)** — handle lifecycle, failure escalation, key never logged.
- **Unit (`voiceConfig.test.ts` extension)** — repair of every new field, unknown-provider →
  default, legacy configs carrying the old `engine`/`cloudProvider` repaired forward.
- **Unit (`llmKeyStore.test.ts` extension)** — generic parameterization, two stores don't collide,
  `basic_text` refusal.
- **Integration (`voiceCloudHost.integration.test.ts`)** — real `ws` against a local fake vendor
  server (deterministic, no network). Not vendor-gated, so CI runs it.
- **Live check, gated** — `describe.runIf(!!process.env.CANVAS_VOICE_CLOUD_KEY)`, mirroring
  `voiceEngineHost.integration.test.ts:6-8`'s `CANVAS_VOICE_MODELS_ROOT` gate. Never runs in CI.
- **e2e** — extend `voiceEngineStub.ts` with a `cloud` flavor so `voice.e2e.ts` /
  `voiceComposer.e2e.ts` / `voiceCrashDrill.e2e.ts` can drive the cloud code path's *plumbing*
  without a socket. The crash drill matters most: cloud reconnect exhaustion must land on the same
  Restart UI the local decoder crash does.
- **Manual dev checks** (the class of bug that unit tests structurally cannot catch — same category
  as J2's `enableExternalBuffer` and the positional-`onProgress` empty-chunk bug): real-key STT
  accuracy + partial cadence; real-key TTS barge-in; airplane-mode fallback; a 30-minute idle
  session to confirm KeepAlive holds and no socket leaks.

---

## 6. Open decisions for you

1. **Confirm the reordering.** Phases now run OpenRouter TTS → Deepgram STT → rails → direct-vendor
   upgrade, because OpenRouter needs no new credential and hosts our own Kokoro voice. If the
   dictation win matters more to you than shipping cheap, swap Phases 1 and 2 — they are
   independent.
2. **BYO-key only, confirmed?** Ephemeral tokens are useless without a backend (§3.3). Alternative
   is standing up a token-minting relay — a real backend, real cost, real liability. Recommend
   BYO-key, with OpenRouter as the zero-new-key default so most users never hit the question.
3. **Deepgram-first, or AssemblyAI-first for STT?** Deepgram wins on endpointing controls and
   keyterms; AssemblyAI is ~3× cheaper per hour but bills wall-clock socket time. Recommend Deepgram.
4. **Is per-clause TTFB on OpenRouter's HTTP path acceptable?** This decides whether Phase 4 happens
   at all. Unanswerable on paper — measure in Phase 1 with real clause lengths.
5. **Ship silence-gating on or off by default in Phase 3?** It is the difference between "cheap"
   and "very cheap" but it interacts with provider endpointing. Recommend off → measure → on.

---

## 7. Pitfalls checklist (carry into review)

- [ ] API key never crosses into renderer; never in child env; never in a board doc; never logged.
- [ ] `getSelectedStorageBackend() === 'basic_text'` → refuse to persist (Linux tiling-WM users).
- [ ] `ws` in main/utility only — it throws in an Electron renderer.
- [ ] Chromium `session.setProxy()` does not cover our Node socket — set the proxy agent explicitly.
- [ ] `NODE_EXTRA_CA_CERTS` is ignored by Electron — inject corporate CA via `ws`'s `ca:` option.
- [ ] KeepAlive timer lives in the utilityProcess, not main (window-drag freezes main's timers).
- [ ] KeepAlive alone does not hold a Deepgram socket — real audio must flow too.
- [ ] `Finalize` before close, or the last utterance is lost.
- [ ] Reconnect must resume audio inside the vendor's 10 s grace or the new session dies too.
- [ ] AssemblyAI bills wall-clock socket time — close on eos, never idle-hold.
- [ ] `bufferedAmount` is the only backpressure signal; there is no `drain` event.
- [ ] Streaming pricing carries a large premium over batch — don't use streaming for non-interactive
      transcription if we ever add that.
- [ ] Cancel TTS *and* the upstream Jarvis LLM turn on barge-in — they bill separately.
- [ ] Chromium AEC does not cancel our own Web Audio TTS — 'half' duplex stays the cloud default.
- [ ] ElevenLabs trains by default below Enterprise — surface it if ever added.
- [ ] Don't build on the dead `engine`/`cloudProvider` placeholder — replace it.
- [ ] OpenRouter key resolves from the **existing LLM store**, never duplicated into `voice-keys.json`.
- [ ] OpenRouter PCM sample rate is probed and pinned per model — the chunk message must carry the
      true rate or playback pitches wrong.
- [ ] HTTP-abort barge-in needs an explicit `reader.cancel()` in the abort listener, or `read()` hangs.
- [ ] Don't quote OpenRouter dollar figures in the UI until the token-vs-character unit is resolved
      empirically (§2.3).

---

## 8. Sources

STT: [Deepgram streaming](https://developers.deepgram.com/reference/speech-to-text/listen-streaming) ·
[Deepgram KeepAlive](https://developers.deepgram.com/docs/audio-keep-alive) ·
[Deepgram Finalize](https://developers.deepgram.com/docs/finalize) ·
[Deepgram reconnect](https://developers.deepgram.com/docs/recovering-from-connection-errors-and-timeouts-when-live-streaming-audio) ·
[Deepgram privacy](https://developers.deepgram.com/trust-security/data-privacy-compliance) ·
[Deepgram pricing](https://deepgram.com/pricing) ·
[AssemblyAI streaming](https://www.assemblyai.com/docs/api-reference/streaming-api/streaming-api) ·
[AssemblyAI zero retention](https://support.assemblyai.com/articles/2240096256-does-assemblyai-offer-zero-data-retention) ·
[Speechmatics realtime WS](https://docs.speechmatics.com/api-ref/realtime-transcription-websocket) ·
[Google STT streaming (gRPC-only)](https://docs.cloud.google.com/speech-to-text/docs/streaming-recognize) ·
[Groq STT](https://console.groq.com/docs/speech-to-text)

OpenRouter (verified live 2026-07-21):
[TTS guide](https://openrouter.ai/docs/guides/overview/multimodal/tts) ·
[STT guide](https://openrouter.ai/docs/guides/overview/multimodal/stt) ·
[audio APIs announcement](https://openrouter.ai/blog/announcements/announcing-audio-apis/) ·
[TTS model collection](https://openrouter.ai/collections/text-to-speech-models) ·
[STT model collection](https://openrouter.ai/collections/speech-to-text-models)

TTS: [Deepgram Aura-2 WS](https://developers.deepgram.com/docs/tts-websocket-streaming) ·
[Cartesia TTS API](https://docs.cartesia.ai/api-reference/tts/tts) ·
[Cartesia pricing](https://www.cartesia.ai/pricing) ·
[ElevenLabs models](https://elevenlabs.io/docs/overview/models) ·
[ElevenLabs zero-retention](https://elevenlabs.io/docs/eleven-api/resources/zero-retention-mode) ·
[Google Chirp 3 streaming](https://docs.cloud.google.com/text-to-speech/docs/create-audio-text-streaming) ·
[Azure StopSpeakingAsync bug](https://github.com/Azure-Samples/cognitive-services-speech-sdk/issues/2264)

Realtime: [OpenAI Realtime](https://developers.openai.com/api/docs/guides/realtime) ·
[OpenAI realtime transcription](https://developers.openai.com/api/docs/guides/realtime-transcription) ·
[OpenAI pricing](https://developers.openai.com/api/docs/pricing) ·
[Gemini Live sessions](https://ai.google.dev/gemini-api/docs/live-session) ·
[Gemini ephemeral tokens](https://ai.google.dev/gemini-api/docs/live-api/ephemeral-tokens) ·
[Nova 2 Sonic](https://aws.amazon.com/blogs/aws/introducing-amazon-nova-2-sonic-next-generation-speech-to-speech-model-for-conversational-ai/) ·
[Claude Code voice dictation](https://code.claude.com/docs/en/voice-dictation)

Electron: [safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage) ·
[utilityProcess](https://www.electronjs.org/docs/latest/api/utility-process) ·
[MessagePorts](https://www.electronjs.org/docs/latest/tutorial/message-ports) ·
[ws in renderer](https://github.com/websockets/ws/issues/1459) ·
[setProxy + WebSocket](https://github.com/electron/electron/issues/34810) ·
[NODE_EXTRA_CA_CERTS](https://github.com/electron/electron/issues/41590) ·
[safeStorage Linux DE detection](https://github.com/electron/electron/issues/39789) ·
[main-process timer freeze](https://github.com/electron/electron/issues/11782) ·
[Chromium AEC + Web Audio](https://bugs.chromium.org/p/chromium/issues/detail?id=687574)

> Flagged as unverified by research: exact Deepgram streaming rate (list $0.0077/min vs a promo
> $0.0048/min), Speechmatics and ElevenLabs Scribe pricing (conflicting across sources), Azure
> per-hour rate (primary page fetch timed out), **OpenRouter's token-vs-character pricing unit and
> its PCM sample rate** (§2.3 — both resolvable with one metered probe request), **OpenRouter STT
> $/min** (token-priced with no published audio-seconds conversion). Confirm live before quoting
> any number to a user.
