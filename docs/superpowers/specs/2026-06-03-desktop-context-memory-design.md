# Desktop Brain + Project Memory — design spec (2026-06-03)

> **Status:** approved design (brainstorming pass, 2026-06-03). Sibling of the MCP roadmap, **not part
> of it**. Ships **before / independent of** MCP off a standalone `feat/context` branch (base `main`).
> Companion: the task-card roadmap `docs/roadmap-context.md`.

## 1. What & why

Give the **desktop itself** (Electron MAIN) a small LLM brain + a persistent **project memory**, so that
reopening a project yields an **instant context digest** — "what is each board doing" — **without reading
every board** and **without any agent or MCP session running**.

The win the user called the best of the product: open a project, immediately see a summary of every
board's state and intent, reconstructed from memory rather than by re-reading everything.

## 2. Locked decisions (not re-litigated; carried from 2026-06-03)

- **Separate from MCP, one-way dependency.** Brain + memory are standalone MAIN subsystems. MCP does not
  own them; MCP only *exposes* memory through one thin read resource (`canvas://memory` /
  `canvas://board/{id}/summary`). They work with **zero agents and zero MCP session**. Built in the
  `canvas-ade` app, **not** in the `@ch923dev/canvas-ade-mcp` package (the package stays pure:
  agents↔canvas).
- **Two tiers, cheap first.**
  - **Tier 1 — no LLM, no key.** A structured heuristic digest from data already on disk. The app fully
    works at Tier 1 with no key.
  - **Tier 2 — LLM brain.** Real semantic per-board summaries, cached into `.canvas/memory/`, refreshed
    on meaningful change, shown instantly on reopen (cached prose, no call on open).
- **Autonomous loop.** Board changes (debounced) → MAIN asks the LLM to summarize → writes
  `board-<id>.md`. On reopen → read `.canvas/memory/` → digest panel (instant). Optional, gated.
- **Provider-agnostic + graceful degradation.** OpenRouter default (one key, many models); also
  OpenAI / Anthropic / a local endpoint. No key → Tier 1 only. Never hard-depend on any provider.

## 3. Settled open choices (this brainstorm)

