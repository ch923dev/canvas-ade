# Consolidated backlog & tackle order — `main` (Canvas ADE / Expanse)

**Date:** 2026-06-04 · **Merges two independent 2026-06-04 reviews of `main`.**

This document reconciles the two reviews that ran today against `main`, removes the overlaps, and
recommends a single ordered plan to work through them. It does **not** restate every finding — the two
source reports hold full evidence per item.

## The two sources

| | **Audit A — full audit** | **Hunt B — MCP+Context bug hunt** |
|---|---|---|
| File | `docs/reviews/2026-06-04-main-branch-full-audit.md` | `docs/reviews/2026-06-04-mcp-context-bughunt/` |
| Shape | **Broad** — 12 dimensions across all of `src/` | **Deep + narrow** — Context subsystem + MCP M0–M4 only |
| Tree | `main` @ `416464d` | `integration/mcp-on-main` @ `bc236ee` (`src/` ≡ `origin/main` **plus** the MCP files) |
| Scale | 78 agents · 3.34M tok | 122 agents · 4.58M tok |
| Result | **58 confirmed** (4H · 8M · 34L · 12I) · 0 Critical · 7 refuted | **28 cards** (2H · 8M · 18L) · 0 Critical · 63 refuted |
| Verified | adversarial per-finding | adversarial per-candidate (default-refute) |

**They barely overlap on purpose.** A swept the whole app shallowly; B drilled the newest, riskiest
subsystem deeply. Where they touched the same code (the LLM/Context surface), **B escalated what A
under-rated** — proof that you need both: a broad audit misses the sharp exploit path a focused hunt finds.

---

## Reconciliation — overlaps & escalations

Only **4 items appear in both**. In every collision, defer to Hunt B's deeper severity.

| Defect | Audit A rating | Hunt B rating | Verdict | Why B wins |
|---|---|---|---|---|
| `baseUrl` egress unvalidated (SSRF / IMDS / loopback) | **Low** ×3 (`baseurl-no-scheme-validation-ssrf`, `local-baseurl-ssrf-no-validation`, `setconfig-baseurl-not-gated-to-local`) | **High** (`BUG-001`) | **HIGH** | B traced the full write→read→`fetch` path and the `169.254.169.254` IMDS / internal-host egress + response-exfil via `provider-error.message`. A saw the missing check but not the exfil chain. |
| Provider HTTP error body echoed to renderer | **Info** (`provider-error-message-leaks-response-body-to-renderer`) | **Medium** (`BUG-003`) | **MEDIUM** | Same file as BUG-001; it is the exfil tail of the SSRF. Fix together. |
| MAIN IPC handlers trust payload shape | **Low** (`ipc-payloads-no-runtime-shape-guard`) | **Low** (`BUG-011/012/013`) | **LOW** | Same gap, B is more granular (per-handler). Merge. |
| Key storage on the leak axis | "**clean**" (no key leak) | **Medium** (`BUG-005` split-brain) | **both true** | A was right that keys never leak as plaintext/IPC; B found a *different* axis — `hasKey↔getKey` disagree on decrypt failure (silent "no-provider" with `hasKey:true` shown). Not a contradiction. |

**Net effect of the merge:** A's "LLM egress = clean" verdict is **revised**. On the leak/exfil-of-keys
axis it holds; on the **input-validation + silent-failure** axis, Hunt B found one **High** (SSRF) and
three **Mediums** (BUG-003 error-body, BUG-004 budget overflow, BUG-005 key split-brain) that A rated
Low/Info or missed. Treat the LLM/Context surface as a **known-soft area**, not a clean one.

### What each found that the other could not (scope, not quality)

- **Only Audit A** (B never looked here): the entire **project-load failure cascade** (gcAssets data
  loss, unguarded `fromObject`, no error boundary, no `.bak` for deep-corrupt), **Electron 33 EOL** + the
  whole deps/build/SCA story, packaged `file://` nav, preview permission handler, god-files, per-frame
  perf, the test-coverage map, store/undo.
