# Agent Orchestration Onboarding — umbrella implementation plan

**Date:** 2026-06-19
**Status:** Kickoff plan (uncommitted on `main` working tree; implementing sessions move it onto their worktrees).
**Shape:** **Umbrella** — like the Command Board (#182, Phases A–E). One integration branch `feat/agent-orchestration`; phases land on it via worktrees; **ships to `main` as a whole**, once.
**Reads first:** [`REPORT.md`](./REPORT.md) (research/discussion), the signed-off mock `.claude/mocks/agent-orchestration-modal-mock.png` (+ `.html`), and memory `mcp-not-wired-to-terminals.md` (the proven two-layer gap + live proof) · `terminal-recap-feature.md` (the consent-pattern template).

> **What this umbrella ships:** terminal agents in *any* supported CLI can drive this canvas — gated by a one-time **Enable** consent + a re-runnable **Sync** that wires every CLI, with relay authorized by the cables you draw. It closes the "MCP M0–M5 shipped but no real agent can reach it" gap (proven live 2026-06-19).

---

## 1. The frame (what "ship as a whole" means)

```
feat/agent-orchestration  (integration branch — the umbrella)
   ├── P0  Authority seam + token tiers      ─┐ WT-authority  (P0 → P4, same relay-gate zone)
   ├── P4  Connector-aware live routing      ─┘
   ├── P1  Consent state + Settings          ─┐ WT-onboarding (P1 → P2)
   ├── P2  Enable modal                      ─┘
   ├── P3  Per-CLI provisioner + Sync modal   ── WT-provision
   └── P5  Education + umbrella e2e + docs     ── integration owner (last)
→ one PR: feat/agent-orchestration → main
```

Three worktrees run in parallel after the **seam (§3)** is fixed. P4 is the payoff and lives in the authority worktree (same files as P0 → no cross-lane collision). P5 is the integration owner's closing task.

---

## 2. Authority model (formalized v1)

- **Today:** `relay_prompt` is orchestrator-tier, hard-bound to the single in-process `'app'` board; a worker token can't even register it (`mcp.ts:99-112`, pkg `factory.ts:91`).
- **v1:** a Terminal board whose project has **orchestration consent** gets a token of a new tier **`connected`** that registers `relay_prompt`, `spawn`/`configure`, and plan/diagram-write — but with two different authorizations:
  - **Relay (terminal→terminal):** allowed iff a persisted **`orchestration` connector** exists `source===src && target===dst` (`canRelay`, §3). Existing **TOCTOU re-check** + per-action **ConfirmModal** stay. *The cable is the authority.*
  - **Spawn / configure / plan-write (act on the canvas):** no cable needed; gated by **consent + per-action ConfirmModal** (the human approves each).
- **Relaxation:** single-`'app'` binding → "any consented terminal, relay scoped to its own outgoing cables." This is **stricter** than today's `'app'` orchestrator (which can relay from anywhere). The in-process Command Board `'app'` path is **unchanged** → #182 keeps working.
- **plan-write gate:** `planningWriteEnabled()` currently returns true only under `CANVAS_E2E`/`CANVAS_MCP_PLANNING_WRITE`. v1: it **also** returns true when orchestration consent is granted for the project — the consent replaces the dev-only flag in prod. (No weakening: still ConfirmModal-gated per write.)

---

## 3. The shared seam (every lane codes against this — define before parallel work)

```ts
// ── WT-authority (P0) implements ──────────────────────────────────────────
type TerminalTier = 'connected'
interface TerminalToken { token: string; tier: TerminalTier; port: number }
function mintTerminalToken(boardId: string): TerminalToken           // bound to boardId, tier 'connected'
function canRelay(src: string, dst: string, connectors: Connector[]): boolean
//   = connectors.some(c => c.kind==='orchestration' && c.sourceId===src && c.targetId===dst)

// ── WT-onboarding (P1) implements ─────────────────────────────────────────
function isOrchestrationEnabled(projectDir: string): boolean         // per-project consent (userData store)
function setOrchestrationEnabled(projectDir: string, on: boolean): void

// ── WT-provision (P3) implements + consumes the two above ─────────────────
interface CliProvisioner {
  id: 'claude' | 'codex' | 'gemini' | 'opencode'
  detect(): Promise<boolean>                                  // config dir / binary present?
  sync(projectDir: string, tok: TerminalToken): Promise<void> // write THIS cli's MCP config (0o600)
  unsync(projectDir: string): Promise<void>
}
// spawn-time hook in pty.ts (recapEnvProvider-style): if isOrchestrationEnabled(dir),
//   run the matching provisioner.sync(dir, mintTerminalToken(boardId)) BEFORE writing launchCommand.
```

Stub the three function signatures on the integration branch first so all three worktrees compile against them immediately.

---

## 4. Phases

| P | Goal | Zone / key files | Depends on | Worktree | Ready? |
|---|---|---|---|---|---|
| **P0** | Authority seam + `connected` tier; relax `'app'` binding; register relay for the tier; `canRelay` + TOCTOU + ConfirmModal | app `mcp.ts`, `mcpOrchestrator.ts`; pkg `factory.ts` (+ publish bump) | seam §3 | WT-authority | **yes — start first** |
| **P1** | Per-project consent store + IPC + Zustand state + Settings toggle & "Sync" button row | new `orchestrationConsent.ts` (main), `SettingsModal`, store | seam §3 | WT-onboarding | **yes** |
| **P2** | Enable modal (the mock) wired to consent state; first-init trigger (recap-style, guarded on project open) | new `OrchestrationConsentModal.tsx`, `AppChrome` | P1 state | WT-onboarding | **yes** |
| **P3** | 4 `CliProvisioner`s + detection + Sync modal UI + spawn-time auto-sync; reuse pkg `writeMcpJson` for claude | new `cliProvisioners/*` (main), `pty.ts`, new `OrchestrationSyncModal.tsx` | seam §3 (token), P1 (consent getter) | WT-provision | **yes (scaffold against seam; final token wiring after P0)** |
| **P4** | Connector-aware live routing — relay from a real `connected` terminal lands in the cabled target, end-to-end | `mcpOrchestrator.ts` relay path (same as P0) | P0, P3 | WT-authority | blocked → after P0 |
| **P5** | MCP explainer hints; umbrella e2e (extend `e2e/mcp.e2e.ts`); build-history entry; mock/doc cleanup | `e2e/`, docs | P1–P4 | integration owner | blocked → last |

**Cross-zone note:** `AppChrome` is touched by P2 (Enable mount) and P3 (Sync mount). WT-onboarding owns `AppChrome` and adds an `<OrchestrationModals/>` host; WT-provision **exports** `OrchestrationSyncModal` and WT-onboarding mounts it. Coordinate on `ACTIVE-WORK.md`.

---

## 5. Acceptance

**Per phase:** ends runnable + committed; `pnpm typecheck && pnpm lint && pnpm format:check` green; the **manual dev check** with a PR-stamped title (`$env:CANVAS_DEV_TITLE='…'; pnpm dev`).

**Umbrella (the real bar):** reproduce the **live proof** but through the *shipped* path — no hand-staged `.mcp.json`. A new e2e in `e2e/mcp.e2e.ts` (building on `:603-669`): consent on → spawn terminal A (provisioner writes config) → A relays along an `orchestration` cable A→B → sentinel lands in B's xterm; reverse rejected; consent off → relay tool absent. **Full e2e matrix mandatory once at the pre-merge gate** (both legs).

---

## 6. Security invariants (do not weaken)

- **Never log tokens** (the [HIGH] finding this session). No `is.dev` token prints.
- Provisioner files written **`0o600`**; `unsync` on disable.
- `contextIsolation`/`sandbox`/`nodeIntegration:false` untouched; `simple-git`/`node-pty`/provisioners run **MAIN-only** behind frame-guarded IPC.
- Per-action **ConfirmModal** gate stays for every orchestration action; **cable-is-authorization** for relay (directed, TOCTOU-rechecked).
- Browser-board content must never reach the PTY write channel.

---

## 7. Decisions & open items

- **Resolved this session:** all-CLI (claude/codex/gemini/opencode) · two-step Enable→Sync · recap kept separate · v1 ships all three capabilities under one consent · plan-write gate = consent (replaces dev flag) · connector-routing folds into the authority lane.
- **Verify during P3 (honest caveat):** **Codex CLI transport.** Claude/Gemini/OpenCode take a remote-HTTP MCP url directly; Codex is historically stdio-first — it may need a local **stdio→http shim** or may land a release behind. Mark its provisioner "verify transport"; ship the other three regardless.
- **Title:** umbrella = **Agent Orchestration Onboarding**, branch `feat/agent-orchestration`.

This plan supersedes REPORT.md §4 (sequencing) — same lanes, now phased for the umbrella.
