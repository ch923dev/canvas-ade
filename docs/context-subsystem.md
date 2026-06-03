# Context subsystem — build log (compiled)

> **This is the single read-this-instead-of-the-plans doc for the Context subsystem.** It compiles the
> design + every **completed** milestone (architecture, contracts, files, decisions, gate evidence) so a
> session can get full context without reading the per-task specs/plans/handoffs. Those per-task docs were
> **collapsed into this file and deleted** (2026-06-03) — the originals live in git history (see commits
> below). **Forward/undone work stays in `docs/roadmap-context.md`** (task cards for M-memory / M-expose);
> the egress decision is in `docs/decisions/0003-llm-egress.md`. Add a milestone here only when it is DONE.

**Status (2026-06-04):** **M-digest ✅ · M-brain ✅ (T-B1·T-B2·T-B3) · M-memory T-M1 ✅ · T-M2 ✅** on `feat/context`. **Next: M-memory T-M3** (Tier-2 autonomous summarize loop — the first autonomous-spend path the T-B3 budget protects; wire only with the guard in place).

---

## 1. What it is

The **desktop itself** (Electron MAIN) gets a small LLM brain + a persistent **project memory**, so
reopening a project shows an **instant per-board context digest** — "what is each board doing" —
reconstructed from memory, **with zero agents and zero MCP session**.

- **Standalone** `feat/context` off `main` (worktree `Z:\canvas-ade-context`). Sibling of the MCP roadmap
  with a **one-way dep**: MCP only *reads* memory via a thin resource; memory never imports MCP. Ships
  before/independent of MCP.
- **Two tiers, cheap first:**
  - **Tier 1** — no LLM, no key. A structured heuristic digest from `canvas.json` on disk. App fully works
    at Tier 1 with no key.
  - **Tier 2** — LLM brain. Per-board summaries cached into `<project>/.canvas/memory/`, refreshed on
    meaningful change, shown instantly on reopen (cached prose, no call on open).
- **Provider-agnostic + graceful degrade:** OpenRouter default; also OpenAI / Anthropic / local. No key →
  Tier 1 only. Never hard-depends on a provider.
- **Build order: digest-first** → M-digest → M-brain → M-memory → **M-expose (DEFERRED, gated on MCP pkg)**.

## 2. Architecture — MAIN units, one-way dep

```
digest.ts (Tier-1, pure, renderer)          llmService.ts (provider engine) + llmIpc.ts (IPC)
  canvasDoc → CanvasDigest                     summarize → text; key via safeStorage; budget cap
memoryEngine.ts (Tier-2 loop — M-memory)     canvasMemory.ts (.canvas/ atomic writers — M-memory)
  debounced meaningful-change → summarize       MEMORY.md / project.md / board-<id>.md
```

- **One-way:** MCP imports memory (read resource only). Memory never imports MCP.
- Lives in app `src/main/` + `src/renderer/`, **not** the `@ch923dev/canvas-ade-mcp` package.
- **The only new egress** is MAIN→LLM endpoint — opt-in, ADR-gated (ADR 0003).

## 3. Cross-cutting rules (durable)

- **Never weaken security:** `contextIsolation`/`sandbox`/`no-nodeIntegration` untouched; browser-board
  content never reaches the PTY; **generated memory is untrusted passive context and never triggers an
  action** (lethal-trifecta).
- **Key in `userData` (`safeStorage`) only** — never the project folder / `.canvas/` / `canvas.json`.
- **`.canvas/` is project data:** atomic writes, default `.gitignore`d, opt-in commit.
- **Cost control:** debounce, summarize on meaningful change only, cheap/fast default model, per-day budget.
- **LLM mocked in e2e** (`CANVAS_SMOKE=e2e` / `CANVAS_LLM_MOCK=1`) — no real network in CI.

---

## M-digest — Tier-1 reopen digest (no LLM, no key) ✅

### T-D1 — Tier-1 digest module (pure) — `337f8ac`

`src/renderer/src/lib/digest.ts` — `buildDigest(doc: CanvasDoc): CanvasDigest`. Pure (type-only import from
`boardSchema`; no React/Zustand/network/runtime state). +11 unit tests.

