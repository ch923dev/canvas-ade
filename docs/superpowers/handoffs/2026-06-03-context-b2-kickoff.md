# Next-session kickoff — M-brain T-B2 (safeStorage key store + Settings key-entry UX)

> **Purpose:** a self-contained brief so a FRESH session (zero prior context) can execute M-brain T-B2.
> Pre-task kickoff, not a post-task handoff. Paste the "Kickoff prompt" at the bottom into the new
> session, or just open this file there.

## Where we are (read first)

- **Subsystem:** the desktop **Context** brain + project memory (MAIN-side LLM that summarizes the canvas
  into a per-board digest). Sibling of MCP, one-way dep, ships independently. Full design:
  `docs/superpowers/specs/2026-06-03-desktop-context-memory-design.md`. Roadmap: `docs/roadmap-context.md`.
- **Umbrella branch:** `feat/context` (off `main`, worktree `Z:\canvas-ade-context`). THE single umbrella
  for all Context phases. Each task = a sub-branch `feat/context-<id>` off `feat/context`, squash-merge back.
- **Done:** **M-digest** (T-D1 `buildDigest` + T-D2 `DigestPanel`). **M-brain T-B1** (provider-agnostic
  LLM engine) — squash-merged `feat/context` `e7f7fcf` (PR #38). Read its handoff first:
  `docs/superpowers/handoffs/2026-06-03-context-b1-llmservice.md` — it documents the `Provider` interface,
  the per-provider HTTP shapes, the env-var key convention, the mock seam, and **the exact T-B2 swap point**.
- **Cadence (standing):** each task ships **Build · e2e (`CANVAS_SMOKE` probe) · Manual · Gate
  (typecheck/lint/format/test/build) · Handoff doc**. Follow `writing-plans` → STOP for review →
  `subagent-driven-development`. Declare the zone on `Z:\Canvas ADE\.claude\coordination\ACTIVE-WORK.md`
  first. Never work in the `Z:\Canvas ADE` main dir.
- **Memory:** `context-subsystem`.

## What T-B1 left for you (the seam)

T-B1's `src/main/llmService.ts` resolves the API key from an **env var** via:
```ts
export function keyForProvider(provider: ProviderName, env: Record<string,string|undefined>): string | undefined
```
and `src/main/llmConfig.ts` persists **only** `{provider, model, baseUrl?}` to `userData/llm-config.json`
(its test asserts the file is key-free). **T-B2 replaces the env read with a `safeStorage`-encrypted key
store** and adds the Settings UX to enter the key. Everything downstream (`getProvider`, `runSummarize`,
the IPC handlers, the preload bridge, the mock seam) stays — you swap the key SOURCE only.

## The task — M-brain T-B2 (from `docs/roadmap-context.md` › M-brain › T-B2)

- **Zones:** app —
  - NEW `src/main/llmKeyStore.ts` (+test) — `safeStorage` encrypt/decrypt of the API key, stored under
    `app.getPath('userData')`, **never** the project folder / `.canvas/` / `canvas.json`.
  - `src/main/llmService.ts` — make `keyForProvider` (or a new resolver) read from the key store.
  - `src/main/index.ts` — register the new key IPC channels.
  - `src/preload/index.ts` — extend the `llm` bridge (`setKey` / `clearKey`; `status` gains `hasKey`).
  - Renderer — a **Settings modal** (provider dropdown + model field + masked key input). Mount from app
    chrome (gear/menu). Follow the design tokens (`src/renderer/src/index.css`); calm/dense, one accent.
  - e2e — extend `src/main/e2e/probes/context.ts` (or a `settings.ts` probe).
- **Build:** API key encrypted via Electron **`safeStorage`**, persisted in `userData`. Settings modal:
  choose provider, enter key, pick/override model. **No key → typed `{ok:false,reason:'no-provider'}`
  everywhere** (unchanged contract). The key is **write-only into MAIN** — it NEVER crosses back to the
  renderer; `llm:status` reports only `hasKey: boolean` (masked presence), never the key.
- **e2e:** a probe that sets a key via the IPC, reads back masked status (`hasKey:true`), and **asserts no
  key material is written under the project dir** (`.canvas/` + `canvas.json` are key-free). Use a temp
  userData dir; never the real one. Mock seam (`CANVAS_SMOKE=e2e`) must still resolve without a real key.
- **Manual:** enter a key in Settings → relaunch the app → key still works (persisted, encrypted); inspect
  `userData` (encrypted blob, not plaintext) and the project folder (no key anywhere).
- **Gate:** full app gate + e2e. **Handoff:** `…-context-b2-keystore.md`.

### Design notes / decisions to settle in the plan (don't silently pick)

1. **Module boundary.** Keep the encrypted key in a **separate** `llmKeyStore.ts`, NOT in `llmConfig.ts`
   — config stays plaintext provider/model (its key-free invariant + test must hold). Confirm in the plan.
2. **Key resolution precedence.** Does the env var (`OPENROUTER_API_KEY`, T-B1's source) remain a **dev
   fallback** after T-B2, or does the safeStorage store fully replace it? Recommend: **safeStorage first,
   env var as a dev fallback** (keeps existing dev/test flows working) — but settle explicitly. The
   resolver must stay **injectable** (take the store as a param) so unit tests don't need Electron.
3. **safeStorage availability.** `safeStorage.isEncryptionAvailable()` is **false on Linux without a
   keyring** → it would fall back to plaintext. Decide: refuse-to-persist + surface a warning, OR persist
   with an explicit plaintext-fallback warning. **Document the caveat in the handoff** either way.
4. **IPC surface + key direction.** New channels (e.g. `llm:setKey`, `llm:clearKey`); `llm:status` gains
   `hasKey`. The key flows **renderer → MAIN only**; it is never returned to the renderer. All new handlers
   reject foreign senders (reuse the `isForeignSender` pattern). Settle the channel names.
5. **Testability of `safeStorage`.** `safeStorage` needs the Electron `app`. Abstract it behind a small
   interface (an injectable encryptor) so `llmKeyStore` unit-tests run without Electron — mirror how
   `llmConfig` takes an explicit `userDataDir`. The real wiring passes Electron's `safeStorage`.
6. **Settings modal scope.** Minimal: provider `<select>`, model text input (prefilled from
   `DEFAULT_MODELS`), masked key input, Save/Clear. Writes provider/model via the existing config path +
   the key via the new `setKey` channel. No multi-key / multi-profile (YAGNI).

### Out of scope for T-B2 (do NOT build)

- Budget guard + egress ADR → **T-B3**.
- The `.canvas/` memory engine + autonomous summary loop → **M-memory**.
- Multi-provider simultaneous keys / profiles.

## Setup commands (new session)

```bash
cd "/z/canvas-ade-context"
git checkout feat/context && git pull              # ensure latest umbrella (T-B1 is in)
git checkout -b feat/context-b2-keystore           # the task sub-branch
```
Declare the zone on `Z:\Canvas ADE\.claude\coordination\ACTIVE-WORK.md` (the `canvas-ade-context` row):
note `feat/context-b2-keystore` owns `src/main/llmKeyStore.ts(+test)`, the `keyForProvider` swap in
`src/main/llmService.ts`, key IPC in `src/main/index.ts`, the `llm` bridge extension in
`src/preload/index.ts`, the Settings modal (renderer), the e2e settings probe.

## Workflow to follow

1. `superpowers:writing-plans` → author `docs/superpowers/plans/2026-06-0X-context-b2-keystore.md`
   (bite-sized TDD tasks; settle the 6 design notes in the plan header). Stop for review.
2. On approval, `superpowers:subagent-driven-development` → fresh implementer per task; spec review then
   code review between tasks.
3. Controller runs the full gate + `CANVAS_SMOKE=e2e`. Write the T-B2 handoff. Squash-merge
   `feat/context-b2-keystore` → `feat/context`; update the board + the `context-subsystem` memory.

## Gate (must be green before handoff)

```
pnpm typecheck && pnpm lint && pnpm format:check && pnpm test && pnpm build
pnpm build; $env:CANVAS_SMOKE='e2e'; pnpm start    # E2E_DONE ok:true (browser-trio = known env flake)
```

---

## Kickoff prompt (paste into the new session)

> Pick up **M-brain T-B2** (safeStorage key store + Settings key-entry UX) for the Expanse / Canvas ADE
> **Context** subsystem. Read `docs/superpowers/handoffs/2026-06-03-context-b2-kickoff.md` in worktree
> `Z:\canvas-ade-context` first — it has the full brief, the 6 design notes to settle, setup commands, and
> the workflow. Also read the **T-B1 handoff** `docs/superpowers/handoffs/2026-06-03-context-b1-llmservice.md`
> (it documents the exact swap point: `keyForProvider` in `src/main/llmService.ts`) and the
> `docs/roadmap-context.md` M-brain T-B2 card. Work on a sub-branch `feat/context-b2-keystore` off
> `feat/context` (NOT the `Z:\Canvas ADE` main dir). Follow the cadence: `writing-plans` → stop for my
> review → `subagent-driven-development` → gate + `CANVAS_SMOKE=e2e` + handoff. Key rules: the API key is
> encrypted via Electron `safeStorage` in `userData` — **NEVER** the project folder; the key is write-only
> into MAIN (status reports only `hasKey`, never the key); no key → `{ok:false,reason:'no-provider'}`
> everywhere; mock the provider in e2e (no real network); document the Linux-no-keyring plaintext caveat.
