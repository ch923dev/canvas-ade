# In-depth review — MCP layer (2026-06-05)

**Scope:** the MCP integration end-to-end — app-side (`main`) + the server package
`@ch923dev/canvas-ade-mcp` v0.8.2 (`Z:\canvas-ade-mcp`).
**Method:** read the meta-review backlog (status audit, bug-hunt cards, fix-report, consolidated
backlog) to establish claimed state, then **two independent adversarial code-reads** (app-side on a
read-only `main` worktree; server pkg with deps installed) that re-derived every claimed fix from
`file:line` rather than trusting the reports, plus a fresh hunt for what the prior 122-agent run
missed. **Read-only — no code changed.** Live state reconciled via `git`/`gh`.

---

## TL;DR

**MCP layer is healthy. No open Critical/High/Medium.** Everything in the 2026-06-04 backlog is
**merged to `main`** and the fixes are **real** (verified in code, not just claimed). The old
MEDIUM-HIGH Host-header DNS-rebind gap is **closed**. The fresh pass surfaced only **3 LOW + INFO**
items the big hunt missed — none block release. The MCP layer is ready to build forward (server pkg
Phases 5–9); the de-facto release blocker is the unrelated Electron 33→42 bump (T9).

---

## 1. Live state — what's actually on `main` (2026-06-05)

The 2026-06-05 kickoff doc was drafted **before** the day's merges and is stale on PR status. Git/gh
ground truth:

| PR | Title | State |
|----|-------|-------|
| #43 | Land MCP integration (M0–M4) onto context-bearing main | ✅ merged (`2100022`) |
| #44 | context follow-up — terminal runtime status + polish | ✅ merged |
| #45 | close 2 bug-hunt **Highs** — LLM SSRF + MCP configureBoard confirm | ✅ merged (`63365bd`) |
| #47 | 8 bug-hunt **Mediums** | ✅ merged (`1fbc272`) |
| #48 | 18 bug-hunt **Lows** | ✅ merged (`e2255b5`) |
| #49 | adopt canvas-ade-mcp **0.8.2** + bind relay to command board | ✅ merged (`8a41a5d`) |
| #53 | Waves 0/2/4 (data-loss · SCA/runtime · reliability) | ✅ merged |

App pins `@ch923dev/canvas-ade-mcp ^0.8.2`, SDK `^1.29.0`. `mcp.ts:52` passes `commandBoardId:'app'`
(BUG-021 pt2 adopted). CI billing-block cleared; `NODE_AUTH_TOKEN` wired into CI workflows.