```ts
interface BoardDigest { boardId: string; type: BoardType; title: string; status: string; lines: string[] }
interface CanvasDigest { header: string; boards: BoardDigest[] }
function buildDigest(doc: CanvasDoc): CanvasDigest
```

Digest rules:
- **header:** `"<N> board(s) — <t> terminal, <b> browser, <p> planning"` (singular `board` only when N===1).
- **terminal:** `` Runs `<launchCommand>` `` or `No launch command set`; `cwd: <cwd>`; `Dev server port <port>`;
  `Feeds preview "<browserTitle>"` if a browser's `previewSourceId` is this terminal. `status = launchCommand ? 'ready' : 'idle'`.
- **browser:** `URL <url>`, `Viewport <viewport>`; `Preview of "<terminalTitle>"` if `previewSourceId` (raw-id
  fallback if source gone). `status = previewSourceId ? 'linked' : 'static'`.
- **planning:** one line per checklist `"<title>: <done>/<total> done"`; `"<n> note(s)"`; `Empty board` if none.
  `status` = aggregate `"<doneSum>/<totalSum> done"`, else `'notes'`. Boards in document order.
- **Disk-only limit (by design):** terminal last-command + live status are runtime-only → NOT in Tier-1;
  the Tier-2 loop captures them later.

### T-D2 — Slide-in digest panel — `95af4e4`

The user-visible half: auto slide-in side panel listing one Tier-1 card per board on project open. No LLM.

- `src/renderer/src/canvas/DigestPanel.tsx` — presentational. Props `{ digest, open, onOpen, onClose }`.
  Header line + one card per board (type tag · title · status · lines) + ✕ dismiss + a vertical "Context"
  reopen tab when closed. +5 unit tests.
- `src/renderer/src/canvas/Canvas.tsx` — container: `digestOpen` state, **auto-opens once per project
  open/switch** via the render-phase "adjust-state-when-a-key-changes" pattern keyed on `project.dir`
  (**NOT** setState-in-effect); `digest = useMemo(buildDigest(...), [boards, viewport])`.