| Choice | Decision |
|---|---|
| Default model | **Cheap/fast class** via OpenRouter (e.g. a Flash/Haiku-tier model). User-overridable. Summaries are short + frequent → keep spend low. |
| Meaningful-change heuristic | **Content diff + command-done, debounced ~30–60s.** Re-summarize when persisted content changes (launchCommand / url / checklist items / note text) **or** a terminal command completes. Ignore move / resize / pan / selection / cursor. |
| Reopen digest UX | **Auto slide-in side panel** of per-board cards on project open; dismissible to the canvas; non-blocking. |
| `canvas://memory` shape | **Index + per-board.** `canvas://memory` (MEMORY.md index + project.md) and `canvas://board/{id}/summary` (one board's prose). |
| Key-entry UX | **Settings modal → `safeStorage`-encrypted, stored in `userData`.** Never the project folder. |
| Base branch | **`feat/context` off `main`** — standalone, ships ahead of MCP. |
| Build order | **Digest first** → brain → memory → expose. |
| M-expose | **Deferred to post-MCP** (gated on MCP package 0–1 landing on `main`); kept in the roadmap, marked gated. |

## 4. Architecture — four MAIN units, one-way dep

```
canvasStore (renderer) ──save/board-change signal──▶ MAIN
                                                      │
   ┌───────────────────────────────────────────────────┼───────────────────────────┐
   │ llmService.ts          memoryEngine.ts             digest.ts (shared/renderer)  │
   │ provider-agnostic       Tier-2 loop:               Tier-1 heuristic:            │
   │ adapter (OpenRouter      debounced meaningful       canvasDoc → DigestModel     │
   │ default; OpenAI /        change → summarize →       (NO LLM, NO key, pure)      │
   │ Anthropic / local)       write board-<id>.md                                    │
   │   ▲ key via safeStorage (userData)                                              │
   │   │ + budget guard                                                              │
   └───┼─────────────────────────────────────────────────┼──────────────────────────┘
       │                                                  │
   outbound LLM call                          <project>/.canvas/memory/*.md
   (NEW egress — opt-in, ADR-gated)           (atomic write, default .gitignore)
                                                          │
                            MCP read-only (DEFERRED) ─────┘
                            canvas://memory · canvas://board/{id}/summary
```

- **One-way:** MCP imports memory (read resource). Memory never imports MCP.
- **Lives in app `src/main/`**, not the package.

## 5. Components

### 5.1 `digest.ts` (Tier 1 — pure, shared)
`buildDigest(canvasDoc) → DigestModel` — a pure transform, no React / Zustand / network / key. Reads
only what's persisted in `canvas.json`:
- **terminal:** `launchCommand`, `cwd`, `port`, + linked-preview presence.
- **browser:** `url`, `viewport`, `previewSourceId` (which terminal feeds it).
- **planning:** per checklist `title` + `done/total`; note count.

> **Disk-only limit (noted):** terminal **last-command + live status are runtime-only** — they are
> *not* in `canvas.json`. Tier-1-from-disk therefore covers launchCommand / url / checklist / notes /
> link. Last-command + status are captured into memory by the **Tier-2 loop** (§5.3), not by Tier-1.

`DigestModel` = `{ boardId, type, title, status, lines: string[] }[]` + a project-level header line.
Always available; the digest panel renders it when no Tier-2 prose exists.

### 5.2 `llmService.ts` (Tier 2 — provider-agnostic brain)
- `summarize(input) → string`. Provider + model in `userData` config; **API key in `safeStorage`**
  (encrypted). Default model = cheap/fast class (OpenRouter), user-overridable.
- Providers: OpenRouter (default), OpenAI, Anthropic, local endpoint. One small adapter interface;
  one HTTP shape per provider.
- **Budget guard:** per-day token/call cap; hard-stop when hit; surfaced in the UI; never silently
  overspends the user's key.
- **Graceful degrade:** no key / provider down / budget hit → throw a typed `NoProvider` /
  `BudgetExceeded` → callers fall back to Tier 1. The app never blocks on the brain.

### 5.3 `memoryEngine.ts` (Tier 2 loop — owns `.canvas/`)
- Subscribes to the existing board-change / autosave signal (not the MCP mirror).
- **Meaningful-change detector:** content diff (launchCommand / url / checklist items / note text) or
  terminal command-done; **debounced ~30–60s**; ignores geometry/selection.
- On trigger → `llmService.summarize` → **atomic-write** `board-<id>.md`; refresh `MEMORY.md` index +
  `project.md`. Captures runtime **last-command + status** into the per-board memory (the bit Tier-1
  can't see).
- **Opt-in + gated:** off without a key (Tier-1 only); on only when a provider is configured and the
  loop is enabled.

### 5.4 Digest panel (renderer)
- On project open, **auto slide-in side panel** of per-board cards. Renders **cached Tier-2 prose** if
  `.canvas/memory/board-<id>.md` exists, else the live **Tier-1** digest. **No LLM call on open.**
- Dismissible to the canvas; re-openable from app chrome.

## 6. `.canvas/` layout (project data)

```
<project>/.canvas/
  memory/
    MEMORY.md        # index (one line per board → board-<id>.md)
    project.md       # high-level project digest
    board-<id>.md    # per-board summary (Tier-2 prose)
  audit/             # reserved — MCP dispatch audit log lands here later
```

- **Project data** (travels with the project). **Atomic writes** via `write-file-atomic` (same path as
  `canvas.json`). **Default `.gitignore`d** (private), with an **opt-in to commit**.
- Holds **OUTPUT only.** The **API key is never here** — key is app/user config in `userData`
  (`safeStorage`). (Locked persistence rule: project data in the project folder, app config in
  userData — never cross.)

## 7. Data flow

- **Reopen (instant):** open project → renderer reads `.canvas/memory/` → panel. No memory yet →
  compute Tier-1 from the just-loaded `canvas.json` on the spot. **No LLM call on open.**
- **Autonomous loop (opt-in):** board-change signal → debounce → meaningful? → `summarize` →
  atomic-write. Off without a key.

## 8. Error handling & safety

- **Graceful degrade everywhere:** no key / provider error / budget hit → Tier 1; never block the app.
- **Injection (lethal-trifecta).** Board content (browser page text, terminal scrollback) flows **into**
  the LLM. **All generated memory is UNTRUSTED, PASSIVE context** — display + MCP-read only. **Memory
  never auto-triggers an action.** `contextIsolation` / `sandbox` / `no-nodeIntegration` untouched;
  Browser content never reaches the PTY write channel.
- **New egress.** MAIN → the chosen LLM endpoint is a **new outbound call** — the one new egress beyond
  loopback. It is **opt-in** (no key, no call) and **ADR-documented** (`docs/decisions/`). Loopback
  model otherwise unchanged.
- **Cost control.** Debounce; summarize only on meaningful change; cheap/fast default model; per-day
  budget cap. It is the user's key/spend but it is guarded.

## 9. MCP exposure (DEFERRED — one-way, read-only)

`canvas://memory` (MEMORY.md index + project.md) and `canvas://board/{id}/summary` (per-board) —
**index + per-board** shape. **Read resources only**, fed by an app adapter that reads
`.canvas/memory/`. Gated on the MCP package (Phases 0–1) being available on `main`; tracked as the
deferred **M-expose** milestone. The reverse cross-links into `docs/roadmap-mcp.md` (M9 judge-board
pivot becomes optional; M1/M10 note memory exposure) are an **MCP-branch-side edit** (that file lives
only on `feat/mcp-integration`).

## 10. Testing (standing requirement, per task)

Every task card carries: **Build · e2e (a `CANVAS_SMOKE` probe asserting the digest/memory *actually
changed*) · Manual (explicit steps) · Gate (typecheck/lint/format/test/build) · Handoff doc** written
after the task → `docs/superpowers/handoffs/<date>-context-<task>.md`.

- The LLM is **mocked** in e2e (a stub summarizer; no real network) — the probe asserts the loop writes
  the expected `board-<id>.md`, not model quality.
- Tier-1 digest is unit-tested as a pure function over crafted `canvas.json` docs.

## 11. Out of scope (this subsystem)

- Multi-project / global memory, embeddings / vector search, semantic cross-board linking.
- Any *write* action driven by memory (forbidden by §8).
- The MCP swarm roadmap (M0–M10) — separate, sibling.
```