- **Only Hunt B** (outside A's broad sweep depth): **MCP `launchCommand` no-confirm** (BUG-002, the other
  High), budget overflow (BUG-004), key split-brain (BUG-005), **summaryLoop project-dir TOCTOU →
  wrong-project write** (BUG-006), SettingsModal races (BUG-007), unsanitized LLM output → markdown memory
  (BUG-016), and the full MCP-orchestrator hardening set (BUG-008/009/010/020/021/022/023/024/025).

---

## Branch reality — what's actually on `main` today

This decides *where* each fix lands, and it changes the order.

- **On `main` now** (Context subsystem merged via PR #39): all of Audit A, **plus** Hunt B's Context
  cards — `BUG-001, 003, 004, 005, 006, 007, 011, 012, 013, 014, 015, 016, 017, 018, 019, 027`
  (files: `llm*.ts`, `summaryLoop.ts`, `canvasMemory.ts`, `memoryEngine.ts`, `boardMemory.ts`,
  `SettingsModal.tsx`, `projectIpc.ts`, `index.ts`). → fix on a `fix/*` branch off `main`.
- **NOT on `main` yet** — lands with **PR #32 (`feat/mcp-integration`)**: every card touching
  `mcpOrchestrator.ts`, `mcpConfirm.ts`, `mcp.ts`, `auditLog.ts`, `mcpSmoke.ts` —
  `BUG-002, 008, 009, 010, 020, 021, 022, 023, 024, 025, 026`. → **fix on the MCP branch before it
  merges** (gate the merge), not on `main`.

> Merge order from the coordination board stays: **MCP #32 → … → rebrand #17 LAST.** The MCP-scoped
> fixes ride PR #32; the on-main fixes are independent `fix/*` branches that can merge ahead of it.

---

## Recommended tackle order

Six waves. Within a wave, **lanes** are file-disjoint and run in parallel; items sharing a file are
**sequenced** (collision rule from both reports). Release-blocking waves are marked ⛔.

### ⛔ Wave 0 — Stop the data loss (smallest change, highest consequence)
*Branch: `fix/load-cascade` off `main`. The four most dangerous findings are one architectural seam — fix as a unit. ~1 focused PR.*

| Lane | Items | File(s) |
|---|---|---|
| L0-a | **Defer/soften `gcAssets`** — gate on a renderer-ack of a good load, or convert `unlinkSync`→quarantine-move | `projectIpc.ts`, `projectStore.ts` |
| L0-b | **Wrap both `fromObject` calls** in try/catch → existing `project.status='error'`; wire `.bak` (or a distinct "needs newer app" state) for deep-validation + downgrade failures | `canvasStore.ts`, `boardSchema.ts` |
| L0-c | **Add a per-board + top-level React Error Boundary** | `main.tsx`, `BoardNode.tsx` |

Closes: `gcassets-before-validation-data-loss`, `corrupt-canvas-json-crashes-load`,
`fromobject-throw-unguarded-open`, `deep-validation-throw-no-bak-fallback`, `no-error-boundary`,
`downgrade-newer-schema-crash-plus-asset-gc`. **Do this first** — it's small and removes the only
unrecoverable-data-loss path in the codebase.

### ⛔ Wave 1 — Lock the LLM/Context egress surface
*Branch: `fix/llm-egress-hardening` off `main`. This is the area both reviews flagged hardest. Several lanes parallel; sequence within a file.*

| Lane (sequence within) | Items | File(s) |
|---|---|---|
| L1-a (security, **do first**) | **`baseUrl` validation** at `setConfig` + `readLlmConfig`: `new URL()` + `http(s)` only + loopback host allowlist; gate `baseUrl` to `provider==='local'`; **bound the provider error body** before it crosses IPC | `llmIpc.ts` → `llmConfig.ts` → `llmService.ts` (BUG-001, BUG-003, +A's 3 Lows + Info) |
| L1-b | **Key split-brain**: make `hasKey` agree with `getKey` (decrypt-aware); surface decrypt failure instead of silent `no-provider` | `llmKeyStore.ts` (BUG-005) |
| L1-c | **Budget guard**: `Number.isFinite` + upper-bound on persisted `calls` (overflow/cap-bypass) | `llmBudget.ts` (BUG-004) |
| L1-d (sequence) | **summaryLoop**: fix project-dir **TOCTOU → wrong-project write**, stale-snapshot, inFlight guard, `ensureScaffold()` before writes, **sanitize LLM output** into the markdown summary | `summaryLoop.ts`, `canvasMemory.ts` (BUG-006, 014, 015, 016, 017) |
| L1-e | **SettingsModal** save/clear races + key validation | `SettingsModal.tsx` (BUG-007) |
| L1-f | IPC shape guards on `llm:setKey/setConfig/summarize`; drop-injectedDeps.budget fix; empty-text guard | `llmIpc.ts` (BUG-011/012/013 + `ipc-payloads-no-runtime-shape-guard`) — *sequence after L1-a (same file)* |

### ⛔ Wave 2 — Runtime & supply chain (pairs with Phase 5 packaging)
*Branch(es) off `main`. Do the scanners FIRST so they vet the Electron bump and everything after.*

1. **Add SCA before bumping anything**: `pnpm audit --audit-level=high` in CI + `.github/dependabot.yml` + CodeQL + security ESLint (`no-restricted-imports` banning Node/native outside `src/main`). (`no-dependency-vuln-scanning`, `no-security-eslint-rules`) — *would have caught the EOL Electron automatically.*
2. **Upgrade Electron → supported major (≥40)**; re-verify the `node-pty 1.2.0-beta.13` ABI rebuild against the new Electron; re-run the full e2e matrix. (`electron-33-eol-no-security-backports`) — **the de-facto release blocker.**
3. **Pin packaged `file://` nav** to the exact app document URL + add a global `dragover`/`drop` `preventDefault`. (`packaged-fileurl-nav-allowed`)
4. **Deny-by-default permission handler** on each `preview-<id>` session. (`no-permission-handler-preview-views`)
5. Keep `electron-updater` **dormant** until signing + an HTTPS feed land. (`electron-updater-unsigned-latent`)

### Wave 3 — Gate the MCP merge (PR #32, runs in parallel — different branch/owner)
*Branch: `feat/mcp-integration`. Fix here BEFORE the merge to `main`. Sequence the `mcpOrchestrator.ts` collisions.*

1. **`BUG-002` (High)** — `configureBoard` `launchCommand`: apply the four protections `handoffPrompt` already uses — `sanitizeDispatchText` (reject CR/LF), a `registry.confirm(...)` gate, and a `registry.audit(...)` entry. **This is the second High in the whole consolidated set.**
2. Same file (sequence): `BUG-008` stale handoff snapshot/idle deadline, `BUG-009` close/reap cap-slot leak, `BUG-020` unbounded nonce set, `BUG-021` relayPrompt TOCTOU.
3. Disjoint: `BUG-010` confirm timeout, `BUG-022` predictable reply-channel name, `BUG-023` TTL ≤0 disables reaping, `BUG-024` auditLog seq interleave, `BUG-025/026` audit-wired-after-start + null-deref.

*(10 of these are partially touched by `roadmap-mcp.md` T-items — see `partials-roadmap-xref.md`; none fully covered, so all stay in-queue.)*

### Wave 4 — Silent-failure & reliability fast-follow (post-release OK)
*Branch off `main`. Mostly file-disjoint → high parallelism.*
Surface the swallowed errors with the existing `previewNote`/status patterns:
`image-write-failure-silent-drop`, `export-save-result-ignored`, `recents-listrecents-empty-on-parse-fail`,
`project-current-readproject-swallow`, `detect-ports-error-not-propagated`, `before-quit-flush-no-catch`.
Plus correctness: `image-paste-drop-lost-update` (read live `elements` via `getState()` at commit),
`pty-resize-unbounded`, `bare-1-0-keys-fire-while-well-focused`, `project-switcher-no-outside-close`,
`camera-fullview-prior-viewport-overwrite`, `ctrl-suppress-ref-stuck-on-blur`,
`bak-rotation-non-atomic-copy`, `BUG-018/019/027` (memory engine), `project-current-skips-unsafe-dir-guard`.

### Wave 5 — Maintainability, perf, test debt (no rush)
- **Test gaps** (regressions would ship silently): extract + unit-test the quit/flush/crash orchestration
  (`index-quit-shutdown-untested`), preview wiring, `pty:spawn` options, preload MessagePort re-post,
  `enumerateShells`; **hoist one shared `isForeignSender`** (`foreign-sender-guard-triplicated`).
- **God-files**: extract `PreviewManager` class, `usePlanningPointer`, `useFullView`/`useTidyTile`/
  `useCanvasKeybindings` (`browserpreviewlayer-god-file-982-loc`, `planningboard-god-file-1188-loc`,
  `canvas-god-file-857-loc-state-sprawl`).
- **Perf**: guard the `BrowserPreviewLayer` store subscription on the `boards` slice; precompute snap
  `others` at gesture-start; per-id `data` memo. (`previewlayer-reconcile-on-every-viewport-frame`,
  `onnodeschange-perframe-snap-allocation`, `nodes-memo-data-object-churn`, `fittoboards-repeated-minmax-spread`)
- **CSP**: append `object-src 'none'; base-uri 'self'; frame-ancestors 'none'`; pin `webSecurity`/
  `allowRunningInsecureContent`/`experimentalFeatures` explicitly with tests.
  (`prod-csp-style-unsafe-inline`, `implicit-secure-defaults-not-pinned`)

### Accept / document as-is (no change for release)
The Info-tier items are correct under the single-user / trusted-renderer model — annotate the invariant
near the code so a future refactor doesn't drop it: `pty-launchcommand-trusted-autoexec`,
`tolerated-phantom-undo-step`, `module-lastrecorded-shared-singleton`, `fresh-doc-stale-schemaversion`,
`navigate-blocked-scheme-no-bounds-resync`, `skiplibcheck-everywhere`, `measured-ref-not-pruned`,
`iconbtn-dead-longpress-timer`, `node-pty-pinned-beta` (track stable 1.2.0).

---

## One-screen summary

```
RELEASE BLOCKERS (do before any ship)
  Wave 0  load cascade ........ gcAssets defer · fromObject try/catch · .bak wire · error boundary   [main, fix/]
  Wave 1  LLM egress .......... baseUrl allowlist (BUG-001 High) · key split-brain · budget · summaryLoop  [main, fix/]
  Wave 2  runtime/supply ...... SCA first → Electron ≥40 → file:// pin → preview perms              [main + Phase 5]
  Wave 3  MCP gate ............ BUG-002 launchCommand confirm (High) + orchestrator set   [feat/mcp-integration, before merge]

POST-RELEASE
  Wave 4  silent-failure feedback + small correctness                                                [main, parallel]
  Wave 5  test debt · god-file splits · perf · CSP hardening                                         [main, no rush]
```

**Two Highs gate the two pending merges:** `BUG-001` (baseUrl SSRF) is on `main` now → Wave 1.
`BUG-002` (MCP launchCommand) rides PR #32 → fix on the MCP branch before it merges. Everything else in
Waves 0–2 is independent `fix/*` work on `main` and can land ahead of the MCP merge.

---

### Source-of-truth pointers
*(Both raw packages were collapsed to git history on 2026-06-10 — recover via `git log --all -- <path>`.)*
- Audit A full detail + per-dimension coverage: `docs/reviews/2026-06-04-main-branch-full-audit.md`
- Hunt B cards (BUG-001…028) + `unconfirmed.md` + `partials-roadmap-xref.md`:
  `docs/reviews/2026-06-04-mcp-context-bughunt/`
- Both were read-only; **no code was changed** by either review or this consolidation.
- ⚠️ Hunt B line numbers were captured on a since-removed worktree — re-confirm `file:line` on a fresh
  `main`/MCP checkout before editing.
