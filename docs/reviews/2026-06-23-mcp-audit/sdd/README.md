# MCP Feature — Spec-Driven Development Package

**Date:** 2026-06-23 · **Branch:** `research/mcp-audit` · **Derived from:** the 2026-06-23 MCP
feature audit ([`../REPORT.md`](../REPORT.md) + [`../proposals.json`](../proposals.json)).

This package turns the audit's recommendations into an **executable, spec-driven build plan**: a
catalogue of file-scoped slices, each with its own spec (problem → design → plan → tests →
acceptance), sequenced into the audit's P0–P2 waves and partitioned so parallel worktree sessions
never touch the same file.

> **What this is NOT:** code, or a commitment to build everything. It is the *spec layer* — the
> design artifacts and per-slice contracts you sign off **before** implementation (CLAUDE.md ›
> *Design artifact before code*). Pick a slice, open a `feat/*` worktree, build it against its spec,
> pass its gate, write its handoff line, merge. Repeat.

---

## 1. The methodology (how we do spec-driven dev in this repo)

Each slice follows the repo's established loop (CLAUDE.md + `docs/roadmap-mcp.md` › per-task card):

1. **Spec** — the slice's `SPEC-*.md` (in [`specs/`](specs/)). Problem (tied to an audit finding),
   goal/non-goals, design, implementation plan with **real file/function references**, schema impact,
   tests, acceptance criteria, risks, sequencing.
2. **Design artifact (UI slices only)** — an ASCII/box wireframe **inline in the spec**, matching the
   tokens in `src/renderer/src/index.css` (one accent `#4f8cff`; calm/dense; no glow/gradient). Get a
   nod on the artifact **before** writing code. (W1-A, and Wave-2/3 UI cards, carry one.)
3. **Build** — on a `feat/*` (or `fix/*`) worktree via `.claude/tools/new-worktree.ps1`, in the
   slice's declared file-zone only.
4. **Two-layer test (every MCP tool/resource/prompt)** — a **contract test** (vs the package
   `MockOrchestrator`) **and** a live `@mcp` probe in `e2e/mcp.e2e.ts` that asserts *the canvas
   actually changed*. Non-negotiable (the package's reason to exist).
5. **Gate** — `pnpm typecheck && pnpm lint && pnpm format:check && pnpm test && pnpm build`, plus the
   e2e leg (renderer-scoped → Windows leg; `src/main|preload`/`e2e`/build-config → add the Linux
   Docker leg; **full matrix once per PR at the pre-merge gate**). Package slices also run the
   package's own `pnpm test`.
6. **Manual dev check** — `$env:CANVAS_DEV_TITLE='SPEC-W?-? <slice>'; pnpm dev`, confirm the window
   title, eyeball the change live. For MCP slices: MCP **Inspector** against the loopback server +
   a **real CLI agent** in a Terminal board exercising the capability end-to-end.
7. **Handoff** — append the slice's landing line to `docs/archive/build-history.md`; update
   `ACTIVE-WORK.md`. Per doc-lifecycle, the slice's spec file may collapse to git history once merged.

---

## 2. What a "skill" IS in this product (the load-bearing decision)

The audit's centrepiece question — *what reusable "skill" should we add?* — is resolved as a
**layered answer** (REPORT §5). The SDD inherits it verbatim:

| Layer | "Skill" form | Where | Why it wins |
|---|---|---|---|
| **Primary** | **MCP prompt playbook** — a named, parameterized orchestration recipe (`prompts/list` + `prompts/get`) | the package's `registerPrompts` (today an empty stub) | agent-**agnostic** (reaches Claude/Codex/Gemini/OpenCode), in-package + versioned, **tier-gated server-side**, pure-render (a playbook's later action still pays `runGatedWrite` — a skill can *never* weaken the security model) |
| **Substrate** | **CLI-agnostic operating-manual primer** | generated from `appModel.ts`, written by the provisioner (`SKILL.md` for Claude + `AGENTS.md` for the rest) | gives every CLI the board grammar + the 3 safety rules; closes the `APP_TOOLS` drift-guard gap (F25) |
| **Human** | **Recipe templates** | Command-board SubmitWell chips, persisted to `canvas.json` | the "skill for humans": one-click dispatch presets |

**Rejected:** Claude-only `.md` skill files as the *lead* vehicle — they are Claude-only, duplicate
the prompt layer, and were the weakest design-lens in critic review. Their value survives *inside*
the primer + playbooks.

→ The **substrate** is built first: **`SPEC-W1-F`** (fill `registerPrompts` + tier-gating + 1
proof-of-life prompt + e2e). The **playbooks** themselves (review-pr, fan-out-and-compare,
triage-attention) and the **primer** are Wave-2 cards.

---

## 3. Invariants every slice must preserve

Lifted from CLAUDE.md + ADR 0003 — a spec that violates any of these is wrong by construction:

- **Loopback only.** MCP server binds `127.0.0.1`; Origin + Host + bearer triple; never `0.0.0.0`.
- **Tiers enforced server-side by token** — never by annotation/prompt. A fresh `McpServer` per
  session registers only the bearer's tier's primitives.
