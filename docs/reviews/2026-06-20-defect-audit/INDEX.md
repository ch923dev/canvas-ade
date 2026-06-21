# Audit findings — INDEX (the work queue)

**Canvas ADE / Expanse — codebase-wide defect & risk audit · 2026-06-20**

Ranked queue of **15 CONFIRMED, in-scope** defects (independently re-verified). Severity-ordered;
fix top-down. Unverified/out-of-scope candidates are in [`unconfirmed.md`](unconfirmed.md); roadmap
reconciliation in [`skipped-roadmap.md`](skipped-roadmap.md).

**Tally: 1 High · 7 Medium · 7 Low** (15 total).

**Method.** 17 file-disjoint discovery slices fanned out over the repo; each candidate was then handed to an
independent adversarial skeptic that re-opened the cited code to refute-or-confirm it; the High and the key
security/data Mediums were additionally hand-verified by the lead. One run lost 7 slices to a transient
server rate-limit — those were **re-run** (clean) before synthesis. 20 raw candidates → **15 confirmed**
+ 5 unconfirmed/out-of-scope.

**Scope.** All `src/**`, config, CI. **Includes File Tree (#201) + Command Board (#182)** — recently shipped
and *never previously defect-audited* (the 2026-06-19 improvement audit excluded them). This pass targets the
DEFECT dimensions — correctness · security · concurrency · data-integrity · error-handling · resource-leak ·
input-validation · perf-cliff · supply-chain — that the perf/a11y/UX-focused 2026-06-19 audit deliberately did
not cover (that audit's own report states "no new correctness, security, or data-loss findings emerged").

| ID | Sev | Category | Location | Finding | Collides |
|---|---|---|---|---|---|
| [FIND-001](findings/FIND-001.md) | 🔴 High | security · secrets | `m/index.ts:631` | Bearer token persists on disk after consent revoke for terminal boards whose cwd differs from the project root (project-scoped claude/opencode configs) | FIND-003, 008, 015 |
| [FIND-002](findings/FIND-002.md) | 🟠 Medium | data integrity · lost update | `r/boards/FileBoard.tsx:264-282` | FileBoard save is a blind last-writer-wins overwrite — concurrent external (agent) edits to an open dirty file are silently lost | — |
| [FIND-003](findings/FIND-003.md) | 🟠 Medium | error-handling · availability | `m/fileWatch.ts:95-141` | Unguarded `await import('chokidar')` in fire-and-forget watch() rejects to MAIN unhandledRejection sink → app.exit(1) (call-site try/catch only guards sync throws) | FIND-001 |
| [FIND-004](findings/FIND-004.md) | 🟠 Medium | security · authz | `m/projectIpc.ts:279-283` | project:reopenFromBak omits the BUG-006 approved-root gate — bounded arbitrary canvas.json.bak read from a compromised renderer | FIND-014 |
| [FIND-005](findings/FIND-005.md) | 🟠 Medium | concurrency · state-machine | `r/boards/command/useCommandDispatch.ts:143-198` | Stale runDispatch clobbers a task transitioned by the board-gone handler or Retry (failed→done flip / dead-run result on the live retry) | FIND-006 |
| [FIND-006](findings/FIND-006.md) | 🟠 Medium | concurrency · liveness | `r/boards/command/useCommandDispatch.ts:188-197` | Cap-rejected command task re-queues with no re-pump and hangs when all cap slots are held by completed (still-open) worker boards | FIND-005 |
| [FIND-007](findings/FIND-007.md) | 🟠 Medium | security · injection | `r/boards/terminal/terminalDrop.ts:8-14` | Dropped file path with embedded newline/quote injects shell commands via term.paste at a bare (non-bracketed-paste) prompt | — |
| [FIND-008](findings/FIND-008.md) | 🟠 Medium | data integrity | `m/cliProvisioners/shared.ts:188-201` | Non atomic writeFileSync in CLI provisioners can corrupt the user config on a crash | FIND-001 |
| [FIND-009](findings/FIND-009.md) | 🟡 Low | resource leak | `m/pty.ts:224-234` | boardCwds map leaks a stale (board-id → cwd) entry when a parked terminal is reaped on TTL expiry or exits while parked, until project switch | — |
| [FIND-010](findings/FIND-010.md) | 🟡 Low | correctness | `m/previewOsr.ts:642-651` | OSR did-navigate-in-page never clears the failed latch — SPA stuck on load-failed after client-side route (sole engine; recovery helper has no production call site) | — |
| [FIND-011](findings/FIND-011.md) | 🟡 Low | resource leak | `r/boards/useOffscreenPreview.ts:173-181` | previewStore.byId entries leak on browser-board unmount and project switch — clear() has no production caller (monotonic growth per browser-board mount) | — |
| [FIND-012](findings/FIND-012.md) | 🟡 Low | error-handling · consent integrity | `m/recapConsent.ts:82-84` | recap:setConsent persists consent before installing the SessionStart hook with no try/catch — an I/O throw from installRecapHook leaves consent 'enabled' but the hook uninstalled for the rest of the session (self-heals on next project open/restart) | — |
| [FIND-013](findings/FIND-013.md) | 🟡 Low | performance cliff | `m/portDetect.ts:84-86` | O(n^2) soft-wrap-fragment filter in parsePortsFromOutput blocks MAIN ~0.7–1s on a 256KB buffer densely packed with localhost URLs (adversarial/agent-induced) | — |
| [FIND-014](findings/FIND-014.md) | 🟡 Low | security · authz (defense-in-depth) | `m/projectIpc.ts:61-83` | isUnderApprovedRoot case-folds segments, over-approving case-variant project paths on case-sensitive (POSIX) filesystems (defense-in-depth loosening) | FIND-004 |
| [FIND-015](findings/FIND-015.md) | 🟡 Low | security · resource leak | `m/mcp.ts:144-149` | Connected-tier MCP tokens are never revoked on board close — rows accrete in the in-memory TokenStore and stay valid until app restart (documented revoke-on-close contract unimplemented in host) | FIND-001 |

> Location prefixes: `m/` = `src/main/`, `r/` = `src/renderer/src/` (canvas/ elided).

## Sequencing / collision groups
Cards sharing a file must be sequenced (one branch/PR), not fixed in parallel; everything else is parallel-safe.

- **`projectIpc.ts`** → **FIND-004** + **FIND-014** (different functions; one PR).
- **`command/useCommandDispatch.ts`** → **FIND-005** + **FIND-006** (same hook; one PR).
- **`cliProvisioners/` + `index.ts`** → **FIND-001** (revoke tracking; touches index.ts, cliProvisioners/index, claude, opencode) is **adjacent to FIND-008** (atomic write in cliProvisioners/shared.ts) and **FIND-003** (index.ts watcher call site). Coordinate; land FIND-001 first.
- **Orchestration token-lifecycle** → **FIND-001** (bearer left on disk after revoke) + **FIND-015** (in-memory token never revoked on close): one root concern (revoke-on-close unimplemented) — design the fix together even though the files differ.
- **`pty.ts`** → **FIND-009** (boardCwds leak); the same map is the natural cleanup hook for FIND-001.
- **Parallel-safe (disjoint files):** FIND-002, 007, 010, 011, 012, 013.

## Severity calibration (defect lens)
Critical = exploit / data-loss / main-crash reachable in normal use · High = clear security weakening or a bug
users hit · Medium = narrow/edge but real · Low = minor / hardening / bounded.
