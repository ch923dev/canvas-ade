# STT Accuracy — trading live partials for a batch pass

**Date:** 2026-07-21
**Status:** research + design, unapproved
**Companion to:** `PLAN.md` (this supersedes its §2.1 STT provider pick)

Premise change: we stop needing live streaming ASR. Push-to-talk — hold a key, speak, release,
transcribe the whole utterance. That unlocks **batch models**, a different accuracy tier, and it
unlocks four accuracy techniques that streaming structurally cannot use.

---

## 1. The number that justifies the whole change

**Deepgram publishes both figures for the same model family:**

| Nova-3 | median WER |
|---|---|
| streaming | 6.84% |
| **pre-recorded (batch)** | **5.26%** |

~23% relative error reduction, same vendor, same model, **just from giving the model the whole
utterance instead of a look-ahead window**. Offline models see full future context; streaming ones
decode left-to-right under a latency budget. That is the entire trade you're proposing, priced.

Batch is also **cheaper** almost everywhere (Google batch $0.004/min vs $0.016 streaming;
AssemblyAI batch ~$0.21/hr vs ~$0.45/hr streaming). Deepgram is the exception — its *pre-recorded*
rate is higher than streaming ($0.0077 vs $0.0048/min), which is worth knowing before assuming
batch is universally cheaper.

The academic backing for two-pass is solid: Sainath et al. (Interspeech 2019, Google) get
**17–22% relative WER reduction** from a streaming RNN-T first pass rescored by an attention
decoder at utterance end. U2/U2++ generalizes it. This is a known-good architecture, not a hunch.

---

## 2. Batch provider landscape

Independent cross-vendor leaderboard (Artificial Analysis AA-WER — **general-domain audio, not
code**):

| Model | AA-WER | Speed | Price/min | Biasing param & limit |
|---|---|---|---|---|
| **ElevenLabs Scribe v2** | **2.2%** | 31.7× | ~$0.0037 | keyterms, ~100 phrases |
| Mistral Voxtral Small | 2.8% | 53.2× | ~$0.004 | context biasing, ~100 phrases |
| Google Gemini 2.5 Pro | 2.9% | 13.4× | ~$0.0114 | — |
| **AssemblyAI Universal-3 Pro** | **3.1%** | 108.8× | ~$0.0035 | `keyterms_prompt`, **1,000 phrases** (≤6 words each) |
| OpenAI gpt-4o-transcribe | 4.0% | 32.3× | $0.006 | `prompt` |
| Speechmatics Enhanced | 4.0% | 43.2× | ~$0.0125 | `additional_vocab`, 1,000 phrases |
| **Groq whisper-large-v3-turbo** | 4.6% | **102.7×** | **$0.00067** | `prompt`, 224 tokens |
| Deepgram Nova-3 batch | 5.2% | 329.8× | $0.0077 | `keyterm`, ~500 tokens (20–50 recommended) |

**Groq is the outlier worth staring at.** $0.04/hr — 11× cheaper than Deepgram *streaming*, and the
only provider with credibly measured sub-second latency (a 30s clip measured end-to-end at 0.8s;
a 10s clip extrapolates to ~0.3–0.5s). Its 10s minimum billable duration is financially irrelevant
at these rates. 4.6% WER is mid-pack, but see §3 — biasing moves the needle more than the base
model does.

### The finding that governs everything below

> **No benchmark, from any vendor or independent lab, measures WER on programming/code
> vocabulary.** Function names, CLI flags, camelCase, file extensions, library names — nothing.
> Every number above comes from LibriSpeech / CommonVoice / FLEURS / earnings calls / call-center
> audio.

This is a confirmed gap, not a search failure. Consequences:

1. The leaderboard is a **proxy**, and possibly a bad one for us.
2. Whoever solves code-speech accuracy does it with **biasing and post-processing**, not by picking
   a better general model.
3. **We must run our own eval.** ~50–100 recorded real utterances with our own repo's symbol names,
   scored against 2–3 shortlisted providers. Nothing else settles it.

