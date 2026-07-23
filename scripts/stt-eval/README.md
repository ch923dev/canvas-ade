# STT eval harness

Measures **word error rate and keyterm recall on our own audio**, so the batch-STT
provider choice is a measurement instead of a guess.

Design + findings: `docs/research/2026-07-21-cloud-voice-providers/STT-ACCURACY.md`.

## Why this exists

Research (July 2026) turned up a confirmed gap: **no benchmark, from any vendor or
independent lab, measures WER on programming vocabulary.** Function names, CLI flags,
camelCase, file extensions — nothing. Every public number (ElevenLabs Scribe 2.2%,
AssemblyAI 3.1%, Groq turbo 4.6%) comes from LibriSpeech / earnings calls / call-center
audio.

So a leaderboard is a *proxy*, and possibly a bad one for a coding tool. This harness
replaces the proxy with a measurement on speech that looks like ours.

It also checks the number the whole push-to-talk plan rests on: Deepgram publishes
Nova-3 at **6.84% WER streaming vs 5.26% pre-recorded**, ~23% relative gain from the same
model just by handing it the whole utterance. Its batch endpoint is wired here as a
control so we can see that reproduce on our audio before betting the architecture on it.

## Two metrics, and why the second one matters more

| Metric | What it answers |
|---|---|
| **WER** | Standard Levenshtein over normalised tokens. Formatting is normalised *away* on purpose, so this measures recognition, not punctuation style. |
| **Keyterm exact** | Did `useVoiceCapture` come back verbatim, ready to paste? |
| **Keyterm loose** | Did it come back as "use voice capture" — right phonemes, wrong formatting? |

The **exact→loose gap** is the actionable number: it is exactly the error class a
deterministic replacement layer can fix. An engine with low exact but high loose recall is
one post-processing pass from being good. One with low *loose* recall genuinely did not
hear the word, and no amount of post-processing saves it.

## Usage

```bash
pnpm stt:record      # http://127.0.0.1:8099 — hold SPACE, read the prompt, release
pnpm stt:eval        # every configured engine, biased + unbiased
```

```bash
pnpm stt:eval -- --engines groq,local     # subset
pnpm stt:eval -- --only biased            # skip the control condition
pnpm stt:eval -- --bias-cap 50            # test whether a longer list helps or hurts
pnpm stt:eval -- --help
```

Results land in `results/<timestamp>.{json,md}`. The markdown carries a ranked table plus
a per-term breakdown that labels each term *fine* / *formatting — fixable with a
replacement rule* / *genuinely misheard*.

## Credentials

Each engine reads one environment variable and is **skipped with a printed reason** if it
is absent — a missing column in the table is always explainable.

| Engine | Variable | Biasing |
|---|---|---|
| `local` | `STT_EVAL_LOCAL_MODEL` (sherpa offline transducer model dir) | hotwords file, best-effort |
| `groq` | `GROQ_API_KEY` | `prompt` (224 tokens) |
| `openrouter` | `OPENROUTER_API_KEY` | `prompt` — **unverified, may be ignored** |
| `assemblyai` | `ASSEMBLYAI_API_KEY` | `keyterms_prompt` (1000 phrases) |
| `openai` | `OPENAI_API_KEY` | `prompt` |
| `deepgram` | `DEEPGRAM_API_KEY` | `keyterm` (control engine) |

Model ids are overridable — `STT_EVAL_GROQ_MODEL`, `STT_EVAL_ASSEMBLYAI_MODEL`, etc. — so
a vendor rename needs no code change.

## The rule that keeps the numbers honest

Per-utterance `keyterms` in the manifest exist **to score recall**. They are never fed to
the engine as that utterance's bias list — in production you cannot know which identifiers
someone is about to say, so injecting exactly those terms would measure a capability we
will never have, and every provider would look artificially good.

The biased condition therefore uses **one run-wide list**: the capped, frequency-ordered
union of the corpus's terms. That is the realistic analogue of "a context-ranked list of
symbols from the open project".

The cap defaults to **30 and is deliberately low.** The OpenAI cookbook measured a 30+
term glossary making accuracy *worse* than a short one, and superwhisper's docs warn
independently that overloading the vocabulary list confuses the model. Raising it is a
thing to **measure** (`--bias-cap`), not to assume.

## Known limitations — read before quoting a number

- **Read speech, not spontaneous dictation.** Prompts are read aloud, so absolute WER will
  be optimistic versus real use (no false starts, no mid-sentence rethinking). The
  **relative ranking between engines** is the signal; the absolute figure is a floor.
- **One speaker, one microphone, one room.** Nothing here says anything about accents,
  noisy environments, or other hardware.
- **The corpus is small.** 30 utterances is enough to separate engines that differ a lot
  and nowhere near enough to resolve a 0.5-point WER difference. Treat close results as
  ties.
- **Engine errors score as total misses**, not as dropped rows — an engine that fails on 3
  of 30 clips must not out-rank one that answered all 30.
- **Latency is median, and includes network.** It is a usability signal, not a benchmark
  of the vendor's inference speed.

## Files

```
wer.mjs        normaliser, Levenshtein alignment, WER, keyterm recall, aggregation  (pure)
wav.mjs        44-byte PCM WAV encode/decode — most vendors reject headerless PCM    (pure)
corpus.mjs     manifest loading + the bias-list construction rule                    (fs)
report.mjs     markdown rendering + ranking                                          (pure)
run.mjs        the CLI: fan corpus x engines x conditions, score, write results
record.mjs     local recorder server (127.0.0.1 only)
recorder.html  the recording page — AudioContext at 16 kHz, hold-to-talk
engines/       one adapter per vendor behind a single interface
corpus/        prompts.json (tracked) + recorded wavs and manifest (gitignored)
results/       run output (gitignored)
```

`corpus/*.wav` and `results/` are gitignored: the recordings are a maintainer's own voice
and the results carry raw transcripts. `prompts.json` **is** tracked, so anyone can
re-record the same corpus locally.

## Scope

This is a `scripts/` harness. Nothing here ships in the Electron bundle — no `src/`
changes, no schema bump, no UI. Its pure modules are unit-tested under `unit-node`
alongside `scripts/e2e-scope.test.ts`.
