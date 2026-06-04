# Expanse — Context (Desktop Brain + Project Memory) Roadmap

> **Branch:** `feat/context` (base `main`, **standalone** — ships before / independent of MCP).
> **Goal:** give the desktop (Electron MAIN) its own small LLM brain + a persistent project memory, so
> reopening a project shows an **instant per-board context digest** with **zero agents and zero MCP
> session**. Sibling of `docs/roadmap-mcp.md`, **not part of it** (one-way dep: MCP only *reads* memory).
>
> **Decided 2026-06-03** (brainstorming): two tiers (Tier-1 no-key heuristic · Tier-2 LLM) · cheap/fast
> default model · meaningful-change = content-diff + cmd-done debounced · auto slide-in digest panel ·
> `canvas://memory` index+per-board · key in `safeStorage`/userData · **digest-first build order** ·
> **M-expose deferred** to post-MCP. Architecture + completed-milestone build log: `docs/context-subsystem.md`.

Legend: 🚦 hard gate · ✅ acceptance · 🔒 security-critical · ⛓ depends-on · ∥ parallelizable.

---

## 0. Architecture recap (no separate backend)

Brain + memory are **standalone MAIN subsystems**, built in the `canvas-ade` app (NOT the
`@ch923dev/canvas-ade-mcp` package). Four units:

```
digest.ts (Tier-1, pure)   llmService.ts (provider-agnostic brain, key in safeStorage + budget guard)
memoryEngine.ts (Tier-2 loop, owns <project>/.canvas/)   digest panel (renderer slide-in)
```

They work with **zero agents / zero MCP**. The only MCP touch-point is the **deferred** M-expose read
resource. The only new egress is MAIN → the chosen LLM endpoint (opt-in, ADR-gated). Project data lives
in `<project>/.canvas/` (atomic write, default `.gitignore`d); the API key lives in `userData`
(`safeStorage`) — **never crossed**.

---

## 1. Branch & cadence model

- **`feat/context` is standalone off `main`.** M-digest / M-brain / M-memory merge to `main`
  independent of the MCP umbrella. (M-expose waits on MCP package 0–1 being on `main`.)
- **Each task = one sub-branch off `feat/context`**: `feat/context-<task-id>` (e.g.
  `feat/context-d1-digest`). Squash-merge back to `feat/context` when its card is green. One task in
  flight unless cards are file-disjoint (declare zones on `.claude/coordination/ACTIVE-WORK.md` first).
- **A handoff doc is written after EVERY task** → `docs/superpowers/handoffs/<YYYY-MM-DD>-context-<task-id>.md`.
- Never run feature work in the `Z:\Canvas ADE` main dir (the 2026-06-03 collision lesson).

### Per-task card template (mandatory fields)

| Field | Content |
|---|---|
| **Repos / zones** | app files touched (declared on the coordination board). Package is untouched until M-expose. |
| **Build** | the unit(s) + any IPC + any UI for the task |
| **tests** | per `docs/testing/TESTING.md`: Context logic is **unit** (digest/memory/serialize) + **integration** for IPC handlers (via `ipcTestHarness`, foreign-sender rejection required) and jsdom for any panel/settings UI. **No e2e** — the Context subsystem has no mandatory e2e sliver (the old `CANVAS_SMOKE=e2e` probe harness was deleted in the T4 migration). LLM is **mocked** (`CANVAS_LLM_MOCK=1`; no real network). |
| **Manual** | explicit steps + expected output (e.g. "open project X → panel slides in with N cards; card for board B shows its launchCommand") |
| **Gate** | `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test && pnpm build` (Vitest unit + integration projects). The Playwright `_electron` keep-set carries no Context spec. |
| **Handoff** | written after the task: what landed, files, test evidence, follow-ups, next-task pointer |

---

## 2. Dependency graph

