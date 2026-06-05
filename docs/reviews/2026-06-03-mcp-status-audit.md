# canvas-ade-mcp — status & risk audit (2026-06-03)

**Method:** read both app-side MCP branches (`feat/mcp-main-wiring`, `feat/mcp-board-listing`) and the
sibling package repo `Z:\canvas-ade-mcp` (`@expanse-ade/mcp` v0.2.0) in full. Cross-checked
against memories `canvas-ade-mcp`, `mcp-spec-state-2026-06`, the two design specs, and current `main`.
**Read-only — no code changed.** Audit requested by the user ("deep-audit first").

---

## TL;DR

- **Package** (`Z:\canvas-ade-mcp`): healthy, Phases **0–1 shipped**, v0.2.0 published to GitHub
  Packages. Clean, well-isolated SDK usage. Phases **2–9 unbuilt**.
- **App integration** (this repo): **fully coded** across two branches but **stranded on a ~3-week-old
  fork base** (`55d48ed`, PR #3). Never merged. Bitrotting. Real payload is ~10 small files; the
  blocker is the **stale base**, not the code quality (the code is clean + defensive).
- **One real security gap**: the package validates the **Origin** header but **not the Host header** —
  the exact DNS-rebinding mitigation the spec marks MANDATORY (and Expanse's Browser-board attack
  vector). Bearer-auth is a backstop, but this needs a fix + ADR before any real-world use.
- **One known migration debt**: transport is **stateful** (`Mcp-Session-Id`); the 2026-07-28 spec RC
  goes stateless. Not urgent (12-month overlap → ~mid-2027), and the transport is isolated to one file.

---

## 1. Two-repo layout

| Repo | Role | State |
|---|---|---|
| `Z:\canvas-ade-mcp` (sibling) | The MCP server **package** `@expanse-ade/mcp`. ESM-only library exporting `createMcpHttpServer(deps)` + auth helpers. Published to GitHub Packages. | v0.2.0; Phases 0–1 done |
| `Z:\Canvas ADE` (this repo) | **Consumer** — hosts the server in Electron MAIN, feeds it a board registry. | code on 2 stale branches, unmerged |

The app consumes the package as `@expanse-ade/mcp` from **GitHub Packages** (`^0.2.0`).
> ⚠️ Memory `canvas-ade-mcp` says "consumed as a local `file:` / path dependency." **Outdated** — the
> branches switched to the published GitHub-Packages dep (commit `f0aa561`: "no sibling repo on CI
> runner"). Memory should be updated.

---

## 2. Package state — `Z:\canvas-ade-mcp` v0.2.0

### Source map (16 files)
```
src/auth/{mint,scopes,tokens,verifier}.ts   per-board bearer tokens, tier→scope map
src/config/mcpJson.ts                        .mcp.json writer (buildMcpJson/writeMcpJson)
src/security/origin.ts                       Origin-allowlist DNS-rebind guard
src/server/{mcpHttp,factory,transport}.ts    express app · per-session McpServer factory · transport map
src/orchestrator/{Orchestrator,mock}.ts      Orchestrator interface + a mock for contract tests
src/resources/boards.ts · src/prompts/index.ts · src/constants.ts · src/types.ts · src/index.ts
```
Tests: 6 contract + 4 live (`test/{contract,live}`). Stack: SDK `1.29.0` (correct — npm `latest`),
express 5, zod 4, tsup build, vitest.

### Phase ledger (from the package `docs/roadmap.md`)
| Phase | Capability | State |
|---|---|---|
| 0 | Scaffold + streamable-HTTP transport, Origin 403, loopback bind, proof tools | ✅ shipped |
| 1 | Auth + capability **tier-factory** (per-board bearer, orchestrator vs worker scopes, `.mcp.json` writer) | ✅ shipped |
| 2 | Observation resources (`canvas://board/{id}/output`, size-capped/paginated) | ❌ |
| 3 | Lifecycle tools (spawn/destroy boards) | ❌ |
| 4 | Dispatch (first dangerous tool) 🔒 | ❌ |
| 5 | Barriers + event-driven attention queue | ❌ |
| 6 | Git tools (board-scoped) 🔒 ⛓ app Phase 3 | ❌ |
| 7 | `answer_permission` 🔒 | ❌ |
| 8 | Best-of-N + integration queue | ❌ |
| 9 | Hardening + coordination layer + packaging 🔒 | ❌ |

### Architecture quality — strong
- **Capability tiers enforced server-side** by a per-session `ServerFactory` that registers only the
  token's tier's tools (never by annotation/prompt). Token is the sole authority (`ctxFromAuth`
  re-derives tier/boardId from the verified bearer). This is the right design.
- **Transport isolated** to `server/transport.ts` (single SDK-transport import) — a deliberate seam so
  the eventual SDK-v2 / stateless migration is a one-file change.
- **Graceful loopback**: `listen(0, '127.0.0.1')`, allowlist set after the ephemeral port resolves.
- Uncommitted WIP in the package: `docs/research/mcp-swarm-research.md` (modified) + new
  `mcp-client-connection-matrix.md`. Research, not code — but it's dirty; commit or stash before any
  release work.

---

## 3. App-side integration — the two branches

Both fork from `55d48ed` (**PR #3 merge**). `board-listing` is **stacked on `main-wiring`** — it
contains all 8 wiring commits **plus** 10 of its own. So **`feat/mcp-board-listing` is the superset**;
auditing/landing it covers both.

### What `feat/mcp-main-wiring` adds (8 commits)
- `src/main/mcp.ts` — `startMcpServer(registry)`: dynamic-`import()`s the ESM package from CJS MAIN,
  mints an `orchestrator`-tier app token, calls `createMcpHttpServer`, returns a handle
  (`port`/`tokens`/`mintWorkerToken`/`close`). Graceful-degrade on bind failure, but **loud on a real
  wiring bug** (distinguishes `EADDRINUSE`/`EACCES` from defects). Clean.
- `src/main/mcpOrchestrator.ts` — pure adapter (type-only package imports → contract test needs no
  node-pty). `spawnBoard`/`dispatchPrompt`/`gitDiff` throw phase-gated errors.
- `src/main/pty.ts` — `listPtySessions()` read accessor + a `state: PtyState` field per session.
- `index.ts` wiring: start in `app.whenReady`, `close()` in `shutdown()` (null-safe, drained alongside PTYs).
- `mcpSmoke.ts` + `CANVAS_SMOKE=mcp` live tier-enforcement smoke (boots the real app, connects two
  clients, asserts orchestrator sees `orchestrator_ping` and worker is denied).

### What `feat/mcp-board-listing` adds on top (10 commits)
- `src/main/boardRegistry.ts` — renderer→MAIN board-snapshot mirror. **Well-hardened**:
  sender-guarded IPC (`isForeignSender` pattern), `sanitizeSnapshot` bounds the payload
  (`MAX_BOARDS=500`, `MAX_FIELD_LEN=256`), drops malformed entries, leaves `type` an open string for
  forward board types.
- `mcpOrchestrator.ts` generalized from PTY-only → **mirror-backed** (`listBoards()` returns all three
  board types; PTY status overlaid only on terminals; `browser`→`'open'`, `planning`→`'static'`,
  unknown→`'unknown'`).
- `src/renderer/src/store/useMcpPublish.ts` — debounced (150 ms) hook; publishes `{id,type,title}` on
  every `boards` change; warns once if the preload bridge regressed.
- `preload/index.ts` — `api.mcp.publishBoards` (send-only, metadata-only).
- Package bumped to `^0.2.0` (`BoardSummary.title`).

### Code-quality verdict: high
Defensive, well-commented, security-conscious (sender guards, payload bounds, metadata-only snapshots,
phase-gated throws). This is **not** the risk. The risk is entirely the stale base.

---

## 4. Risks

### R1 — Stale fork base (HIGH, the headline risk)
Both branches predate PRs #12–24. `git diff main..origin/feat/mcp-board-listing` = **~9.8k insertions /
16k deletions** — almost all **phantom**: the branch shows #24's `e2e/` folder split, `feature-proposals.md`,
the round-3 docs, Phase 3/4 work etc. as "removed" because it forked before they landed. Real MCP
payload is ~10 files. **Conflict hotspots on rebase**: `src/main/index.ts`, `src/main/pty.ts`
(refactored on main since the fork), `preview.ts`, `canvasStore.ts`, `App.tsx`, and a fully-diverged
`pnpm-lock.yaml`. Every day on `main` widens the gap. **This decays fastest — act first.**

→ **Recommendation:** a **clean re-port** is likely lower-risk than a rebase. Cut a fresh branch off
current `main`, re-apply the ~10 MCP files (they're mostly additive/new files: `mcp.ts`,
`mcpOrchestrator.ts`, `boardRegistry.ts`, `mcpSmoke.ts`, `useMcpPublish.ts` are net-new and won't
conflict), and hand-merge the 3 touch-points (`index.ts` boot/shutdown wiring, `pty.ts`
`listPtySessions`+`state`, `preload/index.ts` `mcp` bridge) against today's code. Re-run gate +
`CANVAS_SMOKE=mcp`. Then re-add the GitHub-Packages dep + regenerate the lockfile from current main.

### R2 — Host-header allowlist missing (MEDIUM-HIGH security, the flagged gap)
`src/security/origin.ts` validates the **Origin** header (allowlist `http://127.0.0.1:<port>` /
`http://localhost:<port>`, else 403; **no-Origin requests pass** — by design, for CLI clients). But
memory `mcp-spec-state-2026-06` (cited deep-research) says the MANDATORY DNS-rebinding mitigation is a
**Host-header allowlist** — loopback bind + Origin check alone is **insufficient** (TS-SDK
CVE-2025-66414, fixed upstream in sdk 1.24.0; rmcp CVE-2026-42559 CVSS 8.8). **Expanse's exact attack
vector**: a Browser board previewing a malicious `localhost` page. Bearer-auth is a real backstop (a
Browser board has no token and no preload to obtain one → 401), so this is **defense-in-depth, not an
open hole today** — but the spec marks Host validation a MUST and it's cheap.

→ **Recommendation:** add a Host-header guard in the package (`Host ∈ {localhost,127.0.0.1,::1}[:port]`
→ 403) beside `originGuard`, plus a contract test, and **write the ADR** memory already calls for.

### R3 — Stateful transport vs the 2026-07-28 stateless RC (LOW, scheduled debt)
`server/transport.ts` is stateful (`Mcp-Session-Id` + a transport map). The 2026-07-28 spec RC
(SEP-2567) removes protocol sessions. **Not urgent** — 12-month overlap (SEP-2596) keeps 2025-11-25
sessions valid until ~mid-2027, and the transport is isolated to one file by design. Track, don't act.

### R4 — Phase-8 judging design is broken as written (LOW, future-phase)
Memory `mcp-spec-state-2026-06`: sampling is deprecated 2026-07-28 **and** Claude Code never
implemented MCP sampling → the planned `judge_outputs`-via-sampling can't work against Claude Code.
Pivot (already noted in memory): deterministic `register_gate` + a "judge board" (spawn a terminal
agent as judge). Only bites at Phase 8 — flag it in that phase's spec.

### R5 — Branch sprawl / coordination drift (LOW, hygiene)
`.claude/coordination/ACTIVE-WORK.md` still lists both MCP worktrees as **active** (2026-06-01), but
the branches are stale and untouched since. The board is misleading. Reconcile after deciding R1.

---

## 5. Recommended sequence

1. **Decide R1 disposition** — clean re-port (recommended) vs rebase vs abandon-and-rebuild. Whichever,
   land the MAIN-wiring + board-listing capability on `main` so it stops rotting. It's good code.
2. **R2 before any real use** — Host-header guard + ADR in the package; bump + republish; consumer picks
   up the new version during the re-port.
3. **Then resume package Phase 2** (observation resources `canvas://board/{id}/output`, capped) on a
   current, merged base.
4. Update memories: `canvas-ade-mcp` (now GitHub-Packages dep, not `file:`; Phase 1 also shipped) and
   reconcile the coordination board (R5).

**Verification commands** (for whoever lands R1):
```
pnpm test ; pnpm typecheck ; pnpm lint        # app gate
pnpm build; $env:CANVAS_SMOKE='mcp'; pnpm start  # live MCP tier smoke → MCP_LIST_OK / MCP_TIER_OK / MCP_DONE
# package: cd Z:\canvas-ade-mcp ; pnpm test ; pnpm test:live
```
None of this gates a current `main` release — the MCP layer is additive and not yet on `main`.