Server pkg `@ch923dev/canvas-ade-mcp` is at **0.8.2** (`027f528`; BUG-021 pt2 relay caller-binding
merged via pkg PR #2).

## 2. Verification — the bug-hunt fixes are real

All **11 in-scope MCP fixes** claimed by `FIX-REPORT.md` were re-derived from code and are
**PRESENT + CORRECT** (not weak, not missing):

- **BUG-002** (High) configureBoard `launchCommand` → `sanitizeDispatchText` + fail-closed
  `registry.confirm` + audit; empty/shell-only patches pass through. `mcpOrchestrator.ts:305-362`.
- **BUG-008** handoff await-idle re-resolves live board each tick. `:498-522`.
- **BUG-009** closeBoard frees slot in `finally`; reapIdle per-id try/catch. `:252-254, :283-292`.
- **BUG-010** confirm 10-min backstop timeout; `Infinity`/`≤0` opts out. `mcpConfirm.ts:45,68,101`.
- **BUG-020** dispatch nonce evicted on all deny paths. `:437,592,724,842,748`.
- **BUG-021 pt1** relay cable TOCTOU re-check. `:742-760`.
- **BUG-022** confirm reply-channel = `randomUUID()`. `mcpConfirm.ts:74`.
- **BUG-023** `mcp.ts` rejects non-positive idle-reap TTL/interval env. `mcp.ts:13-20`.
- **BUG-024** audit serialized append, failed write keeps seq (no gap/interleave). `auditLog.ts:144-163`.
- **BUG-025** audit wired before `startMcpServer`. `index.ts:175-176`.
- **BUG-026** null-guard `localServer` in SMOKE=exit. `index.ts:285`.

**Core security properties confirmed:**
- **Dispatch path** (the trust boundary the agent talks to): opaque-id resolve → terminal-only →
  `sanitizeDispatchText` (rejects CR/LF + C0 controls) → single-use nonce → mandatory fail-closed human
  `confirm` → audit → PTY write. No dispatch/launchCommand text reaches the PTY write channel without
  all five. `writeToPty`/`drainPty` are MAIN-only, never bridged.
- **Tier model** enforced **structurally** server-side: a per-session `ServerFactory` registers only the
  token's tier's tools; `ctxFromAuth` re-derives `{tier,boardId}` from the verified bearer — the client
  cannot forge or supply a boardId. Proven at both `tools/list` and `tools/call`.
- **Host-header DNS-rebind guard** — the 2026-06-03 audit's MEDIUM-HIGH gap — is **CLOSED**:
  `security/host.ts` (`hostGuard()` mounted first, 403 on non-loopback/missing Host, handles `:port`,
  bracketed IPv6, full `127.0.0.0/8`, rejects `localhost.evil.com` suffix attack) + ADR `0003` +
  contract & live tests. SDK 1.29.0 is past the CVE-2025-66414 (1.24.0) fix.
- Tokens: 256-bit random opaque capabilities in an in-memory store, mandatory expiry, immutable
  tier/scope per mint — sound for the single-user loopback model. No escalation path.

## 3. New findings (fresh pass — missed by the prior hunt)

All **LOW / INFO. None block release.**

| # | Sev | File:line | Issue | Fix |
|---|-----|-----------|-------|-----|
| APP-N1 | Low | `mcpOrchestrator.ts:345-350` | configureBoard: human **approves** but the renderer ack fails → throws with **no audit entry** (neither `configured` nor `rejected`/`failed`). Asymmetric — every other dispatch path audits a `failed` write. Forensic gap on the exact path BUG-002 hardened. | Emit a `status:'failed'` audit line before the throw (mirror the dispatch handlers). ~1 line. |
| APP-N2 | Low | `mcp.ts:56` · `mcpOrchestrator.ts:256-294` | `reapIdle` is re-entrant-unsafe: the 60s `setInterval` and the smoke's explicit `mcp.reapIdle()` can overlap (each close awaits drain + a renderer round-trip), so two sweeps can both read the same id and `closeBoard` runs twice. Benign (close is idempotent) but wasteful + can re-arm `idleSince` on a deleted record. | `let sweeping=false` guard — skip a tick if a sweep is in flight. |
| PKG-N1 | Low | `transport.ts:23-72` | Session reuse (POST-reuse / GET / DELETE) is routed purely by the `Mcp-Session-Id` header; the handler never asserts the caller token's `boardId` **owns** that session. Latent confused-deputy / cross-session edge. Exploitability **very low** (loopback-only behind Host+Origin+bearer, unguessable UUID, single-user). The pkg roadmap already earmarks this for Phase 9. | Stash the creating `ctx.boardId` beside the transport; reject a reuse/GET/DELETE whose token boardId differs. |
| APP-N3 | Info | `mcpOrchestrator.ts:219-240` | `spawnBoard` forwards `input.type` verbatim; the `SPAWNABLE` allowlist check is renderer-side only. Correct today (renderer rejects off-type), but the adapter is the trust boundary — a one-line allowlist there would make spawn defense-in-depth match dispatch. | Optional adapter-side type allowlist. |
| PKG-N2 | Info | `test/helpers/httpServer.ts:21` | The BUG-021 `commandBoardId` relay gate is contract-tested (in-memory factory) but **never driven over real HTTP** (the test server never passes `commandBoardId`). Wiring is unverified by the two-layer gate the roadmap mandates. | Add a live test: two orchestrator tokens, assert the non-command one is rejected over HTTP. |

Everything else adversarially checked came back clean: confirm gate is unbypassable (MAIN owns the
decision, frame-guarded reply, CSPRNG channel, FIFO queue); no worker-tier path reaches an
orchestrator capability; dynamic `import()` failure handling + handle teardown are correct; every pkg
tool has a zod schema; output resources are hard-capped (25k/page); body capped at 1 MB; no error-body
/ stack leakage; transport session-fixation is prevented (server-minted UUID on init).

## 4. What's left (MCP)

- **Server pkg Phases 5–9 unbuilt** (`Z:\canvas-ade-mcp\docs\roadmap.md`):
  - **M5 — Barriers + event-driven attention** (next): SSE `notifications/resources/updated` on
    `canvas://attention`, **not** polling. Attention buckets (`blocked`/`awaiting-review`) exist as
    passive shells; M5 wires their detection.
  - M6 git tools (board-scoped) ⛓ app Phase 3 · M7 `answer_permission` · M8 best-of-N + integration
    queue · M9 hardening/coordination/packaging.
- **Electron 33 → 42 (T9)** — release blocker, plan written
  (`docs/superpowers/plans/2026-06-04-electron-bump-t9.md`), **not executed**. Gating risk = node-pty
  ABI rebuild vs Electron 42 (pinned `1.2.0-beta.13` winpty-free because the repo path has a space).
  Not MCP, but gates shipping.
- **Scheduled debt** (track, don't act): stateless-transport RC (SEP-2567, ~mid-2027 with the 12-month
  overlap) · Phase-8 judging pivot (MCP sampling deprecated + Claude Code never implemented it →
  deterministic `register_gate` + a judge board, not `judge_outputs`-via-sampling).

## 5. Suggested next step

The 3 LOW items (APP-N1, APP-N2, PKG-N1) are a tidy <1-day opportunistic hardening batch (TDD, each a
few lines). Otherwise the layer is clean to start **M5 (Barriers + attention)**. Electron T9 remains
the real release gate but is independent of MCP.

---

### Sources
- Backlog/claims: `docs/reviews/2026-06-04-mcp-context-bughunt/` (INDEX · FIX-REPORT · cards),
  `2026-06-04-CONSOLIDATED-backlog.md`, `2026-06-03-mcp-status-audit.md`,
  `2026-06-05-remaining-backlog-kickoff.md`.
- Code read: `main` (app `src/main/mcp*.ts`, `auditLog.ts`, `boardRegistry.ts`, `index.ts`; renderer
  `useMcp*.ts`) + `Z:\canvas-ade-mcp\src` (auth · security · server · orchestrator · resources).
- Read-only; no code changed by this review.

> **README index line** (add when this lands on `main`):
> `| In-depth — MCP layer (2026-06-05) | `[`2026-06-05-mcp-indepth-review.md`](2026-06-05-mcp-indepth-review.md)` — healthy, no open Crit/High/Med; all 2026-06-04 MCP fixes verified real + merged; Host-header gap closed; 3 new LOW/INFO. |`