- `src/renderer/src/index.css` — `.digest-*` block; `prefers-reduced-motion` kills the slide.
- e2e: `src/main/e2e/probes/context.ts` `context-digest` (seeds 3 board types, opens panel, asserts
  cards===boards + a card shows the terminal's launchCommand). `data-test` ids: `digest-panel`(+`data-open`),
  `digest-card`, `digest-close`, `digest-reopen`.
- **Open-once verified:** `project.status` stays `'open'` for the project lifetime → the auto-open fires once
  per open/switch, NOT on later edits.

**Open follow-ups (non-gating):** a11y — add `inert` to the `<aside>` when closed (buttons stay in tab order
while slid off-screen). T-M4 later swaps Tier-1 `lines` for cached Tier-2 prose.

---

## M-brain — LLM service (provider-agnostic brain) ✅

### T-B1 — Provider-agnostic adapter — `e7f7fcf` (PR #38)

MAIN's brain: `summarize(input) → text` behind a `Provider` interface, reachable over a guarded
`llm:summarize`/`llm:status` bridge, degrading to a typed no-provider result with no key.

- `src/main/llmService.ts` — `buildRequest`/`parseResponse` (pure, per provider), `getProvider(config, deps) →
  Provider|null`, `runSummarize(config, input, deps) → SummarizeResult` (**never throws**).
- `src/main/llmConfig.ts` — provider/model in `userData/llm-config.json` (atomic; **key-free**, test-asserted);
  `DEFAULT_MODELS` single source of truth, `PROVIDERS` derived from it.
- `src/preload/index.ts` — `window.api.llm.summarize/status` bridge. `src/main/index.ts` registers handlers.
- e2e `context-brain` (mock-provider IPC round-trip).

```ts
interface SummarizeInput { system?: string; text: string }
interface Provider { summarize(input): Promise<string> }   // throws on transport/HTTP error
type ProviderName = 'openrouter' | 'openai' | 'anthropic' | 'local'
```

**Per-provider HTTP shape:** OpenAI chat shape for openrouter/openai/local (`<base>/chat/completions`,
`Authorization: Bearer <key>`, parse `choices[0].message.content`); Anthropic messages shape
(`/v1/messages`, `x-api-key` + `anthropic-version: 2023-06-01`, `max_tokens:1024`, parse first `content[].text`).
`local` requires `config.baseUrl` (throws if missing), may run keyless. Default models (cheap/fast,
config-overridable): openrouter `google/gemini-2.0-flash-001`, openai `gpt-4o-mini`, anthropic
`claude-3-5-haiku-latest`, local `local-model` — **confirm ids current when first used with a real key**.

**Mock seam:** `isMockEnabled(env)` true under `CANVAS_LLM_MOCK=1` or `CANVAS_SMOKE=e2e` → `getProvider`
returns a mock resolving `` `[mock] ${text}` `` with **no network**, checked **first** (mock wins even with a
real key in env). **Dev ping:** `CANVAS_LLM_PING=hello pnpm start` → MAIN logs `LLM_PING <json>`; gated
`if (CANVAS_LLM_PING && !SMOKE)`.

### T-B2 — safeStorage key store + Settings key UX — `5678257`

API key **encrypted via Electron `safeStorage`** in `userData/llm-keys.json` — **never** the project folder.
Key resolution swapped from T-B1's env read to **store-first, env-fallback**.

- `src/main/llmKeyStore.ts` — `createKeyStore(userDataDir, encryptor) → {getKey,setKey,clearKey,hasKey}`.
  Injected `Encryptor` (= Electron safeStorage) → **Electron-free, unit-testable**. `setKey` **refuses to
  persist** (returns false, writes nothing) when `isEncryptionAvailable()` is false — **no plaintext fallback**.
- `keyForProvider(provider, env, store?)` = `store?.getKey(p) ?? env[KEY_ENV[p]]` (store-first). `LlmStatus`
  gains `hasKey`.
- Key IPC **`llm:setKey`/`clearKey`/`setConfig`** (all foreign-sender guarded); **key is write-only INBOUND —
  never returned; `status` carries `hasKey` presence only**. `index.ts` injects the real safeStorage
  encryptor; under `CANVAS_SMOKE=e2e` the store uses a temp dir via `process.env.CANVAS_E2E_LLM_DIR`.
- `src/renderer/src/canvas/SettingsModal.tsx` (+ `lib/llmModels.ts` renderer mirror, gear in camera cluster):
  provider/model/baseUrl/masked-key; Save surfaces a failed key-save inline (no silent close); detaches native
  previews while open (ADR-0002). e2e `context-keystore` proves **ciphertext-on-disk + no plaintext leak +
  config key-free**.
- ⚠️ **Linux-no-keyring caveat:** safeStorage unavailable → `setKey` refuses (no plaintext); the env-var
  fallback (`OPENROUTER_API_KEY` etc.) still supplies a key there.

IPC contract (T-B2):
```ts
llm.setKey({ provider, key })  → { ok:true } | { ok:false, reason:'encryption-unavailable'|'forbidden' }
llm.clearKey({ provider })     → { ok:true } | { ok:false, reason:'forbidden' }
llm.setConfig({ provider, model, baseUrl?, maxCallsPerDay? }) → { ok:true } | { ok:false, reason:'forbidden' }
llm.status() → { hasProvider, provider, model, baseUrl?, hasKey }   // hasKey = presence only; NEVER the key
```

### T-B3 — Per-day budget guard + egress ADR + IPC split — `cec15ba`

A per-calendar-day **call** budget caps LLM spend; the egress is documented; the IPC layer was split out.

- `src/main/llmBudget.ts` — `createBudgetStore(userDataDir, clock) → {tryConsume(cap), peek()}`; `dayKey`
  (local YYYY-MM-DD), `DEFAULT_MAX_CALLS_PER_DAY=200`. Counter `{day, calls}` in `userData/llm-budget.json`
  (atomic, per-day reset; new-day/missing/corrupt → 0; blocked consume writes nothing). Injected clock →
  Electron-free.
- `src/main/llmService.ts` — `runSummarize` **reserves a call PRE-FETCH**; over cap → typed
  `{ok:false, reason:'budget-exceeded'}` → Tier-1 (**never throws**; **no refund** on provider-error =
  fail-closed). New exported `shouldEnforceBudget(config, env)` = `isMockEnabled(env) ? config.maxCallsPerDay
  !== undefined : true` — **real egress always enforced; mock seam only with an explicit cap** (CI stays
  uncapped unless a probe opts in). Cap = `config.maxCallsPerDay ?? 200`.
- `src/main/llmConfig.ts` — `LlmConfig` gains `maxCallsPerDay?`; `readLlmConfig` validates (finite, ≥0,
  floored) else undefined.
- `src/main/llmIpc.ts` — **NEW**: IPC layer split out of `llmService.ts` (`isForeignSender`, `LlmStatus`,
  `LlmWriteResult`, `NOOP_KEY_STORE`, `registerLlmHandlers`); `llmService.ts` is now the pure engine.
  `registerLlmHandlers` always builds a real budget store so the cap is live in production; `setConfig`
  carries `maxCallsPerDay`. `index.ts` imports `registerLlmHandlers` from `./llmIpc`.
- `src/preload/index.ts` — `LlmSummarizeResult` mirror gains `budget-exceeded`; `setConfig` arg gains
  `maxCallsPerDay?`.
- e2e `src/main/e2e/probes/budget.ts` `context-budget` (after `contextBrain`): opt-in cap=1 → drive past →
  asserts `budget-exceeded` + app usable + counter in `CANVAS_E2E_LLM_DIR`; restores uncapped config.
- **ADR `docs/decisions/0003-llm-egress.md`** — egress opt-in/isolated/capped/passive; one Low exemption:
  the dev-only `CANVAS_LLM_PING` runs unbudgeted (env-gated, one call/start, not renderer-reachable).

Summarize result (main `SummarizeResult` == preload `LlmSummarizeResult`):
```ts
{ ok:true, text } | { ok:false, reason:'no-provider' } | { ok:false, reason:'budget-exceeded' }
                  | { ok:false, reason:'provider-error', message }
```

**M-brain security model:** egress opt-in (no key → `no-provider` → no fetch); cap unbypassable on the
renderer-reachable path (real budget always built; foreign senders rejected before `runSummarize`); no
secret on disk/IPC (`llm-budget.json` = `{day, calls}` only; status = `hasKey` presence). `runSummarize`
never throws; callers treat `budget-exceeded` like `no-provider` (Tier-1).

---

## M-memory — `.canvas/` engine + Tier-2 loop ⛓ M-brain

The persistent project memory. **T-M1 (storage layer) ✅;** T-M2 (change detector) · T-M3 (Tier-2
summarize loop — first autonomous-spend path the T-B3 budget protects) · T-M4 (panel cached-prose
upgrade) are forward work in `docs/roadmap-context.md`.

### T-M1 — `.canvas/` engine (paths + atomic writers) ✅

`<project>/.canvas/` storage engine: paths, atomic markdown writers/readers, a default-private
`.gitignore` with an opt-in-to-commit toggle, and project create/open scaffolding. **No LLM / loop /
renderer read-bridge** (those are T-M2/T-M3/T-M4). `.canvas/` is **PROJECT data** rooted at the project
folder — the opposite of the `userData`-rooted `llmConfig`/`llmKeyStore`/`llmBudget`.

- `src/main/canvasMemory.ts` — `createCanvasMemory(projectDir) → CanvasMemory`. Electron-free (explicit
  `projectDir`, mirrors the key/budget store discipline), `write-file-atomic.sync` + `mkdirSync` guards.

```ts
interface CanvasMemoryPaths { root; memoryDir; auditDir; gitignore; index; project; board(id): string }
interface CanvasMemory {
  paths: CanvasMemoryPaths
  ensureScaffold(): void                  // mkdir memory/ + audit/; write default-private .gitignore IF ABSENT
  writeBoard(id, md): boolean             // false on unsafe id; else atomic-write board-<id>.md
  writeIndex(md): void; writeProject(md): void
  readBoard(id): string | undefined; readIndex(): ...; readProject(): ...   // undefined on missing, NEVER throw
  setCommitOptIn(commit: boolean): void   // true → '.gitignore' = 'audit/\n'; false → '*\n'
  isCommitted(): boolean                  // matches the committed value (empty/corrupt → private = safe default)
}
function safeBoardId(id): boolean         // exported; true only for non-empty /^[A-Za-z0-9_-]+$/ (nanoid alphabet)
function scaffoldProjectMemory(dir): void // best-effort: try/catch ensureScaffold + log; NEVER aborts an open
```

- **Layout:** `.canvas/memory/{MEMORY.md (index), project.md, board-<id>.md (per-board prose)}` +
  reserved `.canvas/audit/`. **`.gitignore` toggle:** default private `*\n` (whole `.canvas/` invisible
  to git); opt-in commit `audit/\n` (commits the prose, ignores only the volatile audit log). Scaffold
  writes the default **only if absent** — never clobbers a user opt-in.
- **Path-traversal defense:** `safeBoardId` validates the id before it reaches the `board-<id>.md`
  filename; an unsafe id (`../evil`, `a/b`, empty) returns `false`/`undefined` and writes nothing
  outside `memory/` (mirrors the `assets/` `ASSET_RE` discipline in `projectStore.ts`).
- **Lifecycle wiring:** `projectStore.ts` `createProject` scaffolds on create (and on reuse of an
  existing project); `projectIpc.ts` `project:open` + `project:current` scaffold **open-if-absent** so
  projects predating T-M1 get `.canvas/` on first open. All four sites go through
  `scaffoldProjectMemory` → **a permission/disk error (EACCES/ENOSPC on a read-only mount / network
  share / OneDrive folder) is logged + swallowed**, never aborting the open (mirrors `project:save`'s
  try/catch). No change to the `canvas.json` save/load contract; `.canvas/` content never routes into
  `canvas.json` or a board patch key.
- e2e `src/main/e2e/probes/memory.ts` `context-memory` (last in the PLAYLIST — it points the open dir
  at a throwaway project, then restores `setCurrentDir(null)` + cleans the temp dir in `finally`):
  proves `createProject` scaffolded `memory/` + `audit/` + a `*\n` `.gitignore` AND a board summary
  round-trips on disk **under the project dir** (independent `existsSync` at the hardcoded path — not a
  path-compares-to-itself check), never `userData`.

🔒 **T-M1 security model:** `.canvas/` is project data (atomic, default-ignored, opt-in commit); the API
key is NEVER written there (stays in `userData/llm-keys.json`, safeStorage); generated memory is
untrusted passive context (written + read, never triggers an action); `contextIsolation`/`sandbox`/
`no-nodeIntegration` untouched; no renderer read bridge yet (deferred to T-M4).

### T-M2 — Meaningful-change detector + debounce ✅

The DETECTOR half of the Tier-2 loop: decides *when* a board is worth re-summarizing and emits a
`{ boardId }` intent — **no LLM call, no `.canvas/` write** (that is T-M3).

- `src/main/memoryEngine.ts` — `createMemoryEngine({ onIntent, debounceMs?, schedule? }) →
  { observe(doc), reset() }` + pure `boardFingerprint(board: unknown): string`. Electron-free; the
  timer is an injected `Scheduler` (default `setTimeout`/`clearTimeout`, `.unref()`'d so a pending
  debounce never blocks quit; tests inject a manual fake; e2e uses a short real debounce).
  `DEFAULT_DEBOUNCE_MS = 45_000`, per-board independent **trailing-edge** timer (a burst collapses to
  one intent).

```ts
type Scheduler = (fn: () => void, ms: number) => () => void
interface SummarizeIntent { boardId: string }
interface MemoryEngineDeps { onIntent: (i: SummarizeIntent) => void; debounceMs?: number; schedule?: Scheduler }
interface MemoryEngine { observe(doc: unknown): void; reset(): void }
function createMemoryEngine(deps: MemoryEngineDeps): MemoryEngine
function boardFingerprint(board: unknown): string   // pure; mirrors digest.ts's meaningful fields
```

- **Fingerprint** mirrors `digest.ts`'s meaningful fields (terminal `launchCommand`/`cwd`/`port`;
  browser `url`/`viewport`/`previewSourceId`; planning per-checklist `title` + items `{label,done}` +
  note `text`) and **excludes** geometry/selection/canvas-pan-zoom — a pure move/resize/pan/select is a
  no-op. **Process boundary:** MAIN can't import the renderer's `boardSchema`/`digest.ts`
  (`tsconfig.node` = `src/main/**`), so the field set is picked **locally** from the `unknown` doc with
  a parity comment + parity tests (sharing a constant across the main/renderer tsconfig split is not
  possible — this is the resolution of the kickoff's "share a constant" note).
- **Semantics:** first `observe` of a session = baseline (no emit, `primed` flag); a changed or
  brand-new board (re)arms its debounce; a removed board cancels its pending intent + drops state;
  `reset()` clears fingerprints + cancels timers on project switch.
- **Wiring (`projectIpc.ts`):** one engine (default `onIntent` logs — T-M3 swaps in the summarize
  loop); `project:save` feeds the doc after a **successful** write in its **own** try/catch (a detector
  throw can never turn a good save into `false`); `project:open`/`project:current` `reset()` on switch.
  `index.ts` untouched (engine param defaulted, so the existing 3-arg call site is unchanged).
- e2e `src/main/e2e/probes/change.ts` `context-change`: drives `createMemoryEngine` directly with a
  short real debounce → content change emits exactly 1 intent, a pure move emits 0.

🔒 **T-M2 security model:** the detector only **reads** the already-trusted persisted doc and **emits
an id** — it never triggers an action beyond the emit (T-M3 must keep the intent summarize-only, never
a PTY write or board mutation); no new egress; no `llmService`/`canvasMemory` import; the `project:save`
feed is best-effort and can never fail a save.

---

## Gate evidence (cumulative, on `feat/context`)

| Milestone | Commit | Unit | e2e |
|---|---|---|---|
| T-D1 | `337f8ac` | 513 | (pure module, none) |
| T-D2 | `95af4e4` | 518 | `context-digest` ok |
| T-B1 | `e7f7fcf` | 640 | `context-brain` ok |
| T-B2 | `5678257` | 664 | `context-keystore` ok |
| T-B3 | `cec15ba` | **682** | `context-budget` ok |
| T-M1 | `2e0b1e7` | **702** | `context-memory` ok |
| T-M2 | `221ddf8` | **724** | `context-change` ok |

typecheck/lint/format:check clean throughout (1 pre-existing unrelated `PlanningBoard.tsx` no-console
warning). `E2E_DONE` occasionally shows `ok:false` solely from the known `browser`/`browser-gesture`/
`focus-detach` `capturePage` env flake (memory `e2e-browser-trio-flake`) — not a regression.

## What's next (see `docs/roadmap-context.md`)

**M-memory** — the persistent `.canvas/` engine + the Tier-2 autonomous summarize-on-change loop (the first
autonomous-spend path the T-B3 budget protects — wire only with the guard in place) + the panel upgrade to
cached prose:
- **T-M1** `src/main/canvasMemory.ts` — `.canvas/` paths + atomic writers + default `.gitignore` + opt-in
  commit + create/open scaffolding. ✅ **DONE** (see the M-memory section above).
- **T-M2** ✅ meaningful-change detector + debounce (`src/main/memoryEngine.ts`, wired into
  `projectIpc.ts`). **T-M3** Tier-2 autonomous summary loop (**next**). **T-M4** panel upgrade to
  cached prose on reopen.

**M-expose (DEFERRED)** — `canvas://memory` MCP read resource; gated on the MCP package (Phases 0–1) landing
on `main`. ⚠️ Owes 2 reverse cross-links into `docs/roadmap-mcp.md` (M9 judge-board pivot becomes optional;
M1/M10 expose memory) — staged on `feat/mcp-integration`, not here.

## Collapsed docs (originals in git history)

The per-task spec, plans, and handoffs were compiled into this file and deleted on 2026-06-03. Recover any
original via git, e.g. `git show <commit>:docs/superpowers/handoffs/2026-06-03-context-b3-budget-egress.md`:
- spec `docs/superpowers/specs/2026-06-03-desktop-context-memory-design.md`
- plans `docs/superpowers/plans/2026-06-03-context-{d1-tier1-digest,d2-digest-panel,b1-llmservice,b2-keystore,b3-budget-egress}.md`
- handoffs `docs/superpowers/handoffs/2026-06-03-context-{d1-digest,d2-panel,b1-kickoff,b1-llmservice,b2-kickoff,b2-keystore,b3-kickoff,b3-budget-egress}.md`