Indirect evidence that generic ASR is genuinely bad here: Aqua Voice trained a custom model
("Avalon") specifically on prompts/code/CLI/IDE speech, and its own benchmark claims **97.4%
accuracy vs Whisper Large v3 at 65.1%, ElevenLabs Scribe 78.8%, NVIDIA Canary 51.5%** on AI/coding
jargon. Vendor-built benchmark, treat the absolute numbers as marketing — but the *spread* is too
large to be noise. Serenade likewise trained a custom model on programming syntax rather than
wrapping Whisper. Two independent products concluded generic ASR does not handle code speech.

---

## 3. The four techniques batch unlocks — ranked by bang-for-buck

### 3.1 Keyterm biasing seeded from the user's own repo ⭐ the differentiated move

Every batch API takes a domain vocabulary. Documented gains are the largest of any technique here:

| API | Param | Limit |
|---|---|---|
| AssemblyAI | `keyterms_prompt` | 1,000 phrases, ≤6 words each |
| Speechmatics | `additional_vocab` | 1,000 phrases, ≤6 words |
| Google | phrase sets + `boost` (0–20) | 1,000 phrases |
| Deepgram Nova-3 | `keyterm` (repeated query param) | ~500 tokens; **docs recommend 20–50 terms** |
| ElevenLabs Scribe v2 | keyterms | ~100 phrases |
| OpenAI / Groq (Whisper) | `prompt` | **224 tokens, last-224 only** |
| sherpa-onnx (local) | hotwords file, `word:score` | transducer + `modified_beam_search` only |

Documented effects: Deepgram claims "up to 90%" keyword recall on boosted terms and cites a
customer seeing **625% improvement in keyterm recognition** (anecdotal, veterinary). Google's own
example takes WER 20–30% → 10–20% via phrase sets + boost. An arXiv contextual-biasing paper
reports **up to 80 points absolute** entity-recall gain on hotword subsets.

**Nobody else can seed this list as well as we can.** A generic dictation app has to ask the user to
type a glossary. We are sitting inside their repository. Tiered sources, cheapest first:

1. **Static dev-jargon list** (~40 terms): `npm`, `pnpm`, `async`, `await`, `kubectl`, `TypeScript`,
   `React`, `git rebase`, … ships with the app, zero setup.
2. **Project-derived**: filenames and directory names from the open project's file tree, plus
   identifiers from the currently-focused editor file. Already in the renderer's reach.
