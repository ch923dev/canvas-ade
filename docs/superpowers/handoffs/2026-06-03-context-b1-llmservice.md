# Handoff — M-brain T-B1 (provider-agnostic LLM service)

**Date:** 2026-06-03 · **Branch:** `feat/context-b1-llmservice` (off `feat/context`) · **Status:** DONE, gate + e2e green, ready to squash-merge.
**Plan:** `docs/superpowers/plans/2026-06-03-context-b1-llmservice.md` · **Design:** spec §5.2 `docs/superpowers/specs/2026-06-03-desktop-context-memory-design.md`.

## What shipped

MAIN's provider-agnostic LLM brain — the engine + its IPC surface. `summarize(input) → text` behind a small `Provider` interface, reachable from the renderer over a guarded `llm:summarize` / `llm:status` bridge, degrading gracefully to a typed no-provider result when no key is configured. **No memory loop** (M-memory), **no key UX** (T-B2), **no budget/ADR** (T-B3) — those are deferred, by design.

### Files
- **`src/main/llmConfig.ts`** (+test) — provider/model config in `userData/llm-config.json` (atomic write, mirrors `recentProjects.ts`). Persists **only** `{provider, model, baseUrl?}` — **never** a key. `readLlmConfig` repairs unknown/blank provider → `openrouter` default; tolerates malformed JSON. `DEFAULT_MODELS` (cheap/fast tier) is the single source of truth — `PROVIDERS` is derived from it.
- **`src/main/llmService.ts`** (+test) — the engine:
  - `buildRequest(provider, config, key, input) → {url,headers,body}` + `parseResponse(provider, json) → string` (pure, per provider).
  - `getProvider(config, deps) → Provider | null` (factory; null = no-provider).
  - `runSummarize(config, input, deps) → SummarizeResult` (orchestrator; **never throws**).
  - `isForeignSender` + `registerLlmHandlers(ipcMain, getWin, userDataDir, injectedDeps?)` (IPC) + exported `defaultDeps()`.
- **`src/preload/index.ts`** — `window.api.llm.summarize(input)` / `window.api.llm.status()` bridge (preload-local types mirror main).
- **`src/main/index.ts`** — `registerLlmHandlers(...)` after `registerProjectHandlers`; env-gated dev ping (below).
- **`src/main/e2e/probes/context.ts`** + `e2e/index.ts` — `context-brain` probe (mock-provider IPC round-trip), last in the PLAYLIST.

## The Provider interface (the contract)

```ts
interface SummarizeInput { system?: string; text: string }
interface Provider { summarize(input: SummarizeInput): Promise<string> }   // throws on transport/HTTP error

type SummarizeResult =                         // crosses IPC; the "typed NoProvider"
  | { ok: true; text: string }
  | { ok: false; reason: 'no-provider' }
  | { ok: false; reason: 'provider-error'; message: string }

interface LlmStatus { hasProvider: boolean; provider: ProviderName; model: string }   // no key material
type ProviderName = 'openrouter' | 'openai' | 'anthropic' | 'local'
```

`runSummarize` is the only thing callers (and the IPC handler / dev ping) use — it maps every failure to a typed result and never rejects, so the app never blocks on the brain (falls back to Tier-1).

## Per-provider HTTP shape (one shape per provider)

| Provider | URL | Auth header | Body | Parse |
|---|---|---|---|---|
| openrouter (default) | `https://openrouter.ai/api/v1/chat/completions` | `Authorization: Bearer <key>` | OpenAI chat `{model, messages:[system?, user]}` | `choices[0].message.content` |
| openai | `https://api.openai.com/v1/chat/completions` | `Authorization: Bearer <key>` | same | same |
| local | `<config.baseUrl>/chat/completions` (baseUrl **required** → throws if missing) | `Authorization: Bearer <key|''>` | same | same |
| anthropic | `https://api.anthropic.com/v1/messages` | `x-api-key: <key>` + `anthropic-version: 2023-06-01` | `{model, max_tokens:1024, system?, messages:[user]}` | first `content[].text` |