- **Risky cross-board PTY writes pass the single `runGatedWrite` pipeline** (sanitize → CSPRNG nonce
  → human-confirm → TOCTOU re-check → consume → two-phase write → audit). No new write path bypasses it.
- **Lethal-trifecta discipline.** Never auto-act on tainted worker/page output. Browser-board content
  never reaches the PTY write channel.
- **Tokens live in MAIN, never cross to the renderer.** `.mcp.json` is `0o600`, merge-not-clobber.
- **`contextIsolation` + `sandbox` + no `nodeIntegration`**; `node-pty`/`simple-git` only in MAIN.
- **Schema = two-tier (ADR 0007).** Additive optional field → writer bump only; new doc-level
  key/type → floor move. Most slices here are schema-neutral (the recipe-template field is additive).
- **Wire-registering a package primitive is a LOCKSTEP 3-edit change** (package `Orchestrator`
  interface + app `buildOrchestrator` binding + package `ServerFactory` registration), then
  **package release → app dep bump**, in that order. NOT a pure package patch (REPORT §7). See W1-G.

---

## 4. Slice catalogue

Each Wave-1 slice has a full spec in [`specs/`](specs/); Wave-2/3 are cards in
[`WAVE-2-3-CARDS.md`](WAVE-2-3-CARDS.md) (expand to a full spec when picked up).

### Wave 1 — P0 foundation (fixes + the skills substrate)

| Slice | Title | Findings | Type | Effort | Spec |
|---|---|---|---|---|---|
| **W1-A** | Orchestration discoverability (palette section · canonical audit shortcut · empty-board guard) | F3, F4, H1, H6 | renderer/UI | M | [spec](specs/SPEC-W1-A-orchestration-discoverability.md) |
| **W1-B** | `spawnGroup` control-char sanitizer (strip DEL + C1) | F5 | MAIN/security | S | [spec](specs/SPEC-W1-B-spawngroup-sanitizer.md) |
| **W1-C** | `configure_board` audit integrity (`denied` label · shell/cwd trace) | F6, F7 | MAIN/correctness | S | [spec](specs/SPEC-W1-C-config-audit-integrity.md) |
| **W1-D** | Shared MCP type module (`src/shared/mcpTypes.ts`) | F9 | refactor/cross-bundle | S | [spec](specs/SPEC-W1-D-shared-mcp-types.md) |
| **W1-E** | Persist `provisionedDirs` (kill stale tokens across restart) | F8 (HIGH), F22 | MAIN/security | S | [spec](specs/SPEC-W1-E-persist-provisioned-dirs.md) |
| **W1-F** | MCP prompts substrate (`registerPrompts` + e2e) — **the skills foundation** | F2, S1, S7 | package + e2e | M | [spec](specs/SPEC-W1-F-mcp-prompts-substrate.md) |
| **W1-G** | Coordinated package+app primitive release (`app-model` · `spawn_group` wire · `write_result` caps · drop dead scope) | C1, C2, C3, F10, F11, F12, F25 | package + app | M | [spec](specs/SPEC-W1-G-coordinated-primitive-release.md) |

### Wave 2 — substrate + first user-visible value (cards)

| Card | Title | Findings/proposals | Type | Needs |
|---|---|---|---|---|
| **W2-A** | `canvas-ade` operating-manual primer | S2, F25 | package-gen + provisioner | C1/C2 wired (W1-G) |
| **W2-B** | Flagship playbooks: `review-pr` + `fan-out-and-compare` | S4, S3 | package (prompts) | W1-F |
| **W2-C** | Test-connection after Sync (`orchestration:ping`) | H2, F15 | MAIN + renderer | — |
| **W2-D** | Recipe launcher (human templates) | S6, F14-adjacent | renderer + schema (additive) | W1-D |
| **W2-E** | `canvas://connectors` read-only resource | C4 | package + app | W1-D |
| **W2-F** | ADR 0010 — MCP transport security | F13 | docs/ADR | — |

### Wave 3 — P1/P2 (cards)

| Card | Title | Findings/proposals | Type | Needs |
|---|---|---|---|---|
| **W3-A** | `answer_permission` (M8) + `blocked`/`awaiting-review` emission | C5, F11-pair | package + app + MAIN | W1-G (re-add scope) |
| **W3-B** | Attention queue badge + panel (M5-T5.4) | H3, F24 | renderer | feed exists |
| **W3-C** | Cancel queued task | H4, F17 | renderer | — |
| **W3-D** | `get_changed_files` + diff coloring | C6, H5, F16 | package + renderer | — |
| **W3-E** | `await_settled` event-driven refactor (drop the 1s poll) | C7, F19 | MAIN | — |
| **W3-F** | Copy/rebrand + residual hardening | H7, F14, F26, F18, F21, F23, F20 | renderer + MAIN | — |

**Deferred (not scheduled here):** **M6 Feature Workspaces** (git worktrees). It gates M7 (commit/
merge), M9 (best-of-N), M10 (task graph + stateless RC). Everything in Waves 1–3 is **pre-M6 by
design**. M6 needs a concrete start date to resolve the CLAUDE.md ("deferred post-MCP") vs
`roadmap-mcp.md` ("M6 *is* the roadmap") ambiguity (REPORT §8, open question 1). The
`judge_outputs` and `canvas://tasks`/task-graph proposals were **killed** by the critics (REPORT §8)
— do not build them speculatively.