```
M-digest ──▶ M-brain ──▶ M-memory ──▶ (M-expose, DEFERRED — gated on MCP pkg 0–1 on main)
   │                         ▲
   └── Tier-1 panel ─────────┘ (panel upgrades to cached Tier-2 prose in M-memory T-M4)
```

- **M-digest** depends on nothing (reads `canvas.json`).
- **M-brain** introduces the LLM adapter, key, budget, egress ADR.
- **M-memory** introduces `.canvas/` + the Tier-2 autonomous loop and upgrades the panel.
- **M-expose** is the only MCP-coupled milestone → deferred.

---

## M-digest — Tier-1 reopen digest (no LLM, no key)

**Goal:** ship the "instant context on reopen" win with **no provider, no key, no egress** — pure
heuristic over `canvas.json`. **Dep:** none.

### T-D1 — Tier-1 digest module (pure)
- **Repos / zones:** app — `src/renderer/src/lib/digest.ts` (+ `digest.test.ts`).
- **Build:** `buildDigest(canvasDoc) → DigestModel`. Pure (no React/Zustand/network/key). Per type:
  terminal → `launchCommand`/`cwd`/`port` + linked-preview presence; browser → `url`/`viewport`/
  `previewSourceId`; planning → per-checklist `title`+`done/total`, note count. Project-level header
  line (board counts by type).
- **e2e:** N/A at unit layer (covered by T-D2's probe end-to-end); **unit** tests assert the model for
  crafted docs (each board type, empty canvas, missing optional fields).
- **Manual:** run the unit suite; eyeball a snapshot of the model for a seeded doc.
- **Gate:** full app gate. **Handoff:** `…-context-d1-digest.md` — the `DigestModel` shape (the
  contract the panel + later Tier-2 build on).

### T-D2 — Slide-in digest panel (renderer) on project open
- **Repos / zones:** app — `src/renderer/src/canvas/DigestPanel.tsx` (new) + a mount in `App.tsx` /
  app chrome; project-open wiring (reuse the existing open/load signal).
- **Build:** on project open, compute Tier-1 from the loaded store → **auto slide-in side panel** of
  per-board cards (title + type glyph + status + digest lines). Dismissible; re-openable from chrome.
  No LLM call.
- **e2e:** `context.ts` probe — seed a project with mixed boards, drive project-open → **assert the
  panel mounts with one card per board and the card text reflects each board's data** (e.g. the
  terminal card shows its `launchCommand`). Use **real input where the panel is transform-affected**;
  assert off DOM/getBoards, not synthetic dispatch only (memory `e2e-sendinputevent-vs-dispatchevent`).
- **Manual:** open a real project with a terminal+browser+planning board → panel slides in, each card
  correct; dismiss → canvas; reopen from chrome.
- **Gate:** full app gate + e2e. **Handoff:** `…-context-d2-panel.md`.

**🚦 M-digest gate:** open any project → instant per-board digest panel, **no key, no network**. The
app is fully usable at Tier 1.

---

## M-brain — LLM service (provider-agnostic brain) ⛓ M-digest