3. **CodeGraph symbols** — for repos that have a `.codegraph/` index, the symbol graph *is* a ranked
   list of function/class/file names. Opt-in per repo (never index on the user's behalf), so treat
   as an enhancement, not a dependency.

**Hard constraint: keep the list SHORT.** This is the trap. The OpenAI cookbook ran the experiment —
adding 30+ product names to a Whisper prompt **failed to improve accuracy and produced worse output
than a short list**. superwhisper's docs independently warn that overloading the vocabulary list
"can confuse the AI transcription model." Two vendors, same lesson. So:

- Cap at **~30 terms** regardless of the API's stated limit.
- **Rank by relevance to the current context** (symbols in the focused file first, then open boards'
  files, then project-wide, then the static list) and take the top N.
- Never dump the whole symbol graph. That is the documented failure mode.

Effort: one API field + a ranking function. Highest ratio of gain to work in this document.

### 3.2 Deterministic post-processing for code formatting

"dot t s" → `.ts`, "dash dash verbose" → `--verbose`, "camel case user id" → `userId`.

**No statistical technique for this exists.** Searched; it's a genuine gap in the literature. The
only two shipped approaches:

- **Talon**: spoken formatter commands — say "camel", "snake", "dunder", "kebab", "dotted" before
  the words, applied deterministically. Sidesteps ASR accuracy entirely by making formatting a
  command, not a transcription problem.
- **superwhisper "Replacements"**: an exact-match substitution layer, which its docs explicitly
  recommend **over** stuffing terms into the AI vocabulary list, precisely because replacements are
  deterministic and not model-dependent.

Take superwhisper's lesson: a regex/dictionary layer for file extensions, CLI flag patterns, and
casing conversions. 100% deterministic, zero latency, zero cost, user-editable. Optionally add
Talon-style spoken formatters later for power users.

### 3.3 LLM post-correction (GER) — real, but needs a guardrail

Generative Error Correction on the GenSEC benchmark: Whisper-1.5B baseline **11.82% WER →
8.33%** with LLaMA2-7B correction (~30% relative), close to the N-best oracle floor of 9.32%.

And directly on our problem: in the same OpenAI cookbook experiment where a long prompt glossary
**failed**, GPT-4 post-processing **correctly fixed 12/12 misspelled terms**. That is the clean
division of labour:

> **Short keyterm list → biases the decoder. Full glossary → goes to the LLM afterwards.**

We already have the LLM lane (`llmService.ts`, OpenRouter key, cheap models). Marginal cost is
near-zero on a 15-word transcript.

**The failure mode is real**: GER hallucinates plausible-sounding wrong "corrections" that replace
true text. Published mitigation is a 3-stage detect → generate → verify pipeline. Our cheap version:
constrain the prompt to *only* substitute terms present in the supplied glossary, forbid rewriting,
and reject any output whose length or edit distance from the raw transcript exceeds a threshold.
Ship it **off by default** with a visible toggle, since a silent wrong correction is worse than a
visible ASR error.

### 3.4 Audio hygiene — a floor-protector, not a gain

Cheap, and mostly about *not* hurting ourselves:

- **Do not stack noise suppression.** A 2026 arXiv paper ("When Denoising Hinders") found
  audio-separation preprocessing *increased* WER for zero-shot Whisper on both test sets. Deepgram's
  own guidance says send near-raw audio; cascaded browser NS erases sibilants and adds musical-noise
  artifacts the ASR then has to decode. Our `getUserMedia` constraints should turn aggressive
  suppression **off** for the batch path.
- **16 kHz is correct.** These models are trained at 16k and resample internally; sending 48k gains
  nothing. The only real risk is a naive downsample (decimation → aliasing) instead of band-limited
  resampling — and our capture worklet already does linear-interpolation resampling, worth an audit.
- **Pre-roll 200–300 ms.** Onset clipping loses the first phonemes and, per a sherpa-onnx issue, can
  *trigger hallucination*, not just drop a word. Push-to-talk makes this avoidable by design: keep a
  ring buffer running and start the utterance ~250 ms *before* the keydown registers.

### 3.5 Not worth it — multi-engine voting

ROVER-style voting across 2+ engines gives real but modest gains (~1–9 points absolute in cited
studies) at 2–3× inference cost plus waiting on the slowest engine. Wrong shape for an interactive
push-to-talk budget. Skip.

---

## 4. Local path — if we'd rather get accurate without the cloud

Push-to-talk also unlocks better **local** models, because offline transducers beat their streaming
counterparts for the same reason cloud batch beats cloud streaming.

| Option | int8 size | English WER | CPU speed | Local biasing? |
|---|---|---|---|---|
| **Offline Zipformer transducer** (same family we ship) | tens of MB | not published (gap) | same order as current | ✅ hotwords + `modified_beam_search` |
| **Parakeet-TDT-0.6B-v2** | **~1.3 GB** (622 MB encoder) | **6.05–6.32%** (near-SOTA) | official ARM RTF 0.088–0.22; third-party x86 RTF 0.033–0.054 — **conflicting** | ✅ (sherpa PR #3077, merged Feb 2026) |
| Moonshine base-en | 58 MB | 10.07% | 5–15× faster than Whisper | ❌ |
| Whisper small.en | ~300 MB | — | ~7–8× realtime on i7 (unverified) | ❌ |
| Whisper large-v3 | 1.7 GB | best | **RTF 8.16 — a 10s clip takes ~80s** | ❌ |

Three findings that decide this:

1. **Only transducers support local biasing.** sherpa-onnx hotwords need `modified_beam_search` on a
   transducer. Whisper, Moonshine, SenseVoice, Paraformer have **no local biasing path at all** —
   and sherpa's Whisper has no `initial_prompt` support either (open issue #2295, unanswered). For a
   code-jargon use case that's disqualifying.
2. **Whisper large is ruled out on CPU.** RTF 8.16 at 2 threads, per sherpa's own benchmark. int8
   barely helps (7.55).
3. **sherpa's offline Whisper has an open accuracy bug** — issue #2900 reports CER 0.81 vs
   faster-whisper's 0.25 on identical input, unresolved. Test before trusting.

**Local recommendation:** switch the existing Zipformer from its streaming to its **offline**
counterpart, turn on `modified_beam_search`, and feed it the same keyterm list from §3.1. Same
family, same size class, and it is the only local option that can take our repo symbols. Parakeet-TDT
is the "max accuracy" tier if a ~1.3 GB download is acceptable — but its CPU speed claims range from
"prohibitively slow" to "30× realtime" across sources, so **benchmark on the target machine before
shipping it**. Always int8 (<1% WER cost, ~75% memory saving).

---

## 5. Recommended architecture — two-pass with a ghost draft

This is the design the research supports, and it is **ahead of shipped market practice**. Products
that show live partials (Claude Code, Aqua streaming mode) are single-engine cloud streaming.
Products that do two models (Ghost Pepper, VoiceInk) run both *sequentially after* release, showing
nothing while you speak — and the top Hacker News complaint about exactly that is a user saying
live text "helps my simple brain structure what I'm saying." We can have both.

```
keydown ──▶ ring buffer already running (250ms pre-roll captured)
             │
             ├─▶ local streaming engine ──▶ GHOST DRAFT (dimmed, provisional)
             │        (free, instant, private — the "it's working" signal)
             │
             └─▶ raw PCM accumulates in a retained buffer
keyup   ──▶ lock the draft (no more live edits)
             │
             ├─▶ build keyterms: focused-file symbols → project → static list, top ~30
             ├─▶ batch pass (cloud OR local offline) with keyterms
             ├─▶ deterministic replacement layer (.ts, --flag, casing)
             ├─▶ [optional, off by default] constrained LLM correction w/ full glossary
             └─▶ atomic swap: replace the whole draft span, un-dim
```

Design rules, each sourced:

- **Ghost draft = our existing local streaming engine.** No new component; it's already built and
  already free. Dimmed styling matches Claude Code's own convention (transcribes live, dimmed in the
  prompt, un-dims on release).
- **Lock the input on release.** assistant-ui's dictation contract uses
  `disableInputDuringDictation` precisely to avoid the user-edits-while-final-lands race. Simplest
  correct answer; don't attempt a live merge.
- **Atomic replace, not word-diff.** Deepgram's interim/final guidance: swap on a clean transition,
  never let new data overwrite a finalized span. If the user *did* edit during the gap, prefer
  diff-based reconciliation only within edited spans, else full replace.
- **Never blank the draft.** VUI guidance: silence past ~3s reads as "did it crash?". Keep the dim
  draft on screen through the finalizing state rather than clearing to empty.
- **Latency budget: 500–800 ms** from release to final reads as responsive; >2s reads as broken
  (converged across several sources). Groq turbo clears this with room; a local Parakeet pass might
  not — measure.
- **Caps, borrowed from Claude Code:** auto-stop at 15s silence / 2 min total. Distinguish a real
  hold from a tap via key-repeat with a short warmup. Require ≥3 words before any auto-send.
- **Ship a toggle/tap mode too.** Sustained key-hold "recreates the same sustained tendon load" as
  typing — a real accessibility failure mode for RSI users. Claude Code ships tap mode for this.
- **Keep the audio buffer alive until a final commits from *either* engine.** On cloud
  failure/timeout, silently re-run the *same retained buffer* through the local batch model rather
  than making the user re-record. Note: **no shipped product publicly documents this fallback**, so
  it's our own design, not a copied pattern.

---

## 6. Provider recommendation for the batch pass

### 6.0 First measured run — 2026-07-23 (own voice, 30 utterances, `scripts/stt-eval`)

The harness is built (`scripts/stt-eval/`, `feat/stt-eval`). First corpus recorded: **30 read
utterances, 199.9 s, 16 kHz mono, one speaker/mic/room** — read speech, so absolute WER is
optimistic; the signal is the *relative* picture and the *failure-mode split*. Only
`OPENROUTER_API_KEY` was available, so **only OpenRouter ran** (every other engine SKIPPED for a
missing key — Groq/Deepgram/AssemblyAI/OpenAI/local are still unmeasured).

| Engine | Bias | WER | Keyterm exact | Keyterm loose | Recoverable gap | Median |
|---|---|---:|---:|---:|---:|---:|
| OpenRouter `openai/whisper-large-v3` | unbiased | 35.3% | 27.4% | 64.5% | 37.1 pt | 698 ms |
| OpenRouter `openai/whisper-large-v3` | biased | **35.3%** | **27.4%** | **64.5%** | 37.1 pt | 725 ms |

Three findings, one of them answers an open question outright:

1. **OpenRouter's `/audio/transcriptions` ignores keyterm biasing — CONFIRMED, not inferred.**
   The biased and unbiased columns are **byte-identical** (same WER, same exact/loose, term-for-term).
   Passing a `prompt`/keyterm list changes nothing. That closes open-question §8.4 below and
   **disqualifies OpenRouter as the accuracy engine**: biasing is the single biggest lever we have
   (§3.1) and this endpoint has no seam for it. It also only offers whisper-lineage models (no
   nova-3 / Universal-class), so there is no better model to select our way out of it either.

2. **The 35.3% WER is dominated by identifier *formatting*, not misrecognition.** Plain-English
   utterances scored ~0% (e.g. "Push with no verify to skip the pre-push end-to-end gate." came back
   verbatim, hyphens and all). The WER is concentrated entirely in technical tokens, and it splits cleanly:
   - **Formatting-recoverable (~half the terms): heard right, spelled wrong.** `utilityProcess`
     → "utility process", `contextIsolation` → "context isolation", `getUserMedia` → "get user media",
     `add_card`/`move_card`/`update_card`, `electron-builder`, `node-pty`, `schemaVersion`, `userData`,
     `safeStorage` — all **0% exact but 100% loose**. This is exactly the class §3.2's deterministic
     replacement layer recovers. The **37-point exact→loose gap is the prize**, and it is
     provider-independent and client-side.
   - **Genuinely misheard (~35% of terms): 0% loose — the phonemes were lost.** `voiceIpc` → "boys of
     easy", `MessagePort` → "message board", `useVoiceCapture` → "use of voice capture", `llmKeyStore`,
     `createTtsRunner`, `ipcRenderer`, `sherpa-onnx`, `Groq`, `AssemblyAI`, `invoke`, `lint`, `vitest`,
     `typecheck`, `zustand`. These need **biasing or LLM post-correction** — and on OpenRouter biasing
     is unavailable, so on OpenRouter they are simply lost.

3. **This validates the two-pass plan (§5) and re-orders the roadmap.** The cheapest, highest-ROI,
   provider-independent win is the deterministic formatting layer (§3.2): on this run it would lift
   keyterm-exact from 27% toward the 64% loose ceiling for **zero** provider dependence. The
   genuinely-misheard bucket is what the provider choice actually turns on — which makes measuring the
   **biasing-capable** providers (Groq `prompt`, Deepgram `keyterm`, AssemblyAI `keyterms_prompt`) the
   next real experiment. Groq is free-tier → the cheapest next measurement.

**Net: OpenRouter is rejected for STT** (its TTS/Kokoro role in PLAN.md Phase 1 is untouched — that
finding stands). The provider decision below is **still a recommendation, not yet a measurement** —
the biasing-capable engines remain unrun for lack of keys.

### 6.1 Recommendation (to verify once keys exist)

Given the code-vocabulary benchmark gap, pick on **biasing headroom + latency + cost**, then verify
with our own eval:

- **Default: Groq `whisper-large-v3-turbo`.** $0.00067/min (effectively free), the only credibly
  measured sub-second latency, 4.6% AA-WER. Its `prompt` is capped at 224 tokens — which happens to
  align with the "keep it to ~30 terms" constraint anyway. Cheap enough that cost stops being a
  design consideration entirely.
- **Accuracy tier: AssemblyAI Universal-3 Pro.** 3.1% AA-WER and by far the largest biasing headroom
  (`keyterms_prompt`, 1,000 phrases) — the best home for a large repo symbol list if the eval shows
  30 terms isn't enough. ~$0.0035/min, no minimum-duration penalty.
- **Max raw accuracy: ElevenLabs Scribe v2** (2.2% AA-WER, best measured) — but only ~100 keyterms
  and ElevenLabs trains on non-Enterprise data by default. Third choice.
- **Local: offline Zipformer + hotwords**, per §4.
- **Deepgram**: still the right call *if* we ever want streaming again, but for batch it's both the
  most expensive per minute and the lowest-accuracy of the shortlist. Its keyterm docs are the best
  written, which is worth something.

**Format note:** only Deepgram clearly documents raw headerless PCM (`encoding=linear16`). Groq,
OpenAI, AssemblyAI, ElevenLabs, Speechmatics all list container formats only — so the batch path
needs a **WAV header wrapper** around our PCM buffer. Trivial (44 bytes), but it must exist.

---

## 7. What this changes in PLAN.md

- **§2.1 STT pick is superseded.** Deepgram-streaming-first → Groq-batch-first with AssemblyAI as
  the accuracy tier. Streaming Deepgram becomes optional, not the default.
- **OpenRouter STT: checked and rejected (2026-07-23, §6.0).** Batch-only was the right *shape* under
  push-to-talk, but its `/audio/transcriptions` endpoint **ignores keyterm biasing** (biased ≡ unbiased,
  measured) and only serves whisper-lineage models. Without a biasing seam it can't touch the
  genuinely-misheard bucket, so it is out as the STT accuracy engine. (Its TTS role is unaffected.)
- **New config surface**: `sttMode: 'streaming' | 'pushToTalk'`, keyterm source toggles, replacement
  rules, LLM-correction toggle (default off).
- **Cost rails get much less urgent.** At Groq's $0.04/hr, the monthly-cap machinery in PLAN.md
  Phase 3 is close to pointless for STT. Keep it for TTS.
- **New phase, ahead of provider work: build the eval harness.** ~50–100 recorded technical
  utterances + a WER scorer. Without it every provider choice here is a guess dressed as a decision.

---

## 8. Open questions

1. **Push-to-talk instead of, or alongside, streaming?** The two-pass design keeps streaming as the
   ghost draft, so "instead of" isn't required — but shipping only push-to-talk is simpler and
   matches Claude Code / superwhisper / VoiceInk convention.
2. **Does the eval come first?** ✅ RESOLVED — built and run (§6.0). First run measured OpenRouter and
   killed it as an STT candidate. Still owed: Groq/Deepgram/AssemblyAI/local runs (need keys/model).
3. **How far do we take repo-derived keyterms?** Static list only (ships tomorrow) vs file-tree
   derived vs CodeGraph symbols (best, but opt-in per repo). *Sharpened by §6.0:* biasing only helps
   the genuinely-misheard bucket; the formatting bucket is fixed by §3.2 regardless of keyterm source.
4. **LLM post-correction — ship at all?** Real ~30% relative gain, real hallucination risk. Recommend
   building it behind an off-by-default toggle so the eval can measure it on our own audio.
5. ~~Does OpenRouter's transcription endpoint expose a biasing param?~~ ✅ RESOLVED 2026-07-23 — **no.**
   Biased and unbiased runs came back byte-identical (§6.0). OpenRouter is out for STT accuracy.

---

## 9. Sources

Batch accuracy / pricing:
[Artificial Analysis STT leaderboard](https://artificialanalysis.ai/speech-to-text) ·
[Deepgram Nova-3 batch vs streaming WER](https://deepgram.com/learn/introducing-nova-3-speech-to-text-api) ·
[Deepgram pricing](https://deepgram.com/pricing) ·
[Groq STT](https://console.groq.com/docs/speech-to-text) ·
[Groq whisper-turbo](https://groq.com/blog/whisper-large-v3-turbo-now-available-on-groq-combining-speed-quality-for-speech-recognition) ·
[AssemblyAI pricing](https://www.assemblyai.com/pricing) ·
[ElevenLabs Scribe v2](https://elevenlabs.io/blog/introducing-scribe-v2) ·
[Mistral Voxtral Transcribe 2](https://mistral.ai/news/voxtral-transcribe-2)

Biasing:
[Deepgram keyterm](https://developers.deepgram.com/docs/keyterm) ·
[AssemblyAI keyterms_prompt](https://docs.assemblyai.com/guides/boosting-accuracy-for-keywords-or-phrases) ·
[Google speech adaptation](https://docs.cloud.google.com/speech-to-text/docs/v1/adaptation) ·
[Speechmatics custom dictionary](https://docs.speechmatics.com/speech-to-text/features/custom-dictionary) ·
[OpenAI Whisper prompting guide](https://developers.openai.com/cookbook/examples/whisper_prompting_guide) ·
[OpenAI: prompt vs GPT-4 post-correction](https://developers.openai.com/cookbook/examples/whisper_correct_misspelling) ·
[sherpa-onnx hotwords](https://k2-fsa.github.io/sherpa/onnx/hotwords/index.html) ·
[contextual biasing for Whisper (arXiv)](https://arxiv.org/html/2410.18363v1)

Post-correction:
[GenSEC / GER benchmark (arXiv)](https://arxiv.org/html/2409.09785v3) ·
[GER hallucination mitigation (arXiv)](https://arxiv.org/pdf/2505.24347)

Two-pass + UX:
[Sainath et al., Two-Pass End-to-End ASR](https://arxiv.org/abs/1908.10992) ·
[U2/U2++ unified streaming/non-streaming](https://arxiv.org/pdf/2012.05481) ·
[Deepgram interim results guidance](https://developers.deepgram.com/docs/using-interim-results) ·
[Claude Code voice dictation](https://code.claude.com/docs/en/voice-dictation) ·
[assistant-ui dictation contract](https://www.assistant-ui.com/docs/guides/dictation) ·
[Ghost Pepper HN thread (user reactions)](https://news.ycombinator.com/item?id=47666024)

Local models:
[sherpa-onnx pretrained models](https://k2-fsa.github.io/sherpa/onnx/pretrained_models/index.html) ·
[sherpa-onnx NeMo/Parakeet transducers](https://k2-fsa.github.io/sherpa/onnx/pretrained_models/offline-transducer/nemo-transducer-models.html) ·
[Whisper large-v3 CPU RTF](https://k2-fsa.github.io/sherpa/onnx/pretrained_models/whisper/large-v3.html) ·
[Moonshine in sherpa-onnx](https://k2-fsa.github.io/sherpa/onnx/moonshine/index.html) ·
[Parakeet hotwords PR #3077](https://github.com/k2-fsa/sherpa-onnx/pull/3077) ·
[sherpa Whisper accuracy bug #2900](https://github.com/k2-fsa/sherpa-onnx/issues/2900)

Audio hygiene / prior art:
[When Denoising Hinders (arXiv)](https://arxiv.org/pdf/2603.04710) ·
[Deepgram noise-robust ASR](https://deepgram.com/learn/noise-robust-speech-recognition-methods-best-practices) ·
[Talon formatters](https://talon.wiki/Voice%20Coding/formatters/) ·
[superwhisper vocabulary guidance](https://superwhisper.com/docs/get-started/interface-vocabulary) ·
[Aqua Voice Avalon](https://aquavoice.com/blog/introducing-avalon)

> **Unverified / flagged:** no code-vocabulary WER benchmark exists anywhere (confirmed gap).
> No provider publishes a directly measured 10s-clip latency — all such figures are extrapolated.
> Parakeet-TDT CPU speed claims conflict across sources by ~10×. Aqua's 97.4%-vs-65.1% comparison is
> a vendor-built benchmark. Speechmatics and ElevenLabs batch pricing conflict across sources.