---

## 5. Build sequence & parallelization

**Run ~4 worktrees at a time, file-disjoint** (CLAUDE.md › Parallel sessions). Within Wave 1 there
are two real file collisions and two ordering deps — respect them:

```
W1-D (shared types)  ───────────────┐  do FIRST: it repoints AuditLogViewer.tsx (collides W1-A)
   (blocker for W2/W3 command vars)  │  and is the single-source-of-truth all later variants build on
                                     ▼
        ┌──────────────┬─────────────┴───────────────┐
   W1-A (renderer)  W1-B (mcpLifecycle)   W1-E (cliProvisioners)   ← parallel: file-disjoint
        │                  │
        │                  ▼
        │            W1-C (mcpOrchestrator) ──┐  W1-C & W1-G both edit mcpOrchestrator.ts →
        │                                     │  sequence C before G (or coordinate the file)
        │            W1-F (package + e2e) ────┤  W1-F & W1-G are both package changes →
        │                                     ▼  co-release as ONE package bump (recommended)
        └────────────────────────────────▶ W1-G (package wire + app)   ← needs W1-B merged (sanitizer)
```

**Collision/dependency matrix (Wave 1):**

| Slice | Edits (key files) | Collides with | Hard dep |
|---|---|---|---|
| W1-D | `src/shared/mcpTypes.ts` (new), `mcpCommand.ts`, `useMcpCommands.ts`, `planningMcpApply.ts`, `AuditLogViewer.tsx`, `auditLog.ts`, tsconfigs | **W1-A** (`AuditLogViewer.tsx`) | — (do first) |
| W1-A | `commandRegistry.ts`, `useCanvasKeybindings.ts`, `AuditLogViewer.tsx`, `CommandBoard.tsx`, new `auditLogStore` | **W1-D** | merge after W1-D |
| W1-B | `mcpLifecycle.ts`, `dispatchSanitize.ts`, `mcpLifecycle.test.ts` | — | — (ship anytime) |
| W1-C | `mcpOrchestrator.ts`, tests | **W1-G** | — |
| W1-E | `cliProvisioners/index.ts`, `orchestrationProvision.ts`, consent path, new `provisionedDirStore.ts` | — | — |
| W1-F | pkg `src/prompts/` + `ServerFactory`; `e2e/mcp.e2e.ts` | **W1-G** (same pkg) | — |
| W1-G | pkg `Orchestrator`/`ServerFactory`/Zod/scopes; `mcp.ts`, `mcpOrchestrator.ts`, `appModel.ts` | **W1-C**, **W1-F** | **W1-B merged**; package-release-before-app-bump |

**Recommended order:** `W1-D` → (`W1-A`, `W1-B`, `W1-E` in parallel) → `W1-C` → package bump
bundling `W1-F` + `W1-G` (after W1-B is merged) → app dep bump. Then Wave 2, then Wave 3.

---

## 6. Definition of Done (per slice)

A slice is done when **all** hold:

- [ ] Spec's acceptance-criteria checklist is satisfied.
- [ ] Gate green: `typecheck · lint · format:check · test · build`.
- [ ] e2e green for the touched scope (full matrix at the pre-merge gate).
- [ ] **MCP slices:** contract test **and** live `@mcp` probe asserting the canvas changed; manual
      Inspector + real-CLI check done.
- [ ] **UI slices:** design artifact signed off; manual dev check with the `CANVAS_DEV_TITLE` stamp.
- [ ] **Package slices:** package `pnpm test` green; **package released before the app dep bump**.
- [ ] No locked invariant (§3) weakened; no new finding introduced.
- [ ] Handoff line appended to `docs/archive/build-history.md`; `ACTIVE-WORK.md` updated.

---

## 7. Coverage map (audit finding → slice)

Every actionable audit finding is assigned. (Killed proposals — REPORT §8 — are intentionally absent.)

| Findings | Slice |
|---|---|
| F3, F4 (+H1, H6) | W1-A |
| F5 (C2 sanitizer half) | W1-B |
| F6, F7 | W1-C |
| F9 | W1-D |
| F8, F22 | W1-E |
| F2 (S1, S7) | W1-F |
| F10, F11, F12, F25 (C1, C2-wire, C3) | W1-G |
| S2 | W2-A |
| S3, S4 | W2-B |
| F15 (H2) | W2-C |
| S6 | W2-D |
| C4 | W2-E |
| F13 | W2-F |
| C5 (M8) | W3-A |
| F24 (H3) | W3-B |
| F17 (H4) | W3-C |
| F16 (C6, H5) | W3-D |
| F19 (C7) | W3-E |
| F14, F26, F18, F21, F23, F20 (H7) | W3-F |
| F1 (M6–M10 unbuilt) | **Deferred** — needs an M6 start date (REPORT §4, §8) |
| S5 (triage-attention playbook) | W3-A-adjacent (richens once `blocked` emits) |