**Goal:** MAIN's own brain — a provider-agnostic adapter with the key in `safeStorage`, a budget guard,
graceful degradation, and the egress ADR. **No memory loop yet** (that's M-memory); this milestone is
the engine + its guards, exercised by a dev-only "summarize this board" action.

### T-B1 — Provider-agnostic adapter
- **Repos / zones:** app — `src/main/llmService.ts` (+ test), `src/preload/index.ts` (a guarded
  `llm:summarize` / `llm:status` bridge), `src/main/index.ts` (register handlers).
- **Build:** `summarize(input) → string` behind a small `Provider` interface; implementations for
  **OpenRouter (default)**, OpenAI, Anthropic, local endpoint. One HTTP shape per provider. Default
  model = **cheap/fast class**, user-overridable. Provider+model config persisted in `userData`.
- **e2e:** `context.ts` probe with a **mock provider** (injected via env/test seam) — `summarize`
  returns the stub text; assert the round-trip through IPC.
- **Manual:** with a real OpenRouter key set, a dev-mode button calls `summarize("hello")` → see the
  model's reply in the MAIN log.
- **Gate:** full app gate + e2e. **Handoff:** `…-context-b1-llmservice.md` — the `Provider` interface.

### T-B2 — 🔒 Key storage (safeStorage) + Settings key-entry UX
- **Repos / zones:** app — `src/main/llmConfig.ts` (new; `safeStorage` encrypt/decrypt in `userData`),
  a Settings modal in the renderer (provider + model + key field), `preload` bridge.
- **Build:** API key encrypted via Electron **`safeStorage`**, stored under `app.getPath('userData')`
  — **never** the project folder / `.canvas/` / `canvas.json`. Settings modal: choose provider, enter
  key, pick/override model. No key → a typed `NoProvider` is returned everywhere.
- **e2e:** probe sets a key via the IPC, reads back masked status (`hasKey:true`), confirms **no key
  material is written under the project dir** (assert `.canvas/` + `canvas.json` are key-free).
- **Manual:** enter a key in Settings → relaunch the app → key still works (persisted, encrypted);
  inspect `userData` (encrypted blob) and the project folder (no key).
- **Gate:** full app gate + e2e. **Handoff:** `…-context-b2-keystore.md` (note the safeStorage caveat:
  on Linux without a keyring it falls back to plaintext — document it).

### T-B3 — 🔒 Budget guard + egress ADR
- **Repos / zones:** app — budget logic in `llmService.ts`, `docs/decisions/` (new ADR).
- **Build:** per-day token/call **budget cap** (configurable); hard-stop + surfaced when hit
  (`BudgetExceeded`); cheap/fast default. **Write the egress ADR**: MAIN→LLM endpoint is the one new
  egress beyond loopback — opt-in (no key, no call), user-controlled, documented. Confirm
  `contextIsolation`/`sandbox`/`no-nodeIntegration` unchanged.
- **e2e:** drive calls past the cap → `BudgetExceeded`; the app stays usable (falls to Tier 1).
- **Manual:** set a tiny cap → trigger summaries → hit the cap → see the surfaced stop; Tier-1 digest
  still renders.
- **Gate:** full app gate + e2e. **Handoff:** `…-context-b3-budget-egress.md` + the ADR link.

**🚦 M-brain gate:** MAIN can summarize text through a user-chosen provider; the key is encrypted in
`userData`; spend is capped; egress is opt-in + ADR'd; no key → clean Tier-1 fallback.

---

## M-memory — `.canvas/` engine + Tier-2 autonomous loop ⛓ M-brain

**Goal:** the persistent memory — `.canvas/memory/` + the debounced summarize-on-change loop — and the
panel upgrade to show cached prose instantly on reopen.

### T-M1 — `.canvas/` engine (paths + atomic writers)
- **Repos / zones:** app — `src/main/canvasMemory.ts` (new), project create/open wiring
  (`projectStore.ts` neighbours), a `.gitignore` writer.
- **Build:** resolve `<project>/.canvas/memory/{MEMORY.md,project.md,board-<id>.md}` + `.canvas/audit/`
  (reserved). **Atomic writes** (`write-file-atomic`). On project create, write `.canvas/.gitignore`
  ignoring `.canvas/` by default, with an **opt-in to commit** (a toggle that removes the ignore).
  Read helpers for the panel (T-M4) and the deferred resource.
- **e2e:** probe writes a `board-<id>.md`, reloads, **asserts the file round-trips** + the default
  `.gitignore` is present.
- **Manual:** open a project → `.canvas/` appears with the gitignore; write a stub memory file → see it
  on disk.
- **Gate:** full app gate + e2e. **Handoff:** `…-context-m1-canvas-engine.md`.

### T-M2 — Meaningful-change detector + debounce
- **Repos / zones:** app — `src/main/memoryEngine.ts` (new; the detector half), the board-change /
  autosave signal subscription.
- **Build:** subscribe to the existing board-change signal (NOT the MCP mirror). **Meaningful change**
  = content diff (launchCommand / url / checklist items / note text) **or** terminal command-done.
  **Debounce ~30–60s.** Ignore move / resize / pan / selection. Emit a "summarize board X" intent.
- **e2e:** drive a content change → assert exactly one intent after debounce; drive a pure move →
  assert **no** intent.
- **Manual:** edit a note / toggle a checklist item → after the debounce, a log line shows the intent;
  drag a board → no intent.
- **Gate:** full app gate + e2e. **Handoff:** `…-context-m2-change-detector.md`.

### T-M3 — Tier-2 autonomous summary loop 🔒
- **Repos / zones:** app — `memoryEngine.ts` (the loop), wiring the detector (T-M2) → `llmService`
  (M-brain) → `canvasMemory` (T-M1).
- **Build:** intent → `llmService.summarize` → **atomic-write** `board-<id>.md` + refresh `MEMORY.md`
  index + `project.md`. Capture runtime **last-command + status** into the per-board memory. **Opt-in +
  gated** (off without a key / when disabled). 🔒 generated memory is **untrusted passive context** —
  it is written to disk + shown / read; it **never triggers an action**.
- **e2e:** with the **mock provider**, drive a meaningful change → **assert `board-<id>.md` content
  changed to the stub summary** and `MEMORY.md` lists the board.
- **Manual:** with a real key + loop enabled, edit a board → after debounce, `board-<id>.md` updates
  with a real summary; reopen → it's there.
- **Gate:** full app gate + e2e. **Handoff:** `…-context-m3-summary-loop.md`.

### T-M4 — Panel upgrade: cached prose on reopen
- **Repos / zones:** app — `DigestPanel.tsx` (read `.canvas/memory/` via a guarded read bridge).
- **Build:** on open, render **cached Tier-2 prose** if `board-<id>.md` exists, else fall back to the
  **Tier-1** digest (M-digest). **No LLM call on open.** A small "stale / refresh" affordance optional.
- **e2e:** seed `.canvas/memory/board-<id>.md` → open → **assert the card shows the cached prose**;
  delete it → open → **assert the card falls back to Tier-1**.
- **Manual:** open a project with existing memory → instant prose digest; open one without → Tier-1.
- **Gate:** full app gate + e2e. **Handoff:** `…-context-m4-panel-prose.md`.

**🚦 M-memory gate:** editing a board (with the loop on) refreshes its `.canvas/memory/board-<id>.md`
on a debounce; reopening shows cached prose instantly with no call; no-key projects still get Tier-1.

---

## M-expose — `canvas://memory` MCP read resource ⛓ MCP pkg 0–1 on `main` · DEFERRED

**Goal:** expose the memory to agents through one thin **read-only** resource. **Deferred** until the
MCP package (Phases 0–1) is available on `main` (it lives on `feat/mcp-integration` today). Kept here
for completeness; **do not start until the MCP wiring lands**.

### T-E1 — Read resources (index + per-board)
- **Repos / zones:** **pkg** `@ch923dev/canvas-ade-mcp` `src/resources/` (new memory resources +
  contract test); **app** Orchestrator-adapter method reading `.canvas/memory/`.
- **Build:** `canvas://memory` (MEMORY.md index + project.md) and `canvas://board/{id}/summary`
  (per-board prose). **Read-only**; no tool, no write. The adapter reads the files written by M-memory.
- **e2e:** `CANVAS_SMOKE=mcp` probe — read both resources, assert they return the on-disk memory.
- **Manual:** MCP Inspector reads `canvas://memory` and a board summary; a real agent in a Terminal
  board reads its own board's summary.
- **Gate:** app gate + `CANVAS_SMOKE=mcp` + pkg contract. **Handoff:** `…-context-e1-expose.md`.

> **Reverse cross-links (apply on `feat/mcp-integration`, not here):** in `docs/roadmap-mcp.md` note
> that **M9 best-of-N judging can call the brain directly → the judge-board pivot becomes OPTIONAL**,
> and that **M1/M10 expose memory via this resource**. That file lives only on the MCP branch, so the
> edit is staged there when M-expose is picked up.

**🚦 M-expose gate:** an agent reads the project memory read-only; memory still never drives an action.

---

## Cross-cutting (every task)

- **Every task ships an e2e probe AND a manual test, and writes a handoff doc** (standing requirement).
- **LLM is mocked in e2e** (stub summarizer; no real network in CI).
- **Never weaken security:** `contextIsolation` / `sandbox` / `no-nodeIntegration`; Browser content
  never reaches the PTY; **generated memory is untrusted passive context and never triggers an action**.
- **Key in `userData` (`safeStorage`) only — never the project folder / `.canvas/` / `canvas.json`.**
- **`.canvas/` is project data:** atomic writes, default `.gitignore`d, opt-in commit.
- **Cost control:** debounce, summarize on meaningful change only, cheap/fast default, budget cap.
- **Add an ADR** when a load-bearing decision lands (the LLM egress; later, the memory schema).
- **Coordination:** declare each sub-branch's zones on `.claude/coordination/ACTIVE-WORK.md` first.

## Follow-up (non-blocking) — `feat/context-followup` ⛓ none (M-expose stays MCP-gated)

The core subsystem (M-digest + M-brain + M-memory) shipped to `main` 2026-06-04 (`4c321c2`, PR #39). This
milestone clears the non-blocking follow-on backlog in ONE PR off `main` — NOT MCP-gated. Full kickoff:
`docs/superpowers/plans/2026-06-04-context-followup-kickoff.md`; start-here: the matching handoff in
`docs/superpowers/handoffs/`.

- **T-F1 (headline) — terminal runtime status capture.** Fold a terminal's runtime state (running/idle/
  exited + last activity) into the Tier-2 summary via the loop (MAIN-side; Tier-1 is disk-only). 🔓 Open:
  structured `pty.ts` state hook (recommended) vs scrape scrollback (resolves open-Q 2 below). ⚠️ `pty.ts`
  CROSS-ZONE with MCP #32 → sequence after MCP / keep additive.
- **T-F2** — F-C: align board `title` between `summaryLoop.boardContent` and `memoryEngine.boardFingerprint`
  (a title-only rename currently never refreshes prose).
- **T-F3** — a11y: `inert` on the `DigestPanel` `<aside>` when closed.
- **T-F4** — manual "refresh summary" per card (guarded `memory:refresh(boardId)` → loop, same key+budget gate).
- **T-F5** — re-verify `DEFAULT_MODELS` ids current; lock `llmConfig.ts` ↔ `llmModels.ts` in step.
- **T-F6** — Linux no-keyring: proactive Settings notice when safeStorage is unavailable (resolves open-Q 1).

**Out of scope here:** UI placement tweaks (deferred to after MCP) · M-expose · live `terminal:status` IPC.

## Deferred (not in this roadmap)

Multi-project / global memory · embeddings / vector search · semantic cross-board linking · any
memory-driven *write* action (forbidden) · the MCP swarm roadmap M0–M10 (sibling, `docs/roadmap-mcp.md`).

## Open questions (resolve at the relevant milestone)

1. **safeStorage on Linux without a keyring** falls back to plaintext — document the caveat (T-B2);
   decide whether to warn the user. → **being addressed in T-F6** (`feat/context-followup`).
2. **Runtime last-command/status capture** (T-M3): scrape PTY output vs a structured terminal-state
   hook — pick the lowest-coupling source when the loop is built. → **being addressed in T-F1**
   (`feat/context-followup`); recommendation = structured `pty.ts` hook.
3. **Per-provider HTTP shape** (T-B1): confirm the minimal request/response for OpenRouter / OpenAI /
   Anthropic / local; keep the adapter interface stable across them. *(resolved in M-brain T-B1.)*
```