Default models (cheap/fast, config-overridable): openrouter `google/gemini-2.0-flash-001`, openai `gpt-4o-mini`, anthropic `claude-3-5-haiku-latest`, local `local-model`. **Confirm these ids are current when first used with a real key** (roadmap risk #3) — a stale id is a one-line config fix.

## Key source (T-B1 → T-B2 swap point)

The key is read **from an env var**, per provider — **`OPENROUTER_API_KEY`**, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, optional `LLM_LOCAL_API_KEY` (local may run keyless). It is **never** read from or written to the project folder / `.canvas/` / `canvas.json` — app config only (`llmConfig.test.ts` asserts the config file is key-free). **T-B2 swaps the env-var read for `safeStorage` + a Settings modal** — the swap point is `keyForProvider(provider, env)` in `llmService.ts`; everything else (factory, orchestrator, IPC) stays.

## Mock seam (e2e / CI — no real network)

`isMockEnabled(env)` is true when `CANVAS_LLM_MOCK === '1'` **or** `CANVAS_SMOKE === 'e2e'`. When on, `getProvider` returns a mock that resolves `` `[mock] ${input.text}` `` with **no network call** — and it's checked **first**, so CI never calls out even if a real key is in the environment (explicit test: "mock wins even when a real API key is present"). Unit tests inject a fake `fetch` via `ProviderDeps` and assert the network is never touched.

## Manual dev check (env-gated, dev-only, skipped under smoke)

`$env:CANVAS_LLM_PING='hello'; pnpm start` → MAIN logs `LLM_PING <json>`. With a real key set → `{ok:true, text:'…'}`; with no key → `{ok:false, reason:'no-provider'}` (graceful degrade). Gated `if (process.env.CANVAS_LLM_PING && !SMOKE)`.

## Security (locked model — untouched)

`contextIsolation`/`sandbox`/`nodeIntegration` unchanged. Both IPC handlers reject foreign senders (`isForeignSender`, same convention as pty/preview/project; denial path tested through the handlers). `LlmStatus` leaks no key material. The one new egress (MAIN→LLM endpoint) is **opt-in** (no key/no mock → no call) and isolated behind `Provider.summarize` so the T-B3 budget guard + egress ADR bolt on cleanly. Browser-board content (native `WebContentsView`, no preload, separate session) cannot reach `llm:*`.

## Gate (all green)

- typecheck 0 · lint 0 errors · format:check clean · **640 unit tests** (47 files; +49 for T-B1) · build OK.
- e2e (`CANVAS_SMOKE=e2e`): `E2E_CONTEXT-BRAIN {"ok":true,"detail":"text=[mock] canvas-brain-ping hasProvider=true"}`, `E2E_DONE ok:true`, exit 0, all 45 probes pass.

## Reviews

18 commits; per-task two-stage review (spec + code-quality) + a final holistic opus review (**ready to merge, no Critical/High**). Holistic security pass confirmed: key never on disk, egress opt-in/isolated, guards intact, scope = exactly T-B1 (T-B2/T-B3 cleanly deferred).

## Next — T-B2 (Key storage + Settings UX)

- `src/main/llmConfig.ts` neighbour or new `llmConfig`-side module: `safeStorage`-encrypt the key in `userData` (never the project folder). Caveat: safeStorage on Linux without a keyring falls back to plaintext — document it.
- Settings modal (renderer): choose provider, enter key, pick/override model. Swap `keyForProvider`'s env read for the safeStorage read.
- e2e: set a key via IPC, read back masked status (`hasKey:true`), assert no key material under the project dir.

### Follow-up flagged for T-B3 (not this PR)
- When the budget guard + egress ADR land, split the IPC layer out of `llmService.ts` into `llmIpc.ts`, leaving `llmService.ts` as the pure provider engine (it's the natural seam, ~245 lines now, still coherent).
