# Handoff — M-brain T-B2 (safeStorage key store + Settings key-entry UX)

**Date:** 2026-06-03 · **Branch:** `feat/context-b2-keystore` (off `feat/context`) · **Status:** DONE, full gate + e2e green, ready to squash-merge.
**Plan:** `docs/superpowers/plans/2026-06-03-context-b2-keystore.md` · **Predecessor:** T-B1 handoff `2026-06-03-context-b1-llmservice.md` · **Roadmap:** `docs/roadmap-context.md` › M-brain › T-B2.

## What shipped

The API key is now **encrypted via Electron `safeStorage`** and stored under `userData` — **never** the project folder / `.canvas/` / `canvas.json`. Key resolution swapped from T-B1's env-var read to **store-first, env-fallback**. A guarded IPC surface (`llm:setKey` / `llm:clearKey` / `llm:setConfig`) lets the renderer write the key + provider/model into MAIN; the key is **write-only inbound** — it never crosses back, and `llm:status` reports only `hasKey: boolean`. A minimal **Settings modal** (gear in the camera cluster) drives it. No-key behaviour is unchanged: `{ok:false, reason:'no-provider'}` everywhere, and the e2e/CI mock seam still resolves without a key/network.

### Files
- **`src/main/llmKeyStore.ts`** (+test) — NEW. `createKeyStore(userDataDir, encryptor)` → `{getKey, setKey, clearKey, hasKey}`. Encrypts via an injected `Encryptor` (mirrors safeStorage's surface), persists `{provider: base64(ciphertext)}` to `userData/llm-keys.json` (atomic write, `mkdirSync` guard). **Electron-free** (encryptor injected) → unit-tests without Electron. `setKey` **refuses to persist** (returns `false`, writes nothing) when `isEncryptionAvailable()` is false — no plaintext fallback. Reads return `undefined` (never throw) on corrupt/missing.
- **`src/main/llmService.ts`** (+test) — `ProviderDeps.keyStore?: Pick<KeyStore,'getKey'>`; `keyForProvider(provider, env, store?)` = `store?.getKey(provider) ?? env[KEY_ENV[provider]]` (store-first). `LlmStatus` gains `hasKey`. `registerLlmHandlers(..., encryptor?)` builds the store (or a `NOOP_KEY_STORE` with a dev-warn when none is wired) and injects it into `deps.keyStore` so a `setKey` is immediately live for `summarize`. Three new guarded channels (`setKey`/`clearKey`/`setConfig`), all foreign-sender-rejected. `LlmWriteResult = {ok, reason?}`.
- **`src/main/index.ts`** — builds the real Electron `safeStorage` `Encryptor` adapter and injects it. Under `CANVAS_SMOKE=e2e` the key store uses a throwaway `mkdtempSync` dir exported as `process.env.CANVAS_E2E_LLM_DIR` (so a test key never touches the real `userData`); otherwise `app.getPath('userData')`. `CANVAS_LLM_PING` block untouched.
- **`src/preload/index.ts`** — `llm` bridge gains `setKey`/`clearKey`/`setConfig`; `LlmStatus` mirror gains `hasKey`; `LlmWriteResult` type. No key-read path (no `getKey`).
- **`src/renderer/src/canvas/SettingsModal.tsx`** (+test) — NEW. Portaled, token-styled modal: provider `<select>`, editable model (prefilled from `DEFAULT_MODELS` per provider), `baseUrl` (local only), masked key input, Save / Clear key / Cancel. Prefills from `status()`. Save writes config then the key (only if a key was entered); on `setKey` `{ok:false}` it **keeps the modal open + shows an inline `--warn` alert** (no silent failure). Detaches live native previews while open (ADR-0002, mirrors `TidyMenu`). Dismissal (scrim/Escape) gated on `busy`.
- **`src/renderer/src/lib/llmModels.ts`** (+`AppChrome.tsx` gear) — renderer mirror of `DEFAULT_MODELS` (hand-synced; avoids a renderer→main import) + the gear `ToolBtn` (`name="settings"`) in the camera cluster.
- **`src/main/e2e/probes/settings.ts`** (+`e2e/index.ts` playlist) — NEW `context-keystore` probe.

## The IPC contract (T-B2 additions)

```ts
llm.setKey({ provider, key })  → { ok: true } | { ok: false, reason: 'encryption-unavailable' | 'forbidden' }
llm.clearKey({ provider })     → { ok: true } | { ok: false, reason: 'forbidden' }
llm.setConfig({ provider, model, baseUrl? }) → { ok: true } | { ok: false, reason: 'forbidden' }
llm.status() → { hasProvider, provider, model, hasKey }   // hasKey = presence only; NEVER the key
```
Every new channel rejects foreign senders (`isForeignSender`, same convention as pty/preview/project/summarize). The key crosses IPC **inbound only** (`setKey`'s `key` arg); nothing returns it.

## Security model

- Key encrypted at rest (`safeStorage`), in `userData/llm-keys.json` — **never** a project folder / `.canvas/` / `canvas.json`. `llmConfig.ts` stays key-free (its `not.toMatch(/api[_-]?key/i)` test holds).
- Key is **write-only into MAIN**: status carries `hasKey` only; no renderer read path; the modal holds the key in local input state and sends it via `setKey`, never rendering it back.
- New egress unchanged from T-B1 (opt-in, isolated behind `Provider.summarize`); `contextIsolation`/`sandbox`/`no-nodeIntegration` untouched. Browser-board content (native view, no preload, separate session) cannot reach `llm:*`.

## ⚠️ Caveat — safeStorage on Linux without a keyring (settled decision)

`safeStorage.isEncryptionAvailable()` is **false on Linux without a keyring** (headless, or no gnome-keyring/kwallet). **Decision: refuse-to-persist** — `setKey` returns `{ok:false, reason:'encryption-unavailable'}` and writes **nothing** (we never store a plaintext key). The Settings modal surfaces this inline ("Key not saved: no system keyring available…"). On such hosts the **env-var fallback** (`OPENROUTER_API_KEY` etc., from T-B1, still the env half of `keyForProvider`) remains the way to supply a key. This is the safe choice — a plaintext API key on disk would be a security regression.

## Gate (all green)

- typecheck 0 · lint 0 errors (1 pre-existing `PlanningBoard.tsx` no-console warning, unrelated) · format:check clean · **664 unit tests** (49 files; +24 for T-B2: 6 keystore, 5 precedence, 6 key-IPC, 7 modal) · build OK.
- e2e (`CANVAS_SMOKE=e2e`): `E2E_CONTEXT-KEYSTORE {"ok":true,"detail":"set.ok=true hasKey=true enc=true noLeak=true cfgClean=true noRendererLeak=true cleared=true"}`, `E2E_DONE ok:true`, all 49 probes pass (the browser/browser-gesture/focus-detach trio flaked once on a contended host then passed clean on rerun — known `capturePage` env flake, memory `e2e-browser-trio-flake`, not a regression).

The `context-keystore` probe sets a sentinel key via the real bridge, then MAIN-side asserts: `llm-keys.json` is **ciphertext** (sentinel in NO file as plaintext), `llm-config.json` is key-free, the key never appeared in the renderer-facing `status()`, and `clearKey` flips `hasKey` false. It hard-fails if `CANVAS_E2E_LLM_DIR` is unset (the disk scan is mandatory, not skippable) and accepts the refuse-persist branch on a no-keyring host.

## Manual check (dev)

Enter a key in Settings (gear, top-right) → relaunch → key still works (persisted, encrypted). Inspect `userData/llm-keys.json` (base64 ciphertext blob, not plaintext) and the project folder (no key anywhere). On Linux-no-keyring: Save shows the inline "no system keyring" notice and stores nothing.

## Reviews

Per-task two-stage review (spec compliance + code quality) + adversarial verify on the security-critical pieces. Findings fixed inline: T1 (mkdirSync guard, doc tighten), T3 (named `LlmWriteResult`, NOOP-store dev-warn against silent mis-wire), T6 (silent `setKey` ok:false → inline error + keep-open; scrim/Escape `busy`-gating; native-preview detach), T7 (mandatory dir guard + `withFileTypes`). No Critical/High; the no-plaintext-leak invariant has no false-green path (verified).

## Next — T-B3 (Budget guard + egress ADR)

- Per-day token/call **budget cap** in `llmService.ts` (`BudgetExceeded` → surfaced, falls to Tier-1).
- Write the **egress ADR** (`docs/decisions/`): MAIN→LLM endpoint is the one new egress beyond loopback — opt-in, user-controlled, documented. Confirm `contextIsolation`/`sandbox`/`no-nodeIntegration` unchanged.
- **Flagged follow-up (from T-B1, still open):** when T-B3 lands, split the IPC layer out of `llmService.ts` into `llmIpc.ts`, leaving `llmService.ts` as the pure engine (now larger after T-B2 — the natural seam).
- **`local` baseUrl round-trip — FIXED in this PR (`24069f7`):** the final holistic review caught that `llm:status` omitted `baseUrl`, so re-saving a `local` config wiped it. `LlmStatus` now echoes `baseUrl` (main + preload) and the modal prefills it. No longer outstanding.
- **Info (out of T-B2 scope):** `isForeignSender` now has a 4th per-module copy (pty/preview/project/llm) — consolidation is a separate refactor, intentionally deferred.
