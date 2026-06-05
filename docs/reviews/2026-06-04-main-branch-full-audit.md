# Full audit — `main` branch (Canvas ADE / Expanse)

> **Read-only audit. No code was modified.** This report is the deliverable.

| | |
|---|---|
| **Date** | 2026-06-04 |
| **Branch audited** | `main` @ `416464d` (_docs: hygiene pass — compile shipped plans/specs_) |
| **Scope** | `src/` ≈ **19,169 LOC** non-test across **~165 files**, **60 test files**, build/CI config, deps |
| **Method** | 12-dimension parallel agent fan-out → adversarial per-finding verification → synthesis (78 agents, 3.34M tokens) |
| **Confirmed findings** | **58** (4 High · 8 Medium · 34 Low · 12 Info — **0 Critical**) |
| **Refuted (false positives)** | 7 (killed at verify stage) |

---

## Verdict at a glance

**Structurally sound, not release-ready as-is.** No Criticals, only 4 Highs. The security-defining subsystems (PTY bridge, native preview lifecycle, IPC frame-guarding, LLM egress, persistence path-safety) audited unusually clean. Release is gated by two clusters: a **project-load failure cascade** that can cause silent, unrecoverable data loss, and an **end-of-life Electron 33** runtime behind a user-navigable browser surface. Both fixable with bounded, well-understood changes.

### The 8 things that matter most

| # | Severity | ID | One-liner |
|---|---|---|---|
| 1 | 🟧 High | `gcassets-before-validation-data-loss` | Asset GC `unlinkSync`s image blobs **before** load validation → failed load loses project *and* assets, permanently |
| 2 | 🟧 High | `electron-33-eol-no-security-backports` | Electron 33 EOL since 2025-04-29; 13+ months of unpatched Chromium/V8 CVEs behind a user-navigable WebContentsView |
| 3 | 🟧 High | `corrupt-canvas-json-crashes-load` | Envelope-valid-but-deep-corrupt `canvas.json` throws uncaught in `fromObject` → blank app, no recovery, no `.bak` |
| 4 | 🟧 High | `fromobject-throw-unguarded-open` | Same unguarded `fromObject` throw across all 3 open entry points (startup / welcome / switch) |
| 5 | 🟨 Medium | `deep-validation-throw-no-bak-fallback` | The `.bak` recovery the code comments promise is never wired for deep-validation failures |
| 6 | 🟨 Medium | `no-error-boundary` | Zero React error boundaries — any render/effect throw blanks the entire canvas |
| 7 | 🟨 Medium | `no-dependency-vuln-scanning` | No `pnpm audit` / Dependabot / CodeQL anywhere — the reason the EOL Electron sat unflagged |
| 8 | 🟨 Medium | `packaged-fileurl-nav-allowed` | Packaged `will-navigate` guard allows **any** `file://` URL — a stray file drop replaces the whole app |

---

## Executive summary

Main is **structurally sound but not release-ready as-is**. The audit confirmed 58 findings across 13 dimensions with **no Criticals and only 4 Highs**, and the security-sensitive subsystems that define this app — the PTY bridge, the native WebContentsView preview lifecycle, IPC frame-guarding, LLM egress, and persistence path-safety — are unusually well-disciplined (see "What's solid"). The release blocker is not a single exploit but a cluster: an **end-of-life Electron 33** runtime (no security backports for 13+ months) directly behind a user-navigable browser surface, plus a **fragile project-load path** where an envelope-valid-but-deep-corrupt `canvas.json` throws uncaught with no Error Boundary, no `.bak` fallback for deep-validation failures, and — worst — an **asset garbage-collector that runs before validation and can irreversibly delete image blobs** on a load that then fails. The worst risks are therefore (1) the EOL runtime as a security-debt release blocker, and (2) a small family of persistence/load failures that combine into silent, unrecoverable data loss. None of these is exotic; all are fixable with bounded, well-understood changes before a first release.

## Severity breakdown

| Severity | Count |
|---|---|
| High | 4 |
| Medium | 8 |
| Low | 34 |
| Info | 12 |
| **Total** | **58** |

All 58 were adversarially verified (confirmed or severity-adjusted, never refuted). Of the original claimed severities, several were adjusted **down** on verification (e.g. the Electron EOL from Critical→High given the single-user/pre-release threat model; the SCA gap, node-pty beta pin, and electron-updater latent-MITM from Medium→Low because the app is unshipped) — the team's existing ADRs and threat-model documentation held up to scrutiny and earned those reductions honestly.

## Cross-cutting themes

**1. The project-load failure cascade (the single most important theme).**
Four findings describe one architectural seam failing in concert. MAIN's `readProject` validates only the document *envelope* (numeric `schemaVersion` + `boards[]` array); all *deep* validation lives in the renderer's `fromObject`, which throws on any malformed board/element. But (a) `fromObject` is called with **no try/catch** at every entry point (`corrupt-canvas-json-crashes-load`, `fromobject-throw-unguarded-open`), (b) there is **no React Error Boundary anywhere** so the throw blanks the whole app (`no-error-boundary`), (c) the `.bak` fallback the code's own comments promise is **never wired for deep-validation failures** (`deep-validation-throw-no-bak-fallback`), and (d) the destructive `gcAssets` sweep runs in MAIN *before* the renderer ever validates — so a load that throws has already **permanently `unlinkSync`'d unreferenced image blobs** (`gcassets-before-validation-data-loss`). The downgrade case (`downgrade-newer-schema-crash-plus-asset-gc`) is the same seam hit by version skew. **Systemic fix:** wrap both `fromObject` calls in try/catch routing to the existing `project.status='error'` path; add a top-level + per-board Error Boundary; defer `gcAssets` until *after* a renderer ack of a good load (or make the sweep a soft quarantine move, not `unlinkSync`); and have MAIN attempt `.bak` on a renderer-reported deep-validation failure.

**2. Silent-failure / swallowed-error clusters.**
A consistent pattern of error paths that resolve to a no-op with zero user feedback: image paste/drop drops silently on `asset:write` failure (`image-write-failure-silent-drop`), export save-dialog failures are indistinguishable from cancel (`export-save-result-ignored`), a corrupt recents file silently empties *and then overwrites* the recents list (`recents-listrecents-empty-on-parse-fail`), and `project:current` maps an auto-reopen failure to `null` → boots to welcome with no reason (`project-current-readproject-swallow`). **Systemic fix:** establish a minimal user-facing feedback channel (even `console.error` + the existing `previewNote`/status patterns) and inspect every discriminated-union `{ok:false}` / `{error}` return rather than discarding it. Several of these already have the surfacing infrastructure (e.g. `applyOpenResult`'s error path, `WelcomeScreen`'s error paragraph) bypassed only because MAIN drops the cause too early.

**3. IPC trust-boundary validation gaps (defense-in-depth, currently inert).**
The frame-guard (`isForeignSender`) is correctly applied to *every* channel, but it is **copy-pasted into three modules with three near-identical test suites and no shared source** (`foreign-sender-guard-triplicated`) — a hardening of one copy can silently miss the others. Beyond the guard, MAIN handlers trust renderer payload *shape* with TS types only (`ipc-payloads-no-runtime-shape-guard`); the `local` provider `baseUrl` is an unvalidated egress target (`baseurl-no-scheme-validation-ssrf` / `local-baseurl-ssrf-no-validation`, both already documented as accepted SEC-Low residual risk in ADR 0003); `llm:setConfig` persists `baseUrl` for any provider rather than gating it to `local` (`setconfig-baseurl-not-gated-to-local`); and `pty.resize()` truthiness-checks cols/rows while the sibling `input` branch type-checks (`pty-resize-unbounded`). None is exploitable today (frame guard + single-user model + the renderer being the trusted principal), but the invariants rest on read-side branches rather than the write/trust boundary. **Systemic fix:** hoist one shared `ipcGuard.ts`; add cheap runtime shape guards mirroring the codebase's own `projectStore`/`safeBoardId` discipline; gate `baseUrl` to `local` at the write path; validate the `baseUrl` scheme/host.

**4. God-files concentrating the highest-risk logic.**
The three most invariant-sensitive components are also the largest single closures: `BrowserPreviewLayer.tsx` (982 lines, ~35 numbered bug-fix comments, the entire native-view motion FSM in one ref-web — `browserpreviewlayer-god-file-982-loc`), `PlanningBoard.tsx` (1188 lines, ~10 concerns — `planningboard-god-file-1188-loc`), and `Canvas.tsx`'s `CanvasInner` (~15 state/ref + four lifecycle machines — `canvas-god-file-857-loc-state-sprawl`). The pure decision logic is *already* extracted and tested; what remains monolithic is the stateful orchestration, which can only be verified end-to-end. These are all maintainability/regression-surface concerns (Low/Medium), not active bugs. **Systemic fix:** extract framework-free managers/hooks (`PreviewManager` class, `usePlanningPointer`, `useFullView`/`useTidyTile`/`useCanvasKeybindings`) so the ordering invariants become unit-testable.

**5. Supply-chain & build-gate hygiene for an unshipped app.**
The runtime is EOL (`electron-33-eol-no-security-backports`), there is **no dependency scanning of any kind** (`no-dependency-vuln-scanning`) — which is *why* the EOL Electron sat unflagged — the most-privileged native module is pinned to a prerelease beta (`node-pty-pinned-beta`), `electron-updater` is installed-but-unwired and would enable update-MITM if turned on before signing (`electron-updater-unsigned-latent`), and lint has no security rules to enforce the never-weaken privilege boundary (`no-security-eslint-rules`). **Systemic fix:** these bundle into the Phase 5 packaging milestone — upgrade Electron to a supported major, add `pnpm audit`/Dependabot/CodeQL, add `no-restricted-imports` banning Node/native modules outside `src/main`, and keep the updater dormant until signing + a verified HTTPS feed land.

**6. Per-frame allocation churn on the hot interaction paths.**
A set of bounded-but-real allocation patterns on pan/zoom and drag/resize: `BrowserPreviewLayer`'s store subscription runs a full reconcile (alloc + O(n) loop) on every viewport frame with no `boards`-slice guard (`previewlayer-reconcile-on-every-viewport-frame`); the snap pass rebuilds an others-array per pointer frame (`onnodeschange-perframe-snap-allocation`); and the `nodes` memo mints a fresh `data` object per board on every selection/focus change, defeating React Flow's render bailout (`nodes-memo-data-object-churn`). All are Low (the live-view cap and small board counts bound the cost), but they share one fix discipline: precompute static inputs at gesture-start and guard subscriptions on the slice they actually depend on.

## Top risks (ranked)

1. **`gcassets-before-validation-data-loss` (High)** — irreversible `unlinkSync` of image blobs runs *before* load validation; a failed load loses both the project and its assets. Permanent, unrecoverable data loss is the highest-consequence finding in the set.
2. **`electron-33-eol-no-security-backports` (High)** — 13+ months of unpatched Chromium/V8/Node CVEs behind a user-navigable WebContentsView. The de facto release blocker; the whole isolation model assumes a patched Chromium.
3. **`corrupt-canvas-json-crashes-load` / `fromobject-throw-unguarded-open` (High ×2)** — one envelope-valid-but-deep-corrupt `canvas.json` wedges boot or the open flow into an unhandled rejection with no error UI and no recovery; the documented `.bak` fallback never fires for this case.
4. **`deep-validation-throw-no-bak-fallback` (Medium)** — the recovery contract the code comments promise is simply not implemented; closes the loop on why #3 has no graceful degradation.
5. **`no-error-boundary` (Medium)** — any single render/effect throw blanks the entire canvas (the project's own known "black-screen regression" class) and can lose ~1s of debounced autosave; one bad board cannot be isolated.
6. **`no-dependency-vuln-scanning` (Medium)** — no `pnpm audit`/Dependabot/CodeQL; the reason the EOL runtime went unnoticed and the mechanism by which any future node-pty/simple-git/electron-updater CVE would ship silently.
7. **`index-quit-shutdown-untested` (Medium)** — the entire quit/flush/crash orchestration (data-loss-on-quit and orphan-PTY-tree prevention) is untested at every tier; a regression here is silent and surfaces only as lost work or zombie processes in production.
8. **`packaged-fileurl-nav-allowed` (Medium)** — in the packaged build the `will-navigate` guard allows *any* `file://` URL (origin `null === null`), so a stray file drop can replace the whole app + all live PTYs/views with no way back — exactly the failure the guard documents itself as preventing.

## What's solid

Credit where the coverage notes show genuinely clean audits:

- **Preview lifecycle (zero findings above Info).** The native-view teardown is close-not-destroy with no `destroy()` anywhere; the ~4-live-view cap is enforced in both drivers; per-board partition isolation matches ADR 0002; the rAF camera sync is correctly coalesced to one IPC/frame, diff-skipped, and self-stopping; snapshot/LOD detach ordering captures-while-attached with swallowed `capturePage` rejections so the detach is never skipped; and every async open re-checks existence after every await (the `attachSeq`/`recs.has` discipline). For the most invariant-sensitive subsystem in the app, this is unusually well-guarded.
- **PTY / terminal.** No command-injection surface (shell/args/cwd passed as separate argv, `launchCommand` is a written PTY line by design); `resolveShell` gates spawn to a system-enumerated allowlist so a corrupt `canvas.json` cannot name an arbitrary binary; tree-kill is correct on both platforms and awaitable; PID-reuse/stale-exit races are guarded by `live.proc === proc` identity checks; Browser-board content is provably isolated from the PTY channel (no preload, per-board partition, frame-guarded handlers).
- **LLM egress.** Keys are `safeStorage`-encrypted in `userData` (never the project folder), never logged, never returned over IPC; egress is the only outbound path with hardcoded non-overridable destinations for the major providers; the budget is fail-closed with a synchronous read-check-write (no double-spend); and crucially the lethal-trifecta is closed — summary output reaches only disk/renderer, never a PTY write or tool dispatch.
- **Persistence core.** Atomic writes everywhere (no `writeFileSync` bypass), envelope-guarded `.bak` rotation, well-enforced scene/session split (`PATCHABLE_KEYS` + `structuredClone`), correct quit-flush handshake, and thorough path-traversal guards (`isUnsafeProjectDir`, regex-pinned `assetId`/`safeBoardId`). The deep-load fragility (Theme 1) is the exception in an otherwise disciplined layer.
- **Store / undo, type-contracts, and the security primitives' unit tests.** Immutability is sound, history is bounded at 50, the phantom-undo edge is intentional and test-locked; `boardSchema` deep validation is robust and the loose IPC types are re-validated MAIN-side; and the pure security functions (`navDecision`, scheme allowlists, nav guards, `isForeignSender`, tree-kill argv, `resolveShell`) are all directly unit-tested with per-handler foreign-sender integration tests.

The recurring tell of a healthy codebase: most findings are *test-gaps and architecture/maintainability notes on already-correct code*, not active defects — and the team's own ADRs (0002, 0003) pre-documented several residual risks the audit independently rediscovered.

## Recommended action order

**Block release until these land (highest data-loss / security consequence first):**
1. **Defer or soften `gcAssets`** — gate it on a renderer ack of a successful load, or convert `unlinkSync` to a quarantine-move (`gcassets-before-validation-data-loss`, `downgrade-newer-schema-crash-plus-asset-gc`).
2. **Wrap both `fromObject` calls in try/catch** routing to `project.status='error'`, and **wire the `.bak` fallback (or a "too new" state) for deep-validation failures** (`corrupt-canvas-json-crashes-load`, `fromobject-throw-unguarded-open`, `deep-validation-throw-no-bak-fallback`).
3. **Add a top-level + per-board React Error Boundary** (`no-error-boundary`).
4. **Upgrade Electron to a supported major (≥40)**, re-verify the node-pty beta rebuild against the new ABI, re-run the e2e matrix (`electron-33-eol-no-security-backports`).
5. **Pin the packaged `file://` nav guard to the exact app document URL** and add a global `dragover`/`drop` `preventDefault` (`packaged-fileurl-nav-allowed`).

**Fold into the Phase 5 packaging milestone (alongside signing):**
6. Add SCA + Dependabot + CodeQL and security ESLint rules (`no-dependency-vuln-scanning`, `no-security-eslint-rules`); these would have caught #4 automatically.
7. Keep `electron-updater` dormant; only wire it with signed artifacts + an HTTPS feed (`electron-updater-unsigned-latent`). Track node-pty's stable 1.2.0 (`node-pty-pinned-beta`).
8. Extract and unit-test the quit/flush/crash orchestration (`index-quit-shutdown-untested`); add the missing happy-path tests for preview wiring, `pty:spawn` options/collision-reap, the preload MessagePort re-post origin pinning, and `enumerateShells` (`preview-happy-path-wiring-untested`, `pty-spawn-options-untested`, `preload-msgport-repost-untested`, `enumerate-shells-untested`).

**Fast-follow / post-release cleanup (low-risk, high-ergonomics):**
9. Close the silent-failure cluster with user feedback on `asset:write`/export/recents/auto-reopen failures (Theme 2).
10. Harden the IPC boundary: hoist a shared `isForeignSender`, add runtime shape guards, gate `baseUrl` to `local` + validate its scheme, bound `pty.resize` (Theme 3).
11. Append `object-src 'none'; base-uri 'self'; frame-ancestors 'none'` to PROD/DEV CSP, and pin `webSecurity`/`allowRunningInsecureContent`/`experimentalFeatures` explicitly with tests (`prod-csp-style-unsafe-inline`, `implicit-secure-defaults-not-pinned`).
12. Refactor the three god-files into testable managers/hooks and apply the per-frame allocation fixes (Themes 4 & 6).

**Accept or document as-is:** the Info-tier items (e.g. `pty-launchcommand-trusted-autoexec`, `navigate-blocked-scheme-no-bounds-resync`, `module-lastrecorded-shared-singleton`, `fresh-doc-stale-schemaversion`, `tolerated-phantom-undo-step`) are correct under the current single-user/trusted-renderer model — note the invariants near the code so a future refactor doesn't silently drop them, but no change is required for release.

---

## Methodology

The audit ran against a detached worktree pinned to `main` (`416464d`) so agents read the exact released tree, not the working branch.

1. **Find (12 parallel dimensions).** One senior-auditor agent per dimension, each reading the full files in its scope (not excerpts), producing structured findings with exact file + line range + verbatim evidence. Dimensions: Electron security · PTY/terminal · LLM egress/secrets · preview lifecycle/leaks · persistence/path-safety · store/undo · renderer React hygiene · silent failures · type/IPC contracts · test coverage · deps/build/config · performance/architecture.
2. **Verify (adversarial, per finding).** Every single finding was handed to an independent skeptic agent instructed to **refute** it by re-reading the actual code, defaulting to false-positive if it could not prove the issue. The skeptic also re-ranked severity. **7 findings were refuted** (3 were "clean" notes mis-filed as findings, 2 were correct-but-style, 2 relied on defaults that already hold) and several were severity-adjusted down.
3. **Synthesize.** Confirmed findings (verifier said real) were deduped, severity-sorted, and themed.

**Confidence note:** this is a static read of the source. Findings are evidence-backed against the code, but no claim was confirmed by running the app or a live exploit. "High" = serious bug/leak/likely-crash or a security-contract gap, not a proven remote exploit (there are none in this set).

---

## Findings — full detail

58 confirmed findings, grouped by (verifier-adjusted) severity. Each lists the dimension, exact location, category, the finder's claimed→adjusted severity, and the adversarial verifier's reasoning.

### 🟧 High (4)

#### 1. `gcassets-before-validation-data-loss`

**gcAssets deletes unreferenced blobs BEFORE the renderer validates the doc — a load that then throws loses assets irrecoverably**

- **Where:** `src/main/projectIpc.ts`:101-110 · **dimension:** persistence · **category:** leak · **finder confidence:** high

**What it is.** In the project:open handler, gcAssets(r.dir, collectAssetIds(r.doc)) (line 107) runs in MAIN immediately after readProject, BEFORE the renderer ever calls fromObject on the same r.doc. gcAssets unlinks every file in <dir>/assets/ whose path is not in the referenced set derived from the *raw* doc (projectStore.ts gcAssets, lines 166-184). collectAssetIds only harvests assetIds from elements with kind==='image' and a string assetId; if a planning board's `elements` array is itself malformed (the deep-invalid case from finding #1), collectAssetIds silently yields nothing for that board, so its image blobs are swept. The sweep is irreversible (unlinkSync). project:current (line 175) has the identical pre-validation GC. Combined with finding #1 (the load then throws with no .bak fallback), the user is left with neither the loaded project nor the asset blobs.

**Impact.** Opening a partially-corrupt project can permanently delete pasted/dropped image blobs that a backup or a manual repair would otherwise have recovered, because the destructive GC runs ahead of (and independent of) successful validation. Asset GC should be the LAST step of a confirmed-good open, not the first step of an unvalidated one.

**Evidence.**

```ts
if (r.ok) {\n      gcAssets(r.dir, collectAssetIds(r.doc))   // <-- destructive sweep on the RAW doc, before any deep validation\n      scaffoldProjectMemory(r.dir)
```

**Recommendation.** Defer gcAssets until AFTER the renderer confirms the doc loaded (fromObject succeeded) — e.g. gate it on a renderer ack, or run MAIN-side deep validation first and only sweep when validation passes. Alternatively make the sweep soft (move to a quarantine dir) rather than unlinkSync.

<details><summary>Adversarial verifier (confirmed)</summary>

The code confirms the finding is genuine. The sequence in `projectIpc.ts` line 94 is:

```
const r = readProject(dir)
remember(r)
if (r.ok) gcAssets(r.dir, collectAssetIds(r.doc))
return r
```

`readProject` passes only the envelope check (`schemaVersion` is a number AND `boards` is an array — `projectStore.ts` lines 34–41). A planning board whose `elements` field is present but not an array (e.g. `"elements": "corrupt"`) passes this envelope check and makes `readProject` return `ok: true`.

`collectAssetIds` (`projectStore.ts` lines 144–159) iterates boards and for each board does `if (!Array.isArray(els)) continue` — silently skipping the malformed board, collecting zero asset IDs for it. …

</details>

---

#### 2. `corrupt-canvas-json-crashes-load`

**Malformed canvas.json (envelope-valid but bad board) throws unguarded in fromObject — no Error Boundary, app breaks with no recovery**

- **Where:** `src/renderer/src/store/canvasStore.ts`:513-531 · **dimension:** silent-failures · **category:** silent-failure · **finder confidence:** high

**What it is.** MAIN's readProject only validates the document ENVELOPE (numeric schemaVersion + boards is an Array) and returns { ok:true, doc } for any structurally-shaped file (projectStore.ts:34-41, isEnvelope). The renderer then calls fromObject(r.doc) UNGUARDED in applyOpenResult (canvasStore.ts:518) and loadObject (canvasStore.ts:503). fromObject performs DEEP validation and THROWS via fail()/assertBoard on any malformed board/element (boardSchema.ts:305-415, e.g. a board with a non-string title, an unknown type, a checklist item missing `done`). There is no try/catch around either fromObject call, and no React Error Boundary exists anywhere (main.tsx:7 renders <App/> bare). The throw propagates: on boot, App.tsx:29-32 does `window.api.project.current().then(r => { if (r && r.ok) applyOpenResult(r) })` with NO .catch — so the throw becomes an unhandled rejection during the boot effect; via WelcomeScreen.openDir (WelcomeScreen.ts:19-22) and AppChrome.switchTo (AppChrome.tsx:87) it throws inside an async handler. The applyOpenResult `error` status path (canvasStore.ts:514-516) ONLY triggers for r.ok===false, never for a parse throw, so the graceful 'Could not open project' UI (WelcomeScreen.tsx:44) is bypassed entirely.

**Impact.** A single hand-edited / partially-corrupted / older-incompatible canvas.json that still has schemaVersion+boards[] makes the project un-openable: on auto-reopen the app boots to a broken/blank state with no error message and no way back to the welcome screen; opening such a project from the picker throws into an unhandled async rejection. The .bak recovery the design promises does not help because the bad file passes the envelope check and is returned as ok. This is a data-availability failure that the user cannot diagnose or recover from in-app.

**Evidence.**

```ts
applyOpenResult: `const d = fromObject(r.doc)` (canvasStore.ts:518) — only `if (!r.ok)` sets status 'error'. App.tsx: `void window.api.project.current().then((r) => { if (r && r.ok) applyOpenResult(r) })` — no .catch. boardSchema.ts:305 `function fail(msg: string): never { throw new Error(...) }`.
```

**Recommendation.** Wrap both fromObject calls (applyOpenResult, loadObject) in try/catch and route a parse failure into the existing `project.status='error'` path with a user-facing message (the welcome screen already renders project.error). Additionally add a top-level React Error Boundary in main.tsx so any render-time throw degrades to a recoverable screen instead of a blank app. Optionally have MAIN attempt the .bak when the renderer reports the primary failed to parse.

<details><summary>Adversarial verifier (confirmed)</summary>

The finding is confirmed by direct code inspection.

`fromObject` in `src/renderer/src/lib/boardSchema.ts` lines 305-415 throws unconditionally via `fail()` on any board-level or element-level schema violation (unknown type, non-string title, non-boolean `done` on a checklist item, etc.).

`applyOpenResult` at `canvasStore.ts:518` calls `const d = fromObject(r.doc)` with no surrounding try/catch. The `!r.ok` guard at line 514 only routes MAIN-side I/O failures; it is never reached for a renderer-side parse throw.

`App.tsx:29-33` invokes `applyOpenResult(r)` inside a `.then()` callback with no `.catch()`:
```ts
void window.api.project.current().then((r) => {
  if (r && r.ok) applyOpenResult( …

</details>

---

#### 3. `fromobject-throw-unguarded-open`

**Renderer crashes the open flow on a deep-corrupt-but-envelope-valid canvas.json (fromObject throw is unguarded)**

- **Where:** `src/renderer/src/store/canvasStore.ts`:513-531 · **dimension:** type-contracts · **category:** silent-failure · **finder confidence:** high

**What it is.** applyOpenResult (and loadObject, lines 502-511) call fromObject(r.doc) synchronously inside a Zustand `set` reducer with NO try/catch. fromObject throws on any deep-validation failure (unknown board.type, non-finite x/y, malformed checklist item, bad tint, etc.). MAIN's recovery is asymmetric: projectStore.readProject/tryParse only fall back to canvas.json.bak when the file fails to PARSE or fails the shallow ENVELOPE check (isEnvelope = numeric schemaVersion + boards[] array). A canvas.json that is valid JSON with a valid envelope but deep-corrupt content (e.g. a board with type:'sticky', or a note with x:NaN, or a hand-edited/older third-party file) returns { ok:true, doc } from MAIN, so the renderer never gets the .bak fallback and fromObject throws into the React/Zustand call stack. All three open entry points are unguarded: App.tsx:29-32 (project.current on startup), WelcomeScreen.tsx:21, AppChrome.tsx:90/93/96 (project switch via switchTo).

**Impact.** Opening or auto-restoring a project whose canvas.json passes the envelope check but fails deep validation throws an uncaught exception during render-time state update, leaving the app on a broken/blank screen with no error surfaced and no .bak recovery — a data-availability failure for a recoverable file. On startup (App.tsx project.current) this can wedge the whole app at launch. The note in CLAUDE.md ('the 2026-05-31 black-screen regression') shows this class is exactly what bites here.

**Evidence.**

```ts
applyOpenResult: (r) => { if (!r.ok) { set(...); return } const d = fromObject(r.doc) ... } — fromObject called with no try/catch, inside set(). projectStore.readProject only guards the envelope: `return isEnvelope(v) ? v : undefined` (tryParse); isEnvelope = schemaVersion is number + Array.isArray(boards).
```

**Recommendation.** Wrap fromObject in try/catch at the store boundary (loadObject + applyOpenResult). On throw, set project.status:'error' with a recoverable message (and ideally ask MAIN to retry from canvas.json.bak), rather than letting it propagate. Symmetrically, MAIN's readProject could attempt deeper validation or expose a 'load .bak' fallback so a deep-corrupt primary degrades to the backup instead of surfacing as a renderer crash.

<details><summary>Adversarial verifier (confirmed)</summary>

The finding is genuine and accurately describes the code. The key evidence:

1. `boardSchema.ts:418-422` — `fromObject` calls `assertBoard` on every board, which throws via `fail()` (line 306) on any deep validation failure (unknown type, NaN coords, bad tint, malformed checklist item, etc.).

2. `canvasStore.ts:502-511` (`loadObject`) and `canvasStore.ts:513-531` (`applyOpenResult`) — both call `fromObject(...)` synchronously with no try/catch. A throw escapes the Zustand `set` reducer into the React call stack.

3. `projectStore.ts:34-41` — `isEnvelope` checks only `typeof schemaVersion === 'number'` and `Array.isArray(boards)`. Any canvas.json that passes this shallow check but contains e …

</details>

---

#### 4. `electron-33-eol-no-security-backports` _(verifier adjusted Critical → High)_

**Electron 33.4.11 is end-of-life (since 2025-04-29) and receives no security backports**

- **Where:** `package.json`:67 · **dimension:** deps-build · **category:** dep · **finder confidence:** high

**What it is.** The app pins Electron to `"electron": "^33.0.0"`, and the lockfile resolves it to electron@33.4.11. Electron 33 reached end-of-life on 2025-04-29 (endoflife.date/electron). As of the audit date (2026-06-04), Electron only backports security fixes to the latest THREE stable majors (currently 40/41/42). Electron 33 is ~7 majors and 13+ months past EOL, so every Chromium/V8/Node security advisory shipped since 2025-04-29 is unpatched in this app. Electron is the single highest-value dependency in a desktop app because it embeds a full Chromium + V8 + Node runtime that renders attacker-influenceable content: this app loads arbitrary user-supplied URLs in native WebContentsView browser-preview boards (src/main/preview.ts loadURL) and runs live CLI agents. An unpatched Chromium renderer RCE (the dominant CVE class for EOL Chromium) is directly reachable via the browser preview surface. The `engines.node: >=20` and CI node 22 do not affect the bundled Electron Node/Chromium.

**Impact.** Known, public, unpatched Chromium/V8/Node RCE and sandbox-escape CVEs accumulated over 13+ months are exploitable through the browser-preview WebContentsView, which loads arbitrary user URLs. A malicious or compromised page rendered in a preview board can leverage an unpatched renderer vulnerability; combined with any sandbox-escape CVE this reaches the host. This is a security-contract break (the whole isolation model assumes a patched Chromium).

**Evidence.**

```ts
package.json:67  "electron": "^33.0.0",   // lockfile -> electron@33.4.11; endoflife.date: Electron 33 "Ended 1 year ago (29 Apr 2025)"; supported majors = 40/41/42
```

**Recommendation.** Upgrade to a currently-supported Electron major (>=40, ideally latest stable) before any release; treat this as a release blocker. Re-verify node-pty beta rebuilds against the new ABI and re-run the e2e matrix. Going forward, pin to a supported major and add a recurring dependency-freshness check so EOL is caught automatically (see the missing-SCA finding).

<details><summary>Adversarial verifier (adjusted)</summary>

The finding is factually accurate on all key claims:

1. package.json line 67 confirms `"electron": "^33.0.0"` in devDependencies.
2. pnpm-lock.yaml line 1657/4799 confirms resolution to `electron@33.4.11`.
3. src/main/preview.ts confirms WebContentsView loads arbitrary user-supplied URLs (the attack surface is real).

The mitigating factors the auditor did not account for:
- The app does enforce `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false` on every WebContentsView (src/main/preview.ts lines 233-235) and the main window (src/main/windowSecurity.ts lines 18-27). These Electron-layer hardening settings reduce exploitability of some (but not all) Chromium renderer CVEs — …

</details>

---

### 🟨 Medium (8)

#### 5. `no-permission-handler-preview-views`

**No setPermissionRequestHandler/setPermissionCheckHandler on the preview sessions that load untrusted localhost content**

- **Where:** `src/main/preview.ts`:231-242 · **dimension:** electron-security · **category:** security · **finder confidence:** high

**What it is.** The per-board preview WebContentsViews load arbitrary localhost dev-server content (treated as untrusted per the hard contract). Each view is created on a fresh in-memory partition session (`partition: preview-${id}`), but NO permission handler is ever installed on any session in the entire main process (a repo-wide search for setPermissionRequestHandler / setPermissionCheckHandler returns zero hits; only setWindowOpenHandler and the nav guards are present). Electron's default permission behavior grants several permission classes without prompting for non-default sessions, and there is no central denial. A compromised or malicious localhost page rendered in a preview view could therefore request geolocation, notifications, media (camera/microphone via getUserMedia), clipboard-read, pointer-lock, etc., with no app-side gate.

**Impact.** Untrusted previewed web content can acquire sensitive device/OS capabilities (geolocation, camera/mic, notifications, clipboard) that the app never intends a localhost preview to have. Defense-in-depth gap directly relevant to the 'Browser-board content is untrusted' invariant; expands the attack surface of a preview-board compromise beyond the canvas.

**Evidence.**

```ts
const view = new WebContentsView({
  webPreferences: {
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    partition: `preview-${id}`
  }
})  // no session permission handler installed anywhere in main
```

**Recommendation.** Install a deny-by-default permission handler on each preview view's session (session.fromPartition(`preview-${id}`).setPermissionRequestHandler((wc, perm, cb) => cb(false)) and setPermissionCheckHandler(() => false)), or a single hook on app 'session-created'/web-contents-created. Allow only the specific permissions a localhost preview legitimately needs (likely none).

<details><summary>Adversarial verifier (confirmed)</summary>

The finding is confirmed by re-reading the actual code. A repo-wide search (`src/`) for `setPermissionRequestHandler`, `setPermissionCheckHandler`, `session-created`, and `web-contents-created` returns zero hits. The `ensure()` function in `src/main/preview.ts` (lines 231-242) creates a `WebContentsView` with a fresh `partition: preview-${id}` session on every new board, but never installs any permission handler on that session or on the app's `session-created` event. The existing mitigations in the file are: (1) `sandbox: true`/`contextIsolation: true`/`nodeIntegration: false` on the webPreferences; (2) `registerPreviewNavGuards` blocking non-http(s) scheme navigations; (3) `setWindowOpenHa …

</details>

---

#### 6. `packaged-fileurl-nav-allowed`

**will-navigate guard allows navigation to ANY file:// URL in the packaged build (origin 'null' == appOrigin null)**

- **Where:** `src/main/windowSecurity.ts`:63-76 · **dimension:** electron-security · **category:** security · **finder confidence:** high

**What it is.** navDecision compares ORIGINs. In a packaged build computeAppOrigin returns null (no ELECTRON_RENDERER_URL), and any file: URL is mapped to origin = null. Therefore `origin === appOrigin` is `null === null` → allow for EVERY file:// target, not just the app's own index.html. The main-window will-navigate/will-redirect/will-frame-navigate guards (index.ts:72-78) delegate to navDecision, so in the packaged app a navigation to e.g. file:///C:/Windows/win.ini or a dropped local HTML file is permitted. This is confirmed intentional by the unit test 'allows a file: URL when appOrigin is null (packaged build)' (windowSecurity.test.ts:75-81), but it contradicts the guard's own stated purpose (index.ts:59-64): preventing 'an accidental file/URL drop … [from replacing] the whole React app'. Electron's default file-drop-on-window behavior navigates to the dropped file unless prevented, and there is no global document-level dragover+drop preventDefault in the renderer (only board-scoped handlers exist, e.g. PlanningBoard.tsx:298 gated to the planning element) and no window.dragEnter handler in main.

**Impact.** In the packaged app, dropping a local file onto a non-board region of the window (or any renderer-issued file: navigation) can replace the entire React app — and every live PTY + native preview view — with an arbitrary local page, with no in-app way back. The loaded page runs sandboxed/no-nodeIntegration, so it is not RCE, but it is a denial-of-app and an information-surface (the file:// page can read sibling local files within file: scope). It is precisely the failure mode the guard documents itself as preventing, left open in the build mode that ships to users.

**Evidence.**

```ts
const u = new URL(url)
origin = u.protocol === 'file:' ? null : u.origin
...
if (origin === appOrigin) return { allow: true, openExternal: null }
// packaged: appOrigin === null, so EVERY file: URL is allowed
```

**Recommendation.** Pin the packaged guard to the app's actual document URL, not a null origin: in packaged mode allow only the exact app file path (e.g. compare against the resolved index.html href, or compute appOrigin from mainWindow.webContents.getURL() at load) and deny all other file: URLs. Additionally add a global window/document dragover+drop preventDefault (the standard Electron file-drop hardening) so a stray file drop can never initiate navigation.

<details><summary>Adversarial verifier (confirmed)</summary>

The finding is confirmed by reading the actual code.

In `src/main/windowSecurity.ts` lines 69-74, `navDecision` maps every `file:` URL to `origin = null`:
```ts
const u = new URL(url)
origin = u.protocol === 'file:' ? null : u.origin
```
Then at line 74: `if (origin === appOrigin) return { allow: true, openExternal: null }`.

In the packaged build, `computeAppOrigin(process.env['ELECTRON_RENDERER_URL'])` returns `null` (no env var set), so `appOrigin === null`. The guard therefore evaluates `null === null → true` and allows navigation to ANY `file://` URL, not just the app's own `index.html`.

The unit test in `src/main/windowSecurity.test.ts` lines 75-81 explicitly asserts and names this b …

</details>

---

#### 7. `deep-validation-throw-no-bak-fallback` _(verifier adjusted High → Medium)_

**Deep-validation failure in fromObject throws uncaught with NO .bak fallback (claimed recovery path does not exist)**

- **Where:** `src/renderer/src/store/canvasStore.ts`:502-520 · **dimension:** persistence · **category:** silent-failure · **finder confidence:** high

**What it is.** MAIN's readProject falls back to canvas.json.bak ONLY when the *envelope* check fails (parse error, or missing numeric schemaVersion / non-array boards). The DEEP validation (assertBoard / assertPlanningElement) lives in the renderer's fromObject and throws a plain Error on any structural mismatch (e.g. a board with a non-string title, an unknown element kind, a stroke with odd-length points, a checklist with a malformed item). Both renderer call sites — loadObject (line 503) and applyOpenResult (line 518) — call `const d = fromObject(...)` with NO try/catch, and the only caller (WelcomeScreen.openDir/onCreate, AppChrome.switchTo) does not wrap them either. So an envelope-valid-but-deep-corrupt canvas.json produces an unhandled exception in a React event handler: the store never flips to status 'error', the user gets no message, and there is NO automatic fall-through to canvas.json.bak. The boardSchema.ts comment (line 276-279) explicitly claims 'fromObject throws and the persistence layer can fall back to the backup' — but that backup fallback is never wired for deep-validation failures, only envelope failures.

**Impact.** A canvas.json that is JSON-parseable and envelope-valid but deep-invalid (hand-edit, an agent CLI writing into the project folder, OneDrive/network-share partial sync, or a future renderer serialization bug) makes the project un-openable with no graceful recovery and no surfaced error, even though a good canvas.json.bak may sit right next to it. The documented recovery contract is broken.

**Evidence.**

```ts
loadObject: (doc) => {\n    const d = fromObject(doc)   // throws uncaught on deep-invalid input; no try/catch, no .bak fallback\n...\n  applyOpenResult: (r) => {\n    if (!r.ok) { ... }\n    const d = fromObject(r.doc) // same — uncaught throw, no recovery
```

**Recommendation.** Wrap the renderer fromObject calls in try/catch; on throw, set project.status='error' with a recoverable message, OR (better) have MAIN run the same deep validation and perform the canvas.json -> canvas.json.bak fall-through there so the claimed recovery actually exists. At minimum, route the deep-invalid case to a re-attempt against .bak before failing.

<details><summary>Adversarial verifier (confirmed)</summary>

The finding is confirmed by direct code reading. The architecture has a deliberate split: MAIN's `readProject` (`src/main/projectStore.ts` lines 43-59) uses `tryParse()` which applies only an envelope check via `isEnvelope()` — it passes any JSON value that has a numeric `schemaVersion` and an array `boards`. The `.bak` fallback is triggered only when `tryParse` returns `undefined` (parse error or failed envelope). If the primary file passes this shallow check, `readProject` returns `{ok:true, doc: <partially-corrupt value>}` and never touches `.bak`.

Deep validation lives entirely in the renderer's `fromObject` (`src/renderer/src/lib/boardSchema.ts` line 418), where `assertBoard` (line 378 …

</details>

---

#### 8. `no-error-boundary`

**No React error boundary anywhere — any render/effect throw blanks the entire app**

- **Where:** `src/renderer/src/main.tsx`:1-7 · **dimension:** renderer-react · **category:** silent-failure · **finder confidence:** high

**What it is.** The renderer root mounts <App/> with no error boundary (and no StrictMode) at any level — not at the root, not around Canvas, and not around the per-type board dispatch in BoardNode. A grep for componentDidCatch/getDerivedStateFromError/ErrorBoundary across the renderer returns zero matches. Each board type is lazy-loaded behind <Suspense fallback={null}> (BoardNode lines 216-224) which catches the loading promise but NOT thrown errors. A throw in any board's render (malformed PlanningElement, a bad checklist/note, a vector hit-test edge case) or in any of the many effects propagates straight to the React root and unmounts the whole tree to a blank screen.

**Impact.** A single malformed board or render-path bug takes down the ENTIRE canvas to a black screen with no in-app recovery — exactly the 'black-screen regression' failure class the project already flagged (memory e2e-before-handoff). Because autosave is debounced ~1s, an unmount can also lose the most recent edits. One bad board cannot be isolated from the rest.

**Evidence.**

```ts
ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(<App />)
```

**Recommendation.** Wrap the board dispatch in BoardNode (around the <Suspense> subtree) in a per-board error boundary that renders a fallback 'board failed' card instead of crashing the canvas, and add a top-level boundary in main.tsx as a backstop. Consider StrictMode in dev to surface effect-cleanup bugs.

<details><summary>Adversarial verifier (confirmed)</summary>

The code exactly matches the auditor's evidence. In `/src/renderer/src/main.tsx` line 7, the root mounts `<App />` with no wrapper: `ReactDOM.createRoot(...).render(<App />)`. In `App.tsx`, `<App>` renders either `<Canvas />` or `<WelcomeScreen />` with no boundary around them. In `BoardNode.tsx` lines 216-224, the per-board dispatch is wrapped only in `<Suspense fallback={null}>`, which catches loading promises but not thrown render errors. A repo-wide grep for `componentDidCatch`, `getDerivedStateFromError`, `ErrorBoundary`, and `react-error-boundary` returns zero matches across the entire renderer tree. Any render throw in a board component (malformed PlanningElement, a bad checklist/note …

</details>

---

#### 9. `image-paste-drop-lost-update`

**Async image paste/drop commits with a stale `elements` snapshot → lost updates / overwrite**

- **Where:** `src/renderer/src/canvas/boards/PlanningBoard.tsx`:234-256 · **dimension:** renderer-react · **category:** race · **finder confidence:** high

**What it is.** addImageFromBlob closes over `elements` (deps [beginChange, commit, elements]) but performs two awaits before committing — `window.api.asset.write(...)` and `createImageBitmap(...)`. It then calls `commit([...elements, makeImage(...)])` using the `elements` captured at call time. `updateBoard` in the store fully REPLACES the elements array (canvasStore.updateBoard maps and assigns `safe[key] = src[key]`), it does not merge. So any element edit that lands during the async window (another paste, a drag commit, a note edit, an erase) is silently discarded when the stale-base commit lands. The same pattern flows through onWellPaste (line 265-290) and onWellDrop (line 302-312).

**Impact.** Pasting/dropping an image while (or just before) any other whiteboard edit completes can wipe that other edit — silent data loss with no error. Two images pasted in quick succession can drop the first. Limited blast radius (requires concurrent edits during a decode/disk write, ~tens to hundreds of ms).

**Evidence.**

```ts
const bytes = new Uint8Array(await blob.arrayBuffer())
      const res = await window.api.asset.write(bytes, ext)
      ...
        const bmp = await createImageBitmap(blob)
      ...
      beginChange()
      commit([...elements, makeImage(newId(), at, res.assetId, w, h)])
```

**Recommendation.** Re-read the live elements at commit time instead of using the captured closure: `const cur = useCanvasStore.getState().boards.find(b=>b.id===board.id)?.elements ?? []; commit([...cur, makeImage(...)])`. This mirrors the getState() pattern already used elsewhere (growForChecklist).

<details><summary>Adversarial verifier (confirmed)</summary>

The bug is genuine. In `addImageFromBlob` (PlanningBoard.tsx line 234-256), `elements` is captured at call time from `board.elements` (line 155: `const elements = board.elements`). The function then performs two sequential awaits: `await blob.arrayBuffer()` → `await window.api.asset.write(bytes, ext)` (an IPC call that does a real disk write, ~10-200ms) → `await createImageBitmap(blob)` (image decode, another async op). Only after all three awaits does it call `commit([...elements, makeImage(...)])`.

`commit` is `(next) => updateBoard(board.id, { elements: next })`, and `updateBoard` in the store (canvasStore.ts line 340-370) does a full replace — `safe[key] = src[key]` — with no merge. If …

</details>

---

#### 10. `index-quit-shutdown-untested` _(verifier adjusted High → Medium)_

**index.ts quit/flush/shutdown/crash orchestration (data-loss + orphan prevention) is untested at every tier**

- **Where:** `src/main/index.ts`:164-242 · **dimension:** tests-coverage · **category:** test-gap · **finder confidence:** high

**What it is.** None of the lifecycle orchestration in index.ts is tested: shutdown() (the idempotent native-resource teardown that drains PTY trees, #49), flushRenderer() (BUG-M2 — asks the renderer to flush its debounced autosave before the hard app.exit(0), with a reply-channel + timeout fallback), the guarded before-quit ordering (preventDefault → flush → drain → exit), and the crash/signal handlers (crashShutdown for uncaughtException/unhandledRejection/SIGINT/SIGTERM, #50). These are pure-ish coordination functions with clear branch logic (the `done`/`quitting`/`crashing` idempotency guards, the timeout race in flushRenderer) that could be extracted and unit-tested, but none is. The whole quit/crash path is verified only by manual runs. The TESTING.md MAIN/IPC row claims 'none' for e2e here, but the unit/integration tier doesn't cover this orchestration either — it falls through the cracks.

**Impact.** A regression in flushRenderer's reply/timeout logic loses the last ~1s of unsaved edits on quit (the exact bug BUG-M2 fixed); a regression in the before-quit await ordering or the crashShutdown idempotency re-introduces orphaned agent child-process trees on crash/signal (the #49/#50 class). Both are silent — they only surface as lost work or zombie processes in production.

**Evidence.**

```ts
function flushRenderer(timeoutMs = 1500): Promise<void> { ... const timer = setTimeout(finish, timeoutMs); ipcMain.once(replyChannel, finish); ... }  and  app.on('before-quit', (event) => { if (quitting) return; quitting = true; event.preventDefault(); void flushRenderer().then(() => shutdown()).finally(() => app.exit(0)) })
```

**Recommendation.** Extract the flush/shutdown coordination (the finish-once + timeout race, the quitting/crashing latches) into pure helpers in a testable module and unit-test: flush resolves on reply, flush resolves on timeout when no reply, the latch makes before-quit idempotent, crashShutdown fires shutdown exactly once across multiple signals. Keep the app.on(...) wiring thin.

<details><summary>Adversarial verifier (adjusted)</summary>

The code at src/main/index.ts lines 164-242 exists exactly as quoted: `flushRenderer` (the `done`-once + timeout race, lines 180-202), `shutdown` (lines 164-170), the `quitting`-latched `before-quit` handler (lines 216-224), and `crashShutdown` with the `crashing` latch (lines 231-242). No test file covering these functions exists — `src/main/index*.test.ts` returns no results, and a grep for `flushRenderer|shutdown|crashShutdown|before-quit|quitting|crashing` across `src/` matches only `index.ts`, `pty.ts`, and `preview.ts` (no test files). TESTING.md line 96 lists `index.ts` under the "MAIN / IPC" integration row but the lifecycle orchestration is not the IPC handler layer — it is the modu …

</details>

---

#### 11. `no-dependency-vuln-scanning` _(verifier adjusted High → Medium)_

**No dependency vulnerability scanning anywhere (no pnpm audit, Dependabot, CodeQL, or SCA in CI)**

- **Where:** `.github/workflows/pr.yml`:26-31 · **dimension:** deps-build · **category:** dep · **finder confidence:** high

**What it is.** The CI gate (pr.yml, staging.yml, production.yml `check` job) runs only `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test`, `pnpm build`. There is no `pnpm audit`, no Dependabot config (.github/dependabot.yml absent), and no CodeQL/Snyk/Trivy/osv-scanner step. A repo-wide grep for `pnpm audit|npm audit|dependabot|snyk|trivy|codeql|osv-scanner` across .github/, .githooks/, and package.json returns nothing. This is precisely why the EOL Electron above was able to sit unflagged for 13+ months. With supply-chain-sensitive deps in play (a pinned node-pty BETA, electron-updater, simple-git, a full Electron toolchain), there is no automated signal when a transitive dep ships a known CVE.

**Impact.** Known-vulnerable direct or transitive dependencies (including the EOL Electron and any future CVE in node-pty/simple-git/electron-updater) ship silently with no CI signal. There is no mechanism to detect or pin out a compromised/yanked package version. Increases dwell time of exploitable deps from 'caught at PR' to 'caught never'.

**Evidence.**

```ts
.github/workflows/pr.yml:27-31  - run: pnpm typecheck / - run: pnpm lint / - run: pnpm format:check / - run: pnpm test / - run: pnpm build   (no audit/SCA step); grep for audit|dependabot|snyk|trivy|codeql across .github + package.json => empty; .github/dependabot.yml absent
```

**Recommendation.** Add a SCA gate: `pnpm audit --audit-level=high` as a non-blocking-then-blocking CI step, plus a `.github/dependabot.yml` (or Renovate) for automated bump PRs, and consider GitHub CodeQL for the JS/TS. At minimum wire a scheduled job that fails when a direct dep is EOL/has a known advisory.

<details><summary>Adversarial verifier (adjusted)</summary>

The finding is factually correct in every detail. Reading the actual files confirms: (1) `.github/` contains exactly three files — pr.yml, staging.yml, production.yml — and nothing else; no dependabot.yml exists. (2) The `check` job in pr.yml lines 26-31 runs exactly `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test`, `pnpm build` — no audit or SCA step. (3) A grep for audit|dependabot|snyk|trivy|codeql|osv-scanner|renovate across .github/ and package.json returns zero matches. The absence of any dependency vulnerability scanning is confirmed real.

Severity is adjusted down from High to Medium for two reasons grounded in the actual project cont …

</details>

---

#### 12. `browserpreviewlayer-god-file-982-loc`

**BrowserPreviewLayer.tsx is a 982-line module concentrating the entire native-view lifecycle, motion FSM, occlusion policy, full-view pump, and IPC plumbing**

- **Where:** `src/renderer/src/canvas/boards/BrowserPreviewLayer.tsx`:135-982 · **dimension:** perf-arch · **category:** arch · **finder confidence:** high

**What it is.** A single component (135-982) owns: per-board bookkeeping (recs/geomRef/demoting refs), bounds/zoom geometry helpers (boundsFor/zoomFor/fullViewBoundsFor/stageScreenRect, 202-326), the attach/detach/close primitives (328-455), the per-frame flushBatch + startPump (457-491), the motion FSM (beginMotion/applyLiveness/endMotion, 493-646), three separate rAF/effect pumps (camera via useOnViewportChange:648, node-gesture/menu effect:660-667, focus effect:672-685, full-view dedicated rAF:694-738), the store reconcile subscription (743-891), pane measurement (893-912), and the main->renderer lifecycle event router (915-970). The file carries ~20 numbered bug-fix comments (#8/#9/#15/#18/#20/#24/#30/#32/#43961/#44/#45/#48 etc.) indicating the concentration of subtle ordering invariants in one closure. The attachBoard/demoteToSnapshot/applyLiveness functions share a web of refs (attachSeq, demoting, gestureRef) whose correctness depends on read/write ordering that is impossible to unit-test in isolation here.

**Impact.** Extremely high cognitive load and regression surface for the most invariant-sensitive subsystem in the app (native views paint above all HTML, so a sequencing bug = a stuck/ghost frame). The pure decision logic was already split to previewPlan.ts/cameraBounds.ts, but the stateful orchestration remains monolithic, so the many race-window fixes can only be verified end-to-end (e2e), not by targeted tests.

**Evidence.**

```ts
// File spans 135-982; e.g. applyLiveness (561-632), beginMotion (495-554), reconcile (743-839),
// full-view rAF (694-738), lifecycle router (915-970) — all in one component closure sharing
// recs/geomRef/demoting/gestureRef/attachSeq refs.
```

**Recommendation.** Extract a framework-free `PreviewManager` class (instantiated once via a ref) that owns recs/geom/demoting and exposes attach/detach/reconcile/applyLiveness/flushBatch as methods taking explicit (viewport, paneOffset, fullView) inputs. The component becomes a thin adapter wiring useOnViewportChange/store-subscribe/effects to manager method calls. This makes the attachSeq/gesture ordering invariants directly unit-testable (the class is pure given inputs + a mockable window.api) and shrinks the React file to wiring.

<details><summary>Adversarial verifier (confirmed)</summary>

The file at Z:\Canvas ADE\src\renderer\src\canvas\boards\BrowserPreviewLayer.tsx is confirmed to be 982 lines. The component body (lines 135-982) contains all the logic the auditor described: geometry helpers (boundsFor/zoomFor/fullViewBoundsFor/stageScreenRect, lines 202-326), attach/detach/close primitives (lines 328-455), flushBatch+startPump (lines 457-491), the motion FSM (beginMotion/applyLiveness/endMotion, lines 493-646), three separate rAF/effect pumps (camera via useOnViewportChange at line 648, node-gesture/menu effect at 660-667, focus effect at 672-685, full-view dedicated rAF at 694-738), the store reconcile subscription (lines 743-891), pane measurement (lines 893-912), and th …

</details>

---

### 🟦 Low (34)

#### 13. `prod-csp-style-unsafe-inline`

**Production CSP retains style-src 'unsafe-inline' and has no frame-ancestors/object-src/base-uri directives**

- **Where:** `electron.vite.config.ts`:27-29 · **dimension:** electron-security · **category:** security · **finder confidence:** high

**What it is.** PROD_CSP correctly drops script-src 'unsafe-inline' (the meaningful XSS win) but keeps style-src 'unsafe-inline' (documented tradeoff for React inline style attributes + xterm runtime styles — acceptable and explained). However the policy omits hardening directives that have no app cost: object-src 'none', base-uri 'self' (or 'none'), and frame-ancestors 'none'. Without base-uri an injected <base> tag could repoint relative URLs; without object-src 'none' legacy plugin/embeds are not blocked. style-src 'unsafe-inline' also leaves CSS-injection-based exfil/UI-redress vectors open if an HTML-injection foothold ever exists in the renderer.

**Impact.** Limited: the renderer is sandboxed, contextIsolated, and script-src 'self' blocks the primary XSS vector in prod, so the residual risk is low and conditional on an HTML-injection bug existing. Still a free hardening gap vs a strict CSP.

**Evidence.**

```ts
const PROD_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: blob:; font-src 'self'; connect-src 'self'"
```

**Recommendation.** Append `object-src 'none'; base-uri 'self'; frame-ancestors 'none'` to PROD_CSP (and DEV_CSP). Track removing style-src 'unsafe-inline' via a style-nonce/class refactor as a longer-term item, but the three additions above are zero-cost now.

<details><summary>Adversarial verifier (confirmed)</summary>

The code at Z:\Canvas ADE\electron.vite.config.ts lines 27-29 exactly matches the quoted evidence. PROD_CSP reads: "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'" — confirming the absence of object-src, base-uri, and frame-ancestors directives. The style-src 'unsafe-inline' retention is intentional and documented in the comment at lines 18-22 ("CSP nonces cannot authorize inline style ATTRIBUTES — only style/link elements"). No compensating controls elsewhere address the three missing directives. The finding is real: these are genuine hardening gaps. However, the Low severity is correct and arguably ge …

</details>

---

#### 14. `pty-resize-unbounded`

**pty.resize() receives unvalidated cols/rows from the data-plane port (no integer/range/positivity check)**

- **Where:** `src/main/pty.ts`:503-515, 159-169 · **dimension:** pty-terminal · **category:** input-validation · **finder confidence:** high

**What it is.** Both the spawn-time port listener and the adopt-time port listener forward resize messages to node-pty with only a truthiness guard: `else if (m.t === 'resize' && m.cols && m.rows) proc.resize(m.cols, m.rows)`. There is no `Number.isInteger`, positivity, or upper-bound check on `m.cols`/`m.rows`. The message shape is typed `{ cols?: number; rows?: number }` but the payload arrives over a MessagePort and is consumed as-is. In normal operation the values originate from xterm's `onResize` (trusted, sane integers), but the bridge itself performs no validation — a non-integer (e.g. 80.5), zero-after-truthiness-only, or absurdly large value would be passed straight into ConPTY's resize. node-pty's write/resize is already known to THROW on edge cases (the code wraps it in try/catch precisely for the exited-pty case), so a bad resize is caught and swallowed rather than crashing, which is why this is Low not higher.

**Impact.** A malformed resize value reaches the OS pseudo-console resize call. Worst realistic case is a caught throw (swallowed) or a transiently mis-sized grid; there is no memory-safety or injection consequence because the renderer that owns the port is the trusted main frame. No leak/crash path proven.

**Evidence.**

```ts
`if (m.t === 'input' && typeof m.d === 'string') proc.write(m.d)
        else if (m.t === 'resize' && m.cols && m.rows) proc.resize(m.cols, m.rows)` (lines 510-511; identical guard at 164-165). Note the asymmetry: `input` is type-checked (`typeof m.d === 'string'`) but `resize` is only truthiness-checked.
```

**Recommendation.** Validate before resizing: `if (m.t === 'resize' && Number.isInteger(m.cols) && Number.isInteger(m.rows) && m.cols! > 0 && m.rows! > 0 && m.cols! <= 1000 && m.rows! <= 1000) proc.resize(m.cols!, m.rows!)`. Mirror the `typeof` rigor already applied to the input branch.

<details><summary>Adversarial verifier (confirmed)</summary>

The code at lines 510-511 (spawn-time port listener) and 164-165 (adopt-time port listener) is exactly as described. Both locations use `m.cols && m.rows` (truthiness only) for resize, while the input branch uses `typeof m.d === 'string'` (type-checked). The asymmetry is genuine: a non-integer like `80.5`, a float `0.5` (truthy but invalid), or an absurdly large number would pass the guard and reach `proc.resize()`. The defect is real code quality issue.

However, severity stays Low and is not higher because:
1. The try/catch at lines 509-514 (and 163-168) already wraps the entire dispatch block. Any throw from `proc.resize()` on a bad value is caught and silently swallowed.
2. The MessagePo …

</details>

---

#### 15. `baseurl-no-scheme-validation-ssrf` _(verifier adjusted Medium → Low)_

**local-provider baseUrl is an unvalidated egress target (no scheme/host check) — board content exfiltration with no key, no gesture**

- **Where:** `src/main/llmService.ts`:70-84 · **dimension:** llm-egress · **category:** security · **finder confidence:** high

**What it is.** For provider==='local', buildRequest uses config.baseUrl verbatim as the request URL (`url: ${base}/chat/completions`) with no validation of scheme or host. baseUrl is set by the renderer via the llm:setConfig IPC (llmIpc.ts:118-137) and persisted by readLlmConfig with only a `typeof === 'string'` check (llmConfig.ts:57) — no http(s)-only / no-credentials-in-URL / no-internal-host guard. The local provider needs NO key (getProvider returns a provider when baseUrl is set, llmService.ts:165-170), so any renderer-side foothold (or a future untrusted in-renderer surface) can point summaries at an arbitrary endpoint and exfiltrate the SummarizeInput.text (which includes terminal launchCommand/cwd, browser URLs, planning note text — see summaryLoop.boardContent) over the network, budget-capped but with no user gesture. The major providers (openrouter/openai/anthropic) are hardcoded and NOT overridable, which is the right control; local is the one hole.

**Impact.** A compromised/buggy renderer can redirect summaries containing project board content to an attacker-controlled host (SSRF / data exfiltration), with no API key required and no user interaction. Also enables hitting internal/metadata endpoints if a fetch follows.

**Evidence.**

```ts
if (provider === 'local') {
    if (!config.baseUrl) throw new Error('local provider requires a baseUrl in config')
    base = config.baseUrl
  } else {
    base = OPENAI_SHAPE_BASE[provider]
  }
  return {
    url: `${base}/chat/completions`,
```

**Recommendation.** Validate baseUrl on the trust boundary (in llm:setConfig and/or buildRequest): require new URL(baseUrl).protocol to be 'http:'|'https:', reject embedded credentials (username/password), and consider restricting to loopback/private ranges by default with an explicit opt-in for LAN. This is documented as accepted residual risk in ADR 0003 §'Accepted residual risk', so it is a known/accepted trade-off — flagging because a one-line scheme guard removes the file://-style and credential-in-URL footguns cheaply without breaking LM Studio/Ollama use.

<details><summary>Adversarial verifier (adjusted)</summary>

The finding is genuine and accurately describes the code. Confirmed by direct reading:

1. `llmConfig.ts:57` — `baseUrl` sanitization is only `typeof p.baseUrl === 'string' ? p.baseUrl : undefined` — no scheme, host, or credential validation.
2. `llmService.ts:71-73` — `base = config.baseUrl` used verbatim, no URL parsing or scheme guard before `url: \`${base}/chat/completions\`` is returned.
3. `llmIpc.ts:118-137` (`llm:setConfig`) — accepts `baseUrl?: string` from the renderer with only the frame guard (`isForeignSender`), no content validation of the URL itself.
4. `llmService.ts:165` — `config.provider !== 'local' && !key` gates the key check, so `local` explicitly requires no key.

Howe …

</details>

---

#### 16. `setconfig-baseurl-not-gated-to-local`

**llm:setConfig persists baseUrl for ANY provider (not gated to local); inert today but a latent egress-redirect if buildRequest ever honors it**

- **Where:** `src/main/llmIpc.ts`:118-137 · **dimension:** llm-egress · **category:** arch · **finder confidence:** high

**What it is.** The llm:setConfig handler stores a.baseUrl unconditionally for every provider, not just 'local'. Currently buildRequest only reads config.baseUrl when provider==='local' (openrouter/openai use the hardcoded OPENAI_SHAPE_BASE and anthropic is hardcoded), so a baseUrl stored against e.g. 'openai' is inert. But the persisted config now silently carries a user/renderer-controlled baseUrl on hardcoded-destination providers; if a future refactor ever lets buildRequest honor config.baseUrl for the OpenAI shape (a plausible 'custom OpenAI-compatible endpoint' feature), the hardcoded-destination guarantee for openai/openrouter would be quietly broken with no new validation. The renderer UI only sends baseUrl for local (SettingsModal.tsx:64), so this is reachable only via a crafted IPC call.

**Impact.** Defense-in-depth gap: the IPC layer does not enforce the 'only local has a baseUrl' invariant that buildRequest currently relies on, leaving a latent way to redirect a major provider's egress if the read/use side changes.

**Evidence.**

```ts
const cfg: LlmConfig = {
        provider: a.provider,
        model: a.model,
        baseUrl: a.baseUrl,
        maxCallsPerDay: a.maxCallsPerDay ?? existing.maxCallsPerDay
      }
```

**Recommendation.** In setConfig, only persist baseUrl when a.provider === 'local' (baseUrl: a.provider === 'local' ? a.baseUrl : undefined), matching the SettingsModal contract and making the 'hardcoded destination for major providers' guarantee enforced at the trust boundary rather than relying on buildRequest's read-side branch.

<details><summary>Adversarial verifier (confirmed)</summary>

The finding is confirmed as stated, but the Low severity is correct and arguably generous. 

In llmIpc.ts lines 128-133, `cfg.baseUrl = a.baseUrl` is stored unconditionally regardless of provider — confirmed by direct read.

In llmService.ts lines 70-76, buildRequest only reads `config.baseUrl` when `provider === 'local'`. For `openrouter`/`openai` it uses the hardcoded `OPENAI_SHAPE_BASE` constant, and for `anthropic` the URL is hardcoded to `'https://api.anthropic.com/v1/messages'`. So the stored baseUrl on a non-local provider is currently 100% inert.

The SettingsModal.tsx line 64 confirms the normal UI path only sends `baseUrl: provider === 'local' && baseUrl ? baseUrl : undefined`, so …

</details>

---

#### 17. `downgrade-newer-schema-crash-plus-asset-gc` _(verifier adjusted Medium → Low)_

**Opening a newer-schemaVersion project in an older app throws uncaught AND has already GC'd assets (downgrade data loss)**

- **Where:** `src/renderer/src/lib/boardSchema.ts`:246-262 · **dimension:** persistence · **category:** silent-failure · **finder confidence:** high

**What it is.** migrate() throws 'document schemaVersion N is newer than supported M' when a doc's schemaVersion exceeds SCHEMA_VERSION (boardSchema.ts line 250-254), and likewise throws on a missing migration step (e.g. schemaVersion:0 or a gap). Because fromObject is called without try/catch (finding #1), a project saved by a newer app build (or auto-updated on one machine, opened on an older build elsewhere via a synced folder) crashes the open with no 'this project is too new' message. Worse, the envelope check passes (schemaVersion is numeric, boards is an array), so MAIN already returned the doc AND already ran the version-independent gcAssets/scaffold — meaning a future schema that stored assets differently could have its blobs swept by the older app's collectAssetIds before migrate even throws.

**Impact.** Version skew across app builds on a shared/synced project folder (a realistic post-Phase-5 auto-update scenario) yields an un-openable project with no user-facing explanation, and the older app may delete blobs it doesn't understand. Classic downgrade-corruption.

**Evidence.**

```ts
if (doc.schemaVersion > SCHEMA_VERSION) {\n    throw new Error(\n      `migrate: document schemaVersion ${doc.schemaVersion} is newer than supported ${SCHEMA_VERSION}`\n    )\n  }
```

**Recommendation.** Catch the newer-version / missing-migration throw at the renderer load sites and surface a distinct 'project requires a newer app version' state (do not fall to .bak, which would also be too-new). Skip/defer gcAssets whenever the doc fails to validate or is newer than supported.

<details><summary>Adversarial verifier (adjusted)</summary>

The uncaught-throw half of the finding is confirmed. In `canvasStore.ts` lines 518 and 503, `fromObject(r.doc)` / `fromObject(doc)` are called without try/catch. When `migrate()` throws its "schemaVersion N is newer than supported M" error (boardSchema.ts lines 250-254), the exception propagates unhandled through `applyOpenResult` (called from WelcomeScreen.tsx line 21 and App.tsx line 30, neither of which has a .catch() or try/catch), and there is no React ErrorBoundary anywhere in the renderer tree. The app will crash the React render silently with no "this project requires a newer app version" message. That part of the finding is real.

The asset-GC half is partially overstated. The GC ru …

</details>

---

#### 18. `bak-rotation-non-atomic-copy`

**canvas.json -> .bak rotation uses non-atomic copyFileSync; a crash mid-copy can clobber a good backup with a torn one**

- **Where:** `src/main/projectStore.ts`:73-82 · **dimension:** persistence · **category:** race · **finder confidence:** medium

**What it is.** writeProject rotates the prior good primary into the backup via copyFileSync(primary, bak) (line 76) and then writeFileAtomic for the new primary (line 81). copyFileSync is NOT atomic — a crash/power loss during the copy can leave canvas.json.bak truncated. On the next read tryParse(bak) would reject the torn file (parse/envelope guard), so it is correctly ignored rather than served as data — but it means the only backup of the last-good state has been overwritten by garbage. If the primary subsequently becomes corrupt (a separate later event), there is no usable .bak. The new primary write is atomic, so the primary itself is never torn; only the recovery copy is at risk.

**Impact.** Narrow timing window, and a torn .bak is detected and skipped (no bad data is served). Worst case is loss of the backup-of-last-resort during an unlucky crash, weakening the two-file recovery guarantee.

**Evidence.**

```ts
if (tryParse(primary) !== undefined) {\n    try {\n      copyFileSync(primary, join(dir, CANVAS_BAK))   // non-atomic; torn on crash\n    } catch { ... }\n  }\n  await writeFileAtomic(primary, JSON.stringify(doc, null, 2), 'utf8')
```

**Recommendation.** Rotate atomically: copy primary -> bak.tmp then rename bak.tmp -> bak (rename is atomic on the same volume), or write the new primary first and only then promote the previous primary to .bak. Optional given the torn-bak is already detected on read.

<details><summary>Adversarial verifier (confirmed)</summary>

The code at lines 73-81 of src/main/projectStore.ts confirms the finding exactly. The rotation sequence is: (1) `tryParse(primary)` to check validity, (2) `copyFileSync(primary, join(dir, CANVAS_BAK))` at line 76 — a non-atomic kernel copy — and (3) `await writeFileAtomic(primary, ...)` at line 81 — which IS atomic. A crash during step 2 can leave `canvas.json.bak` truncated. The `tryParse` function (lines 43-51) wraps `JSON.parse` in a try/catch and returns `undefined` on any parse failure, so a torn `.bak` is correctly skipped on the next `readProject` call (lines 57-58) — no corrupt data is ever served. The real-but-narrow risk is: crash mid-copy corrupts `.bak`, then later (separate even …

</details>

---

#### 19. `tolerated-phantom-undo-step`

**add/remove/duplicate leave a TOLERATED phantom undo step after a post-action no-op gesture (documented #BUG M3 edge)**

- **Where:** `src/renderer/src/store/canvasStore.ts`:129-148, 466-483 · **dimension:** store-undo · **category:** correctness · **finder confidence:** high

**What it is.** `trackedChange` is called with `reflectPresent:false` for addBoard/removeBoard/duplicateBoard (lines 287, 305-308, 334-336), so the module `lastRecorded` is NOT synced to the new present. After one of these tracked actions, if the user then starts but commits nothing in a gesture (a zero-movement titlebar/resize-handle click, or a degenerate arrow/pen tap), `beginChange` (line 474) sees neither `past[last] === boards` (the past tail is the PRE-action snapshot, not the post-action boards) nor `lastRecorded === boards` (lastRecorded is stale/null), so it pushes a duplicate snapshot whose present equals the current boards — a phantom undo step. The first Undo then appears to do nothing and a second Undo is needed. This is explicitly documented as the accepted tradeoff (lines 138-148, 425-436, test header at canvasStore.test.ts:370-376): closing it at the store layer would sync lastRecorded and break the granular-move-undo invariant (a board's FIRST move would coalesce into its add step). The real fix is a gesture-layer lazy checkpoint (WB-1), not a store change.

**Impact.** After add/remove/duplicate, a single stray no-op click can require the user to press Undo twice to reverse the action. Cosmetic UX wart, no data loss or corruption.

**Evidence.**

```ts
set((s) => trackedChange(s, [...s.boards, board], { selectedId: id, reflectPresent: false }))   // addBoard
// ...
if (s.past[s.past.length - 1] === s.boards || lastRecorded === s.boards) return s   // beginChange guard misses post-add no-op
```

**Recommendation.** No store-layer change (would regress granular move-undo, proven by the undo/redo suite). If the double-undo UX is worth closing, implement the gesture-layer lazy checkpoint (defer beginChange's actual snapshot until the first real mutation of the gesture) tracked as WB-1.

<details><summary>Adversarial verifier (confirmed)</summary>

The code at `src/renderer/src/store/canvasStore.ts` confirms every claim in the finding.

`addBoard` (line 287), `removeBoard` (lines 305-308), and `duplicateBoard` (lines 334-336) all call `trackedChange` with `reflectPresent: false`. The `trackedChange` function (line 166) only sets `lastRecorded = next` when `opts.reflectPresent` is true — so after any of these three operations, `lastRecorded` remains stale (either null or pointing at the pre-action boards array).

`beginChange` (lines 466-482) skips pushing a snapshot only when `s.past[s.past.length - 1] === s.boards` OR `lastRecorded === s.boards`. After add/remove/duplicate: the past tail is the PRE-action snapshot (not current boards) …

</details>

---

#### 20. `bare-1-0-keys-fire-while-well-focused`

**Bare `1`/`0` global camera shortcuts fire while the Planning well (focusable div) has focus**

- **Where:** `src/renderer/src/canvas/Canvas.tsx`:682-688 · **dimension:** renderer-react · **category:** type · **finder confidence:** high

**What it is.** The global window keydown handler treats `1` (fitView) and `0` (recenter) as bare-key shortcuts, guarded only by `typing` (INPUT/TEXTAREA/contentEditable). The Planning content well is `tabIndex={0}` — a focusable <div>, NOT contentEditable — and it is explicitly focused on empty-well press (PlanningBoard line 483) and after selecting a vector (line 1091). The well's own onKeyDown handles Delete/Backspace and the s/n/c/a/p/e tool letters but does NOT stopPropagation for `1`/`0` (shortcutTool returns null for them, tools.ts). So pressing `1` or `0` while the well is focused bubbles to window and jumps the camera. The exact same hazard for the `t` key WAS guarded with `!t?.closest('.react-flow__node')` (lines 688-698), but `1`/`0` were left without that guard.

**Impact.** After clicking on or drawing in a whiteboard, typing 1 or 0 surprises the user with a full canvas re-fit / recenter, yanking them out of the board they were working in.

**Evidence.**

```ts
} else if (e.key === '1' && !typing) {
        void rf.fitView(cameraAnim(FIT_FRAME))
      } else if (e.key === '0' && !typing) {
        ...
        void rf.fitView(cameraAnim(RESET_FRAME))
```

**Recommendation.** Apply the same `!t?.closest('.react-flow__node')` focus guard used for the `t` key to the `1` and `0` branches (or fold all three bare-key globals behind one shared guard).

<details><summary>Adversarial verifier (confirmed)</summary>

The code confirms the finding exactly as described.

At Canvas.tsx lines 682-688, the `1` (fitView) and `0` (recenter) branches are guarded only by `!typing`:
```
} else if (e.key === '1' && !typing) {
    void rf.fitView(cameraAnim(FIT_FRAME))
} else if (e.key === '0' && !typing) {
    void rf.fitView(cameraAnim(RESET_FRAME))
```

The `typing` guard (checking INPUT/TEXTAREA/contentEditable) does NOT cover the Planning `pl-well` div, which is a plain `tabIndex={0}` focusable div at PlanningBoard.tsx line 1005 — not contentEditable, not an input.

The well's `onKeyDown` handler (lines 1014-1052) only calls `stopPropagation()` for:
1. Delete/Backspace when items are selected (line 1016)
2. Key …

</details>

---

#### 21. `project-switcher-no-outside-close`

**Project switcher dropdown has no outside-click/Escape close listener**

- **Where:** `src/renderer/src/canvas/AppChrome.tsx`:51-144 · **dimension:** renderer-react · **category:** silent-failure · **finder confidence:** high

**What it is.** ProjectSwitcher renders its dropdown when `open` but registers NO effect to close on an outside pointerdown, Escape, or window resize — unlike BoardMenu (BoardFrame.tsx 177-193) and TidyMenu (AppChrome.tsx 243-257) which all install document pointerdown + keydown + resize close handlers. ProjectSwitcher has no useEffect at all. The menu only closes when an action inside it runs (switchTo/openFolder/createNew set open=false) or the trigger is toggled again.

**Impact.** Clicking anywhere else on the canvas leaves the project dropdown stuck open, inconsistent with every other popover in the app and leaving stale recents on screen.

**Evidence.**

```ts
{open && (
        <div className="project-switcher-menu" role="menu">
          {recents.map((r) => (
            <button key={r.path} onClick={() => void openRecent(r.path)} ...
```

**Recommendation.** Add the same document-pointerdown + Escape + resize close effect used by BoardMenu/TidyMenu, scoped to the switcher's `open` state.

<details><summary>Adversarial verifier (confirmed)</summary>

The code at Z:\Canvas ADE\src\renderer\src\canvas\AppChrome.tsx confirms the finding exactly. ProjectSwitcher (lines 51–145) uses only useState (open, recents) — there is no useEffect anywhere in the component. The dropdown rendered at lines 131–142 only closes when one of the three action callbacks (openRecent/openFolder/createNew) explicitly calls setOpen(false), or when the trigger button is toggled again. There is no document pointerdown listener, no Escape keydown listener, and no window resize listener.

Contrast with TidyMenu in the same file (lines 243–257): a useEffect gated on `open` installs document.addEventListener('pointerdown', close), document.addEventListener('keydown', onKe …

</details>

---

#### 22. `camera-fullview-prior-viewport-overwrite`

**Entering camera full view on a second board overwrites the saved prior viewport**

- **Where:** `src/renderer/src/canvas/Canvas.tsx`:204-221 · **dimension:** renderer-react · **category:** race · **finder confidence:** medium

**What it is.** enterCameraFullView unconditionally writes `priorViewportRef.current = rf.getViewport()` on every entry. requestFullView (line 575-585) only exits when `cameraFullViewIdRef.current === id`; entering full view on a DIFFERENT planning board while already in camera full view on board A calls enterCameraFullView(B), which overwrites priorViewportRef with A's already-fitted viewport. exitCameraFullView then restores to A's fit position, not the user's original pre-full-view viewport.

**Impact.** Switching directly between two planning boards' camera full view loses the original camera position; exiting drops the user at a fitted-on-A viewport rather than where they actually were before entering full view. Edge case (requires planning→planning full-view chaining).

**Evidence.**

```ts
const enterCameraFullView = useCallback(
    (id: string) => {
      hardCloseFullView()
      priorViewportRef.current = rf.getViewport()
```

**Recommendation.** Only capture priorViewportRef when not already in camera full view: `if (!cameraFullViewIdRef.current) priorViewportRef.current = rf.getViewport()`.

<details><summary>Adversarial verifier (confirmed)</summary>

The code confirms the bug exactly as described. At line 207, `enterCameraFullView` unconditionally writes `priorViewportRef.current = rf.getViewport()` without checking whether a camera full view is already active. At lines 575-585, `requestFullView` only calls `exitCameraFullView()` when `cameraFullViewIdRef.current === id` (same-board toggle); when switching from board A's camera full view to board B, it skips the exit path and calls `enterCameraFullView(B)` directly. At that moment `rf.getViewport()` returns A's already-fitted viewport, so `priorViewportRef` is overwritten with A's fit position instead of the user's original pre-full-view viewport. `exitCameraFullView` at lines 215-221 th …

</details>

---

#### 23. `ctrl-suppress-ref-stuck-on-blur`

**snapSuppressRef can latch true if Ctrl/Cmd is held while the window loses focus**

- **Where:** `src/renderer/src/canvas/Canvas.tsx`:730-740 · **dimension:** renderer-react · **category:** race · **finder confidence:** medium

**What it is.** The keydown/keyup listeners set snapSuppressRef.current = e.ctrlKey || e.metaKey but there is no blur/visibilitychange reset. If the user holds Ctrl, alt-tabs (or the OS swallows the keyup), the keyup never arrives and snapSuppressRef stays true — snapping/alignment stays suppressed until the next keydown re-evaluates the modifier. Self-heals on the next keypress, so blast radius is small.

**Impact.** Alignment snapping can be transiently stuck off after an alt-tab while a modifier was held, until the next key event; mildly confusing during a drag.

**Evidence.**

```ts
const update = (e: KeyboardEvent): void => {
      snapSuppressRef.current = e.ctrlKey || e.metaKey
    }
    window.addEventListener('keydown', update)
    window.addEventListener('keyup', update)
```

**Recommendation.** Also reset snapSuppressRef.current = false on a window `blur` listener (and clear it on visibilitychange).

<details><summary>Adversarial verifier (confirmed)</summary>

The code at lines 730–740 of src/renderer/src/canvas/Canvas.tsx is exactly as quoted. The `useEffect` attaches only `keydown` and `keyup` listeners on `window` to set `snapSuppressRef.current = e.ctrlKey || e.metaKey`. There is no `blur`, `visibilitychange`, or `focusout` listener to reset the ref when the window loses focus. A grep for `snapSuppressRef` across the file confirms it is defined at line 157 (`useRef(false)`) and only written in this one `update` callback — no other reset path exists. If the user holds Ctrl/Cmd and alt-tabs (or the OS consumes the keyup), the ref latches `true` and alignment snapping/guide computation at lines 277 and 306 is skipped for all subsequent drags unti …

</details>

---

#### 24. `image-write-failure-silent-drop` _(verifier adjusted Medium → Low)_

**Image paste/drop silently no-ops when asset:write fails — no user signal**

- **Where:** `src/renderer/src/canvas/boards/PlanningBoard.tsx`:238-240 · **dimension:** silent-failures · **category:** silent-failure · **finder confidence:** high

**What it is.** addImageFromBlob awaits window.api.asset.write(bytes, ext); on failure MAIN returns { error: string } (projectIpc.ts:160-166 — e.g. disk full, no project open, permission denied, unsupported ext). The renderer does `if ('error' in res) return` and abandons the operation with no toast, log, or fallback. The user pastes/drops an image and nothing appears, with zero indication why. There is no project-open guard surfaced either: if no project is open getCurrentDir() is null → { error:'no project open' } → the image just vanishes.

**Impact.** A pasted/dropped screenshot is silently lost on any write error. The user cannot tell whether the paste failed, the image was rejected, or the app is broken — the classic silent-failure UX. On a failing disk this compounds with the autosave silent loss path.

**Evidence.**

```ts
`const res = await window.api.asset.write(bytes, ext)\n      if ('error' in res) return` (PlanningBoard.tsx:239-240). Compare runExport in the same file which at least console.errors on failure (PlanningBoard.tsx:330-333).
```

**Recommendation.** Surface the failure: at minimum console.error(res.error), and ideally a transient in-board note (the component already has a previewNote-style pattern in TerminalBoard). Distinguish 'no project open' from a true write error so the message is actionable.

<details><summary>Adversarial verifier (confirmed)</summary>

The code at PlanningBoard.tsx:239-240 is exactly as cited. `addImageFromBlob` does `const res = await window.api.asset.write(bytes, ext)` then `if ('error' in res) return` — no console.error, no toast, no fallback. The MAIN handler (projectIpc.ts:156-165) returns `{ error: string }` for three distinct failure modes: security guard ('forbidden'), no project open ('no project open'), and any fs exception (stringified message). All three cause the same silent return in the renderer.

The comparison to `runExport` at lines 323-333 is apt: that code wraps in try/catch and at minimum logs `console.error('whiteboard export failed', err)`. The paste/drop image path has no equivalent.

The finding is …

</details>

---

#### 25. `export-save-result-ignored`

**Whiteboard export save-dialog result is ignored — a write failure looks identical to success/cancel**

- **Where:** `src/renderer/src/canvas/boards/PlanningBoard.tsx`:323-336 · **dimension:** silent-failures · **category:** silent-failure · **finder confidence:** high

**What it is.** runExport awaits window.api.export.save(...), whose result is the discriminated union { ok:true; path } | { ok:false; canceled?; error? } (projectIpc.ts:175-198, preload index.ts:161-168). The renderer ignores the return value entirely — it only catches a thrown rejection (which export:save does NOT throw; it returns { ok:false, error } on a writeFileAtomic failure). So a real save failure (disk full, permission denied at the chosen path) resolves with ok:false and is indistinguishable from a user cancel: the user clicks Export, picks a path, the write fails, and nothing happens with no message.

**Impact.** A failed PNG/SVG export to disk silently does nothing. The user believes nothing was wrong (or that they cancelled). Limited blast radius (export is a discrete user action, not data-loss of the canvas), hence Low — but it is a real swallowed error path the existing memory note (whiteboard-w5-export 'silent export-failure feedback') already flags as open.

**Evidence.**

```ts
`const { bytes, ext } = await buildExport(board, format)\n        await window.api.export.save({ bytes, ext, defaultName: ... })\n      } catch (err) { console.error('whiteboard export failed', err) }` — only the throw path is handled; the returned `{ ok:false, error }` is never inspected.
```

**Recommendation.** Inspect the result: on `!res.ok && !res.canceled` surface res.error (toast/console). The IPC already returns the error string; the renderer just discards it.

<details><summary>Adversarial verifier (confirmed)</summary>

The code at PlanningBoard.tsx:329 does `await window.api.export.save(...)` without assigning the return value. The IPC handler in projectIpc.ts:191-196 wraps the `writeFileAtomic` call in a try/catch and returns `{ ok: false, error: String(err.message) }` on failure — it does NOT throw. The preload at index.ts:161-168 passes this discriminated union straight to the renderer via `ipcRenderer.invoke`. Since the renderer discards the result and the `catch` block on line 330 only fires on thrown rejections (which never happen), a real write failure (disk full, permission denied) after the user confirms the save dialog resolves silently with no user-visible feedback. The severity is correctly Low …

</details>

---

#### 26. `recents-listrecents-empty-on-parse-fail`

**listRecents returns [] on any JSON parse error — a corrupt recent-projects.json silently wipes the recents UI**

- **Where:** `src/main/recentProjects.ts`:26-40 · **dimension:** silent-failures · **category:** silent-failure · **finder confidence:** medium

**What it is.** listRecents JSON.parses recent-projects.json and on any throw returns [] (catch {} at line 37-39). A corrupt/partially-written recents file therefore silently presents an EMPTY recent-projects list with no log or signal. Worse, the next touchRecent then writes a fresh single-entry file (touchRecent calls listRecents → [] → overwrites), permanently discarding the prior recents rather than preserving them. (The file is atomically written so torn writes are unlikely, but external corruption or a schema change still hits this.)

**Impact.** User's recent-projects history can silently vanish and then be overwritten on the next open, with no diagnostic. Low blast radius (recents are a convenience, the project files themselves are untouched), but it is a swallowed-error→silent-data-loss pattern with no logging.

**Evidence.**

```ts
`} catch {\n    return []\n  }` (recentProjects.ts:37-39). No console.error; the same swallow then feeds touchRecent's overwrite.
```

**Recommendation.** console.error the parse failure before returning []. Consider not overwriting on a parse failure (or rotating the bad file to .bak) so a transient read error doesn't destroy the list.

<details><summary>Adversarial verifier (confirmed)</summary>

The code at `src/main/recentProjects.ts` lines 37-39 is exactly as described: a bare `catch { return [] }` with no logging. Confirmed by direct reading.

The overwrite path is also real: `touchRecent` (line 45) calls `listRecents(userDataDir)` to build the new list, gets `[]` on a parse failure, then writes a fresh single-entry file via `writeFileAtomic.sync` (line 50), permanently replacing the corrupt file with only the new entry. The prior recents are silently discarded.

There is no logging wrapper in `projectIpc.ts` either — `listRecents` is called directly at lines 135 and 140 with no surrounding try/catch or log.

Notably, the codebase already acknowledges the `listRecents`-returns-`[ …

</details>

---

#### 27. `project-current-readproject-swallow`

**project:current swallows a readProject failure of the most-recent project and silently returns null → boots to welcome with no reason**

- **Where:** `src/main/projectIpc.ts`:138-149 · **dimension:** silent-failures · **category:** silent-failure · **finder confidence:** medium

**What it is.** project:current reads the most-recent project; if readProject fails (no readable canvas.json or .bak) it returns { ok:false }, and the handler maps that to `null` (line 148) — which App.tsx treats as 'stay on welcome screen' (App.tsx:31 comment). So a recent project that became unreadable (deleted/renamed/corrupted-beyond-envelope) causes a silent boot-to-welcome with no message that the auto-reopen failed and no log. The user just sees the welcome screen and may think they lost their project.

**Impact.** Auto-reopen failure is indistinguishable from 'no project ever opened'. The user gets no signal that their most-recent project couldn't be read. Low severity (the project picker still works and the error path elsewhere does surface r.error when opened explicitly), but the auto path drops the cause entirely.

**Evidence.**

```ts
`const r = readProject(recents[0].path)\n    ...\n    return r.ok ? r : null` (projectIpc.ts:142-148). The false branch's `r.error` is discarded; App.tsx: 'null → stay on the welcome screen'.
```

**Recommendation.** Either return the { ok:false, error } so the welcome screen can show 'Could not reopen <name>: <error>', or at least console.warn in MAIN so the failure is diagnosable.

<details><summary>Adversarial verifier (confirmed)</summary>

The code exactly matches the description. In projectIpc.ts line 148, `project:current` returns `null` when `readProject` fails, silently discarding `r.error`. In App.tsx line 30, `applyOpenResult(r)` is called only when `r && r.ok` — so `null` silently falls through to the `// null → stay on the welcome screen` comment. There is no `console.warn` or `console.error` in the `project:current` handler or in `readProject` for failure cases (confirmed by grep: only `project:save` logs at line 128). The `applyOpenResult` action in canvasStore.ts lines 513-516 does correctly handle `ok:false` by setting `status: 'error'` and `error: r.error`, and WelcomeScreen.tsx line 44 does render a `welcome-erro …

</details>

---

#### 28. `local-baseurl-ssrf-no-validation` _(verifier adjusted Medium → Low)_

**local-provider baseUrl is an unvalidated SSRF/egress primitive (any URL POSTed from MAIN with board content)**

- **Where:** `src/main/llmService.ts`:70-85, 171-189 · **dimension:** type-contracts · **category:** security · **finder confidence:** high

**What it is.** The `local` provider's baseUrl crosses the IPC trust boundary via llm:setConfig (llmIpc.ts:118-137, typed `baseUrl?: string`), is persisted by writeLlmConfig and re-read by readLlmConfig (llmConfig.ts:57 — validated ONLY as `typeof p.baseUrl === 'string'`, no scheme/host check), then reaches buildRequest which does `url = base + '/chat/completions'` and getProvider's summarize does `deps.fetch(req.url, { method:'POST', body: <board content> })`. Nothing validates the scheme (http/https), host, or that it is loopback/local. ADR 0003 states 'LLM egress is the only outbound network path' — but this gives the renderer a way to make MAIN POST arbitrary board content (terminal launchCommand/cwd, browser URLs, note + checklist text via summaryLoop.boardContent) to ANY URL the renderer chooses, including http://169.254.169.254/ (cloud metadata), internal RFC1918 hosts, or an attacker-controlled collector.

**Impact.** If the renderer is ever compromised (the exact threat the contextIsolation+sandbox+browser-board separation defends against — Browser boards render untrusted localhost/web content), this is a ready-made SSRF + data-exfiltration channel out of the privileged MAIN process: scan/hit internal services and exfiltrate whiteboard/terminal content under the guise of an LLM call, bypassing the 'egress is the only outbound path' intent by pointing that path anywhere. Even absent full compromise it weakens the egress invariant to 'MAIN will POST to any string the renderer supplies'.

**Evidence.**

```ts
llmService.ts: `if (!config.baseUrl) throw...; base = config.baseUrl` then `return { url: `${base}/chat/completions`, ... }` and `const res = await deps.fetch(req.url, { method:'POST', headers: req.headers, body: req.body, ... })`. llmConfig.ts:57: `const baseUrl = typeof p.baseUrl === 'string' ? p.baseUrl : undefined` (no URL/scheme/host validation). SettingsModal.tsx:64 forwards the raw string.
```

**Recommendation.** Validate baseUrl in MAIN before persisting/using it: require new URL(baseUrl) to parse, restrict protocol to http/https, and (given the provider is named `local`) restrict the host to loopback / RFC1918 or an explicit user-confirmed allowlist; reject metadata IPs (169.254.169.254, 100.100.200.200, etc.). Do the check in readLlmConfig/buildRequest so a hand-edited llm-config.json is also covered, and document the constraint in ADR 0003.

<details><summary>Adversarial verifier (adjusted)</summary>

The code confirms the finding is real. In `llmConfig.ts` the read path is `const baseUrl = typeof p.baseUrl === 'string' ? p.baseUrl : undefined` (no scheme/host check). In `llmService.ts` `buildRequest` does `base = config.baseUrl` then `url: \`${base}/chat/completions\`` and the `Provider.summarize` POSTs board content to that URL via `deps.fetch`. In `llmIpc.ts` the `llm:setConfig` handler accepts `baseUrl?: string` from the renderer with only the frame-guard (same-window sender check), no URL validation before calling `writeLlmConfig`.

However, ADR 0003 (`docs/decisions/0003-llm-egress.md`) — the authoritative egress contract — explicitly acknowledges this in its "Accepted residual risk …

</details>

---

#### 29. `preview-source-self-reference`

**Browser board previewSourceId may reference itself or a wrong-type board (validation accepts any string)**

- **Where:** `src/renderer/src/lib/boardSchema.ts`:404-406, 437-442 · **dimension:** type-contracts · **category:** type · **finder confidence:** high

**What it is.** previewSourceId is validated only as `typeof b.previewSourceId === 'string'` and, in fromObject, is dropped only when the referenced id is ABSENT from the board set. It is never checked to (a) differ from the board's own id (a browser board could point at itself, b.previewSourceId === b.id) or (b) reference a board of type 'terminal' (the documented contract: 'the Terminal board id that pushed this preview'). A self-reference or a reference to another browser/planning board passes validation.

**Impact.** A self- or wrong-type preview link renders a degenerate/half edge or a link arrow to a non-terminal board, contradicting the Slice C′ contract. Limited blast radius (cosmetic/edge rendering, not a crash or security issue) since the dangling-id case is already pruned.

**Evidence.**

```ts
assertBoard browser case: `if (b.previewSourceId !== undefined && typeof b.previewSourceId !== 'string') fail(...)`. fromObject prune: `if (b.type === 'browser' && b.previewSourceId && !ids.has(b.previewSourceId)) delete b.previewSourceId` — only checks presence, not self-reference or source type.
```

**Recommendation.** In the fromObject prune loop, also delete previewSourceId when it equals the board's own id, or when the referenced board is not type 'terminal'. Cheap and keeps the persisted link honest to its documented invariant.

<details><summary>Adversarial verifier (confirmed)</summary>

The finding is genuine. The code at `boardSchema.ts` lines 404-406 only checks `typeof b.previewSourceId !== 'string'`, and the prune loop at lines 437-442 only deletes when `!ids.has(b.previewSourceId)` — neither check guards against self-reference (`b.previewSourceId === b.id`) nor against the referenced board being a non-terminal type.

Concrete impact paths confirmed by reading downstream consumers:

1. **Self-reference in `previewEdges.ts` line 25-33**: `if (src && ids.has(src))` — a self-reference passes this guard since the board's own id is in `ids`. The emitted edge has `source === target === b.id`, producing a React Flow self-loop arrow on the browser board. Not a crash, cosmetical …

</details>

---

#### 30. `provider-union-hand-sync-drift`

**ProviderName union is hand-duplicated across 3 files (preload, llmConfig, llmModels) — silent drift risk**

- **Where:** `src/preload/index.ts`:72-79 · **dimension:** type-contracts · **category:** type · **finder confidence:** high

**What it is.** The provider enum is stringly-redeclared independently in three places with explicit 'keep in sync' comments: preload LlmStatus.provider = 'openrouter'|'openai'|'anthropic'|'local' (index.ts:75), main ProviderName (llmConfig.ts:11), and renderer DEFAULT_MODELS (llmModels.ts:3-8). The preload union and the renderer model map are NOT derived from the main source of truth (the comment says 'Kept in sync by hand'). Adding/renaming a provider requires three coordinated manual edits; a miss compiles cleanly but desynchronizes the Settings UI, status display, and the model defaults. This allows an illegal state: the preload type could accept a provider the main DEFAULT_MODELS map lacks (DEFAULT_MODELS[provider] would be undefined).

**Impact.** Future provider additions can silently drift — e.g. a provider exposed in the preload/Settings type that has no DEFAULT_MODELS entry yields an undefined default model crossing IPC into llm:setConfig, which readLlmConfig then repairs to the openrouter default, masking the bug. No current exploit (all three lists match today), but it is a latent correctness trap with no compile-time linkage.

**Evidence.**

```ts
preload index.ts:73-75 `/** Mirrors main ProviderName — keep in sync if a provider is added. */ provider: 'openrouter' | 'openai' | 'anthropic' | 'local'`; llmModels.ts:1-2 `Renderer-side mirror of main's DEFAULT_MODELS ... Kept in sync by hand`.
```

**Recommendation.** Make the renderer/preload provider list derive from a single shared const (a tiny shared types module importable by both sides, or generate the preload union from DEFAULT_MODELS keys). At minimum add a type-level assertion test that the three lists are identical so CI catches drift.

<details><summary>Adversarial verifier (confirmed)</summary>

All three independently-declared provider lists exist verbatim on main as described. `src/preload/index.ts:75` declares `provider: 'openrouter' | 'openai' | 'anthropic' | 'local'` with the comment "Mirrors main ProviderName — keep in sync if a provider is added." `src/main/llmConfig.ts:11` declares `export type ProviderName = 'openrouter' | 'openai' | 'anthropic' | 'local'`, and `src/renderer/src/lib/llmModels.ts:3-8` contains a plain `as const` object with the same four keys and a "Kept in sync by hand" comment. There is zero compile-time linkage between them: the renderer `DEFAULT_MODELS` is not typed as `Record<ProviderName, string>`, and the preload union is not derived from either. The …

</details>

---

#### 31. `ipc-payloads-no-runtime-shape-guard`

**MAIN IPC handlers trust renderer payload SHAPE with TS types only (no runtime validation on llm:setKey/setConfig/summarize)**

- **Where:** `src/main/llmIpc.ts`:81-137 · **dimension:** type-contracts · **category:** type · **finder confidence:** medium

**What it is.** Several MAIN handlers destructure the renderer payload using a TS annotation that is NOT a runtime guarantee across the IPC boundary: llm:setKey reads a.provider/a.key, llm:setConfig reads a.provider/a.model/a.baseUrl/a.maxCallsPerDay, llm:summarize reads input (SummarizeInput) — none re-validate that the object is non-null or that fields are the declared type before use. A malformed/hostile payload (e.g. a.provider as an arbitrary string, a.key as a number, input.text undefined) reaches keyStore.setKey / writeLlmConfig / runSummarize. Downstream there are partial saves: writeLlmConfig persists whatever provider string it is handed (readLlmConfig later repairs an unknown provider, but writeLlmConfig itself does not), and keyStore.setKey would index llm-keys.json by an arbitrary provider string. This is the standard 'TS types are not runtime guarantees at the trust boundary' gap; the project elsewhere (projectStore.writeAsset/readAsset, isUnsafeProjectDir, safeBoardId) DOES re-validate, so these handlers are the inconsistent ones.

**Impact.** Low in practice: the sender is frame-guarded (only the main frame can call), readLlmConfig repairs an unknown provider on read, and a bad summarize input just yields a useless summary or a typed provider-error. But a hostile/garbled payload can write a junk provider key/entry into userData/llm-keys.json or llm-config.json (e.g. provider='__proto__' indexing, or a numeric key that later throws in encryptString), and llm:summarize will JSON.stringify whatever input.text is. No current path produces this (the renderer is the only sender and sends well-formed objects), so this is a defense-in-depth hardening note, not an active bug.

**Evidence.**

```ts
llmIpc.ts:105 `ipcMain.handle('llm:setKey', (e, a: { provider: ProviderName; key: string }) => { ... return keyStore.setKey(a.provider, a.key) ... })` — a is used directly with no isRecord(a) / typeof a.key==='string' / provider-membership check. Same pattern at setConfig (118-137) and summarize (81-85).
```

**Recommendation.** Add cheap runtime guards mirroring the rest of the codebase: validate a is a record, a.provider is in the PROVIDERS set, a.key/a.model are non-empty strings, and (summarize) input.text is a string — returning the typed { ok:false } shapes on mismatch. This makes the IPC contract enforced at runtime, not just by the (renderer-side) TS type.

<details><summary>Adversarial verifier (confirmed)</summary>

The file `src/main/llmIpc.ts` exists on the `main` branch (introduced in commit `4c321c2`). Re-reading the actual code confirms the finding's core claim without modification.

**What the code actually does:**

- `llm:setKey` (line ~105): `keyStore.setKey(a.provider, a.key)` is called with no runtime check that `a.provider` is in the PROVIDERS set or that `a.key` is a non-empty string. In `llmKeyStore.ts`, `setKey` does `data[provider] = encryptor.encryptString(key).toString('base64')` then writes the whole object to `llm-keys.json`. An arbitrary string provider (e.g. `'__proto__'`, or a 10,000-char string) reaches the JSON file as a key.

- `llm:setConfig` (line ~118): `writeLlmConfig` is ca …

</details>

---

#### 32. `preload-msgport-repost-untested` _(verifier adjusted High → Low)_

**Preload pty:port MessagePort re-post + SEC-2 origin pinning has zero test coverage**

- **Where:** `src/preload/index.ts`:171-188 · **dimension:** tests-coverage · **category:** test-gap · **finder confidence:** high

**What it is.** The single most security-load-bearing line in the preload — re-posting the transferred PTY MessagePort into the main world via window.postMessage with a pinned target origin (window.location.origin, SEC-2) instead of '*' — is completely untested. The preload integration test (src/preload/preloadApi.integration.test.ts) mocks ipcRenderer.on as a no-op (lines 19-24) and explicitly states it only covers the invoke→channel contract, excluding the listener methods (line 126-133). So there is no assertion that (a) the pty:port handler re-posts with the correct origin (not '*'), (b) it forwards e.ports in the transfer list, or (c) the {__ptyPort, id} envelope shape the renderer keys on is correct. A regression that changed the target origin back to '*' (the classic postMessage XSS footgun) or dropped the transfer list would ship silently — neither unit/integration nor e2e exercises this path (the terminal e2e reads the framebuffer, which works regardless of the origin argument).

**Impact.** A silent regression to a wildcard target origin or a broken transfer list would not be caught by any tier. Wildcard origin is the canonical postMessage data-leak/injection vector if an iframe is ever added (the SEC-2 comment exists precisely to prevent this); a broken transfer list would break the data plane with no test signal.

**Evidence.**

```ts
window.postMessage({ __ptyPort: true, id: msg.id }, window.location.origin, e.ports)  // and the test: '  - ipcRenderer.on / removeListener are no-ops (preload registers a pty:port listener at import; it must not throw)'
```

**Recommendation.** Add an integration test that drives the captured pty:port ipcRenderer.on handler with a fake event carrying ports, and asserts window.postMessage is called with the __ptyPort envelope, window.location.origin (NOT '*'), and the exact ports array. Also assert onFlush replies on the reply channel and forwards no IpcRendererEvent to the renderer listener.

<details><summary>Adversarial verifier (adjusted)</summary>

The test gap is real and accurately described. In src/preload/index.ts lines 177-181, the pty:port ipcRenderer.on callback calls window.postMessage({ __ptyPort: true, id: msg.id }, window.location.origin, e.ports) — the origin-pinning and transfer-list are genuinely untested. The integration test at src/preload/preloadApi.integration.test.ts mocks ipcRenderer.on as vi.fn() (line 21), meaning the callback is registered but the mock discards it without ever invoking it. No assertion covers window.postMessage being called, the target origin, the transfer list, or the envelope shape. The e2e terminal tests (e2e/terminal.e2e.ts) read the framebuffer via readTerminal() which proves the path works …

</details>

---

#### 33. `enumerate-shells-untested` _(verifier adjusted Medium → Low)_

**enumerateShells (shell discovery feeding the spawn allowlist) has no direct test**

- **Where:** `src/main/pty.ts`:237-352 · **dimension:** tests-coverage · **category:** test-gap · **finder confidence:** high

**What it is.** resolveShell (the M5 allowlist gate) and canonicalizeShellPath are unit-tested, but the function that PRODUCES the allowlist — enumerateShells — and its filesystem-probing helpers (onPath PATH-walking with the win32 ext list, firstFile, findGitBash root-derivation, findWsl System32-preference) are completely untested. Critically, the WindowsApps-alias skip filter (lines 338-341: `if (stdBash && !/WindowsApps/i.test(stdBash))`) and the dual-key dedupe (canonical-path key + label key, lines 319-326) have no coverage. None of these takes an injectable fs/PATH, so they're written in a way that resists unit testing despite being the source of truth for which binaries main will spawn.

**Impact.** resolveShell only spawns a shell if it matches enumerateShells output, so a bug here (e.g. the WindowsApps filter inverting, a dedupe key collision dropping the real default, onPath returning a non-executable) silently weakens or breaks the M5 spawn allowlist — either failing to discover the user's shell (degraded UX) or admitting an unintended binary. A regression ships with green tests because nothing exercises this path.

**Evidence.**

```ts
const stdBash = onPath('bash'); if (stdBash && !/WindowsApps/i.test(stdBash)) add(stdBash, 'bash')  — and the suite imports canonicalizeShellPath/resolveShell but never enumerateShells (pty.test.ts line 4-18).
```

**Recommendation.** Refactor enumerateShells to accept injectable probes (an onPath/firstFile/realpath seam, as canonicalizeShellPath already does), then unit-test: the OS-default ordering, the WindowsApps-alias skip, the canonical+label dedupe collapsing duplicate cmd entries, and the empty-PATH fallback to defaultShell().

<details><summary>Adversarial verifier (confirmed)</summary>

The code and tests confirm the finding exactly. `enumerateShells` is exported from `src/main/pty.ts` (line 310) but is never imported or called in any test file. `src/main/pty.test.ts` imports `canonicalizeShellPath`, `resolveShell`, and others (lines 4–17) but not `enumerateShells`. The integration test `src/main/pty.integration.test.ts` only exercises the IPC foreign-sender guard on the `pty:shells` handler, confirming the rejection path but not the discovery logic itself.

The untested surface is real: `onPath` (lines 237–251) walks `process.env.PATH` with fs probes, `firstFile` (lines 253–264), `findGitBash` (lines 287–296), `findWsl` (lines 298–302), and critically the WindowsApps filte …

</details>

---

#### 34. `preview-happy-path-wiring-untested` _(verifier adjusted Medium → Low)_

**Preview happy-path view wiring (per-board partition, setWindowOpenHandler, nav-guard registration) is asserted nowhere but a flaky e2e**

- **Where:** `src/main/preview.ts`:227-336 · **dimension:** tests-coverage · **category:** test-gap · **finder confidence:** high

**What it is.** preview.integration.test.ts only asserts foreign-sender rejection — it never mocks electron's WebContentsView, so ensure()/attach() are never executed in a test. The individual pure pieces (registerPreviewNavGuards, isAllowedExternal, registerLoadLatch) are unit-tested in isolation, but there is no test that ensure() actually WIRES them: that each view gets partition `preview-<id>` (the ADR-0002 zoom-isolation invariant), that setWindowOpenHandler routes through openExternalSafe and returns {action:'deny'}, that registerPreviewNavGuards is attached, and that the before-input-event Escape forwarding fires. grep confirms setWindowOpenHandler/partition/ensure( appear only in preview.test.ts as the isolated unit pieces, never as wired-up assertions. The only coverage of the assembled view is the browser/browser-gesture e2e trio, which the memory file documents as a known capturePage env flake (rerun-for-clean).

**Impact.** A regression that dropped the per-board partition (re-introducing the shared-session zoom-sync bug ADR-0002 fixes), changed the window-open action from deny, or forgot to register the nav guards on a new view would pass the integration suite (foreign-sender still rejects) and could be masked by the flaky e2e trio. The defense-in-depth preview-isolation wiring is effectively unverified.

**Evidence.**

```ts
In preview.integration.test.ts the only setup is `registerPreviewHandlers(cap.ipcMain, mainWin, 'http://127.0.0.1:0/')` with no electron mock — every test asserts the foreign-sender branch; no view is ever created. ensure() / setWindowOpenHandler / partition are exercised by no test.
```

**Recommendation.** Add an integration test that vi.mock('electron') with a fake WebContentsView capturing the webPreferences (assert partition === `preview-<id>`, sandbox/contextIsolation/nodeIntegration), a fake webContents recording setWindowOpenHandler + on() registrations, then invoke preview:open as the trusted sender and assert the guards/handlers were wired and the window-open handler denies + routes through the external allowlist.

<details><summary>Adversarial verifier (confirmed)</summary>

The finding is accurate as a test-gap observation. Reading the actual code confirms the split:

1. `preview.test.ts` unit-tests pure exported functions (`isErrorResponseCode`, `isHttpErrorCode`, `isAllowedPreviewUrl`, `isAllowedExternal`, `registerPreviewNavGuards`, `registerLoadLatch`, `isForeignSender`) using fake `webContents` objects — never touching `WebContentsView` or `ensure()`.

2. `preview.integration.test.ts` (lines 1-58) calls `registerPreviewHandlers(cap.ipcMain, mainWin, 'http://127.0.0.1:0/')` and asserts only the foreign-sender rejection path. Because `preview:open` throws immediately for a foreign sender (line 17 — `expect(() => cap.invokeAs(foreignEvent, 'preview:open', ... …

</details>

---

#### 35. `pty-spawn-options-untested`

**pty:spawn happy-path options (full-env passthrough, defaults, Git Bash -l -i) only covered by e2e, not unit/integration**

- **Where:** `src/main/pty.ts`:415-528 · **dimension:** tests-coverage · **category:** test-gap · **finder confidence:** medium

**What it is.** The pty:spawn handler's construction of the spawn options is verified only by the terminal e2e (spawn→echo). At the unit/integration tier only the foreign-sender rejection branch is asserted (pty.integration.test.ts). Untested logic in the body: env: { ...process.env } passing the ENTIRE parent environment (incl. any secrets in main's env) to the spawned shell; the cols/rows ?? 80/24 defaults; the Git Bash `args = ['-l','-i']` branch; the Bug #13 'reap any existing session occupying this id before overwrite' guard (line 428, prevents an orphaned tree on a restart race); and the onData/onExit identity guards (`live.proc === proc`) that stop late bytes/exits bleeding into a respawned session. The identity-guard CORES are unit-tested via cleanupCore/isStaleExit, but the inline onData/onExit closures and the pre-spawn cleanup-on-collision are not directly asserted.

**Impact.** A regression dropping the line-428 collision reap re-introduces the orphaned-child-tree-on-restart bug (#13) — the exact class the comment warns about — and would pass the unit suite (which only tests the extracted cores, not the inline spawn-handler wiring) and likely the e2e (which doesn't race two spawns under one id). Lower severity because the extracted cores carry most of the identity-guard logic and the e2e covers the basic spawn.

**Evidence.**

```ts
if (sessions.has(opts.id)) void cleanup(opts.id)  // Bug #13 ... then later: proc.onData((d) => { ... const live = sessions.get(opts.id); if (live && live.proc === proc) { ... } })  — no test invokes the spawn handler with a colliding id to assert the prior proc is reaped.
```

**Recommendation.** Extract the spawn-options builder (shell/args/cols/rows/cwd/env) into a pure function and unit-test it (incl. the Git Bash -l -i branch and that env is the parent env). Add an integration test (electron + node-pty mocked) that calls pty:spawn twice under one id and asserts the first proc's killTree ran before the second registered (the #13 collision reap).

<details><summary>Adversarial verifier (confirmed)</summary>

The code at src/main/pty.ts lines 415–528 confirms the finding exactly. The pty:spawn handler contains inline logic that is not unit/integration tested:

1. Line 428: `if (sessions.has(opts.id)) void cleanup(opts.id)` — the collision reap guard. No test in pty.test.ts or pty.integration.test.ts calls pty:spawn with a colliding id to assert the prior session is reaped before overwrite.

2. Lines 435–438: The Git Bash `-l -i` args branch (`if (process.platform === 'win32' && args.length === 0 && /\\bash\.exe$/i.test(shell))`). No unit test exercises this branch.

3. Line 446: `env: { ...process.env }` — entire parent env passthrough. No unit test asserts this behavior.

4. Lines 441–444: `cols …

</details>

---

#### 36. `foreign-sender-guard-triplicated`

**isForeignSender is independently re-implemented + re-tested in three modules — a drift in one is a silent guard hole**

- **Where:** `src/main/pty.ts`:387-399 · **dimension:** tests-coverage · **category:** test-gap · **finder confidence:** medium

**What it is.** The frame-guard isForeignSender is copy-pasted across pty.ts (387-399), preview.ts (411-419), and projectIpc.ts (34-42), and each has its own near-identical unit test (pty.test.ts, preview.test.ts, projectIpc.test.ts). The tests prove each copy is correct in isolation today, but there is no shared implementation or shared test, so a security fix applied to one (e.g. tightening the null-window DENY branch, or handling a new senderFrame edge like a detached/destroyed frame) can silently miss the other two. The test suite would stay green while one guard diverged. This is a structural test-gap: the invariant is 'all three behave identically,' and nothing asserts that.

**Impact.** A future hardening of the guard that lands in only one or two of the three modules leaves a frame-guard hole on the un-updated channel(s) with a fully green suite — the foreign-sender rejection contract (checklist #17/#20, Browser↛PTY) silently weakens on one IPC surface.

**Evidence.**

```ts
Three separate exported functions: pty.ts `export function isForeignSender(e, getMainFrame)`, preview.ts `export function isForeignSender(e, getWin)`, projectIpc.ts `export function isForeignSender(e, getMainFrame)` — same logic, three signatures, three test suites, no shared source.
```

**Recommendation.** Hoist isForeignSender into one shared module (e.g. src/main/ipcGuard.ts) with one unit suite, and have pty/preview/projectIpc import it. If keeping them separate is intentional, add a single parametrized test that imports all three and asserts identical behavior across the shared truth table.

<details><summary>Adversarial verifier (confirmed)</summary>

The finding is accurate in every detail. Three separate exports named `isForeignSender` exist in `src/main/pty.ts` (lines 387–399), `src/main/preview.ts` (lines 411–419), and `src/main/projectIpc.ts` (lines 34–42). No shared module (e.g. `src/main/ipcGuard.ts`) exists — the Glob confirms it. Each has its own independent unit-test suite with the same four truth-table cases (synthetic/no-senderFrame → false; foreign frame → true; trusted main frame → false; real sender + unresolved window → true).

The logic is currently identical across all three, so there is no active bug. However, the signatures differ in a meaningful structural way: `pty.ts` accepts `() => unknown | null`; `projectIpc.ts` …

</details>

---

#### 37. `port-message-handler-throw-untested-spawn`

**The spawn handler's port message-handler throw-swallow (uncaughtException → app.exit guard) is untested in the live path**

- **Where:** `src/main/pty.ts`:503-515 · **dimension:** tests-coverage · **category:** test-gap · **finder confidence:** medium

**What it is.** adoptCore's port message handler swallow-on-throw IS unit-tested (pty.test.ts line 327-330: 'A throw inside write must not escape'). But the IDENTICAL guard in the live spawn handler (port1.on('message', ...) at lines 503-515) is a separate inline closure with no test — the comment explicitly warns that an unswallowed throw here escapes the EventEmitter as an uncaughtException → app.exit(1), crashing the whole app. Because it's inline in registerPtyHandlers (not extracted like adoptCore), the integration test can't reach it without a real port + a throwing proc, and it doesn't.

**Impact.** A regression removing the try/catch around proc.write/proc.resize in the spawn handler's port listener would crash the entire app (every board, every PTY, every preview) on a resize/write to an exited-but-unreaped pty — a real, reproducible condition during teardown — and no test would catch it (the adoptCore twin test passing gives false confidence).

**Evidence.**

```ts
port1.on('message', (e) => { ... try { if (m.t === 'input' ...) proc.write(m.d); else if (m.t === 'resize' ...) proc.resize(...) } catch { /* pty already exited */ } })  — comment: 'The throw would escape this EventEmitter listener as an uncaughtException → app.exit(1), crashing the whole app'
```

**Recommendation.** Extract the port message handler into a shared pure helper (it is byte-identical to adoptCore's) and unit-test the swallow once, then use it in both the spawn handler and adoptCore — removing the duplicated-and-only-half-tested closure.

<details><summary>Adversarial verifier (confirmed)</summary>

The code at Z:\Canvas ADE\src\main\pty.ts confirms two separate, structurally identical inline port message handler closures:

1. `adoptCore` (lines 159-169): `port1.on('message', ...)` with try/catch swallowing write/resize throws. This is an exported pure function and is directly unit-tested at pty.test.ts lines 306-330 — the test calls `adoptCore(...)`, then fires `port1.handler?.({ data: { t: 'input', d: 'x' } })` after making `proc.write` throw, and asserts no throw escapes.

2. The spawn handler (lines 503-515): An inline `port1.on('message', ...)` inside the `ipcMain.handle('pty:spawn', ...)` closure, with an identical try/catch. The comment on lines 505-508 explicitly warns "The thro …

</details>

---

#### 38. `node-pty-pinned-beta` _(verifier adjusted Medium → Low)_

**node-pty pinned to a prerelease beta (1.2.0-beta.13) — supply-chain and maintenance risk**

- **Where:** `package.json`:49 · **dimension:** deps-build · **category:** dep · **finder confidence:** high

**What it is.** node-pty is pinned to the exact prerelease `1.2.0-beta.13`. The pin is intentional and documented in CLAUDE.md (winpty-free / ConPTY-only is REQUIRED because the repo path `Z:\Canvas ADE` contains a space and node-pty <=1.1 bundles winpty whose build hard-fails on spaced paths). The trade-off is real: a beta is not a stability/security-supported release line, it can be unpublished/yanked or superseded by a final 1.2.0 with different behavior, and it gates the single most security-sensitive native bridge in the app (the PTY that runs live CLI agents in MAIN). node-pty is also in pnpm.onlyBuiltDependencies, so it executes build scripts at install. The risk is maintenance/longevity, not a known exploit.

**Impact.** If the beta is yanked or a security issue is found in this exact prerelease, there is no patched release on the same line to move to without re-validating the spaced-path constraint; the team is locked to an unsupported snapshot of the most privileged native module. A compromised republish of this exact version (mitigated by --frozen-lockfile + integrity hash, but the pin itself is a single point) would land in MAIN.

**Evidence.**

```ts
package.json:49  "node-pty": "1.2.0-beta.13",   // CLAUDE.md: "node-pty MUST stay winpty-free (the beta)" because repo path has a space
```

**Recommendation.** Track node-pty's stable 1.2.0 (or later winpty-free) release and migrate to it once published; until then keep the exact pin + lockfile integrity, and add the SCA scan so a future advisory on this version surfaces. Optionally relocate the repo to a space-free path to remove the constraint that forces the beta.

<details><summary>Adversarial verifier (confirmed)</summary>

The finding is accurately described and the code matches exactly. `package.json` line 49 pins `"node-pty": "1.2.0-beta.13"` with no semver range, and `pnpm-lock.yaml` locks the same version with an integrity hash (`sha512-ZbbJ7aJdmvRA53bw30D6YSJJKqo1IXTojD0kJeHZ/xZIxr7p1DCmvOmrOnjUo/rn1z4MDwKQGpx0C7K+cRKETw==`). The `pnpm.onlyBuiltDependencies` block at line 84-88 confirms native build scripts run on install. CLAUDE.md line 33 explicitly documents the constraint: the repo path `Z:\Canvas ADE` (space in path) causes winpty's `GetCommitHash.bat` to hard-fail on node-pty ≤1.1, forcing the beta which is winpty-free/ConPTY-only.

The issue is genuine: this is an exact prerelease pin on the most p …

</details>

---

#### 39. `electron-updater-unsigned-latent` _(verifier adjusted Medium → Low)_

**electron-updater 6.8.3 is a dependency but auto-update is not wired; enabling it while unsigned would allow update MITM**

- **Where:** `package.json`:48 · **dimension:** deps-build · **category:** dep · **finder confidence:** high

**What it is.** `electron-updater` ^6.3.4 (resolved 6.8.3) is in dependencies, but it is NOT currently wired into MAIN: a grep across src/ for `electron-updater|autoUpdater|setFeedURL|checkForUpdates` returns no matches, and electron-builder.yml sets `publish: null` (no feed). So today the updater is dormant and the MITM risk is LATENT, not active. The danger is the combination the brief flags: builds are unsigned until Phase 5 (electron-builder.yml mac `identity: null`; CI sets `CSC_IDENTITY_AUTO_DISCOVERY: false`; win nsis has no signing), and if auto-update is enabled before signing + a verified update channel are in place, electron-updater on Windows/Linux verifies update authenticity primarily via the publisher signature / blockmap over an HTTPS feed. An unsigned NSIS/AppImage update channel reduces the integrity guarantee to TLS-only, so a compromised or MITM'd feed (or a misconfigured non-HTTPS/generic provider) could deliver an attacker-controlled installer that the app auto-applies with full privileges.

**Impact.** If a future commit imports electron-updater and points it at a feed before code-signing lands, a network attacker or compromised release host could push a malicious signed-by-nobody update that the app installs automatically — full host compromise. As-is (not wired), no active exposure, but the dependency invites exactly that wiring.

**Evidence.**

```ts
package.json:48  "electron-updater": "^6.3.4";  electron-builder.yml:48  publish: null  / :40 identity: null;  src/ grep autoUpdater|electron-updater|checkForUpdates => no matches
```

**Recommendation.** Do not wire electron-updater until Phase 5 delivers code-signing + a pinned HTTPS update feed with signature verification. When wiring it: require signed artifacts (Windows Authenticode, macOS notarization), an HTTPS-only provider, and verify electron-updater's signature-check path is enabled. Add a guard/comment so it can't be enabled in an unsigned build. Consider removing it from dependencies until then to make the unused-but-dangerous surface explicit.

<details><summary>Adversarial verifier (adjusted)</summary>

All facts in the finding check out. `package.json` line 48 confirms `"electron-updater": "^6.3.4"` in `dependencies`. A grep across all `.ts` files and `src/` for `electron-updater`, `autoUpdater`, `setFeedURL`, `checkForUpdates`, and `checkForUpdatesAndNotify` returns zero matches — the package is present but completely unwired. `electron-builder.yml` line 48 is `publish: null` (no update feed) and line 40 is `identity: null` (unsigned mac builds; win nsis has no signing config either). The roadmap (`docs/roadmap.md` line 184) explicitly places auto-update under Phase 5, gated on a release feed.

The finding is genuine in that the combination of an unused-but-installed updater dependency + …

</details>

---

#### 40. `skiplibcheck-everywhere`

**skipLibCheck:true in all three tsconfigs masks type errors in dependency .d.ts (incl. the preload/IPC contract surface)**

- **Where:** `tsconfig.preload.json`:12 · **dimension:** deps-build · **category:** type · **finder confidence:** medium

**What it is.** All three project tsconfigs (tsconfig.node.json:12, tsconfig.preload.json:12, tsconfig.web.json:11) set `skipLibCheck: true`. This skips type-checking of all `.d.ts` files, including those of dependencies and any ambient declaration files. strict/noUnusedLocals/noUnusedParameters/isolatedModules are all on (good), so app source is strictly checked, but type mismatches that live in or flow through dependency declaration files — e.g. the contextBridge/preload typings that define the renderer-facing IPC surface, or an electron API signature change after an upgrade — would not be caught by `pnpm typecheck`. This is a common pragmatic setting and low risk on its own, but it weakens the guarantee that the typecheck gate fully validates the security-relevant preload contract, and it will mask signature drift when Electron is finally upgraded.

**Impact.** Type-level regressions in dependency/ambient declarations (including the preload IPC bridge typings and Electron API surface) pass CI silently. Most acutely, the Electron-33->latest upgrade recommended above could change webPreferences/IPC signatures that skipLibCheck would hide until runtime.

**Evidence.**

```ts
tsconfig.preload.json:12  "skipLibCheck": true,  (identical in tsconfig.node.json:12 and tsconfig.web.json:11)
```

**Recommendation.** Acceptable to keep for build speed, but during the Electron upgrade temporarily flip skipLibCheck:false (at least for the preload project) to surface API-signature drift, and document that the preload/IPC d.ts is the one surface where library-type drift matters for security.

<details><summary>Adversarial verifier (confirmed)</summary>

All three tsconfigs confirmed: tsconfig.node.json line 12, tsconfig.preload.json line 12, and tsconfig.web.json line 13 all set "skipLibCheck": true. The finding is accurate as stated.

However, the claimed impact needs nuancing. The preload IPC contract surface (CanvasApi type) lives in src/preload/index.ts and src/preload/index.d.ts — these are project source files included via the "include" arrays, not node_modules .d.ts files. skipLibCheck only skips .d.ts files inside node_modules (dependency declarations), not the project's own hand-written .d.ts files. Notably, tsconfig.web.json explicitly includes "src/preload/index.d.ts" in its include list (line 27), meaning the ambient Window.api …

</details>

---

#### 41. `no-security-eslint-rules`

**ESLint config has no security-focused rules; no-eval is only disabled, never enforced**

- **Where:** `eslint.config.mjs`:93-103 · **dimension:** deps-build · **category:** arch · **finder confidence:** high

**What it is.** The flat ESLint config is functionally sound (typescript-eslint recommended, react-hooks, no-unused-vars-as-error, prettier last) but contains no security-oriented linting: no eslint-plugin-security, no no-restricted-imports/globals to guard the never-weaken contract (e.g. forbidding `child_process`/`fs`/node-pty imports in renderer/preload, or flagging `nodeIntegration:true`/`webSecurity:false` literals), and `no-eval` is not enabled anywhere — it is only explicitly turned OFF for the e2e harness (`'no-eval': 'off'`) along with `no-explicit-any: off`. So eval and `any` in src/ are governed only by the base recommended sets, and there is no lint-level enforcement of the renderer/preload/MAIN privilege boundary that CLAUDE.md treats as a hard contract.

**Impact.** A future change that, e.g., imports node-pty or child_process into the renderer/preload, sets nodeIntegration:true, disables webSecurity, or introduces eval on attacker-influenceable input would not be flagged by lint — the security boundary relies entirely on review/tests rather than an automated gate.

**Evidence.**

```ts
eslint.config.mjs:99-101  'no-eval': 'off', / 'no-empty-pattern': 'off', / '@typescript-eslint/no-explicit-any': 'off'   (for e2e); no eslint-plugin-security / no-restricted-imports anywhere in the config
```

**Recommendation.** Add a renderer/preload override with `no-restricted-imports` banning Node/native modules (node-pty, child_process, fs, simple-git) outside src/main, and `no-restricted-syntax`/literals flagging nodeIntegration:true / webSecurity:false / sandbox:false. Consider eslint-plugin-security for the MAIN code. Keep the e2e relaxations scoped to e2e/ only (already the case).

<details><summary>Adversarial verifier (confirmed)</summary>

The finding is confirmed as written. Reading the full eslint.config.mjs (108 lines): the four override blocks are (1) global ignores, (2) base `js.configs.recommended` + `tseslint.configs.recommended`, (3) a `src/main/**` + `src/preload/**` block with only `no-console: off`, (4) a `src/renderer/**` block with react-hooks/react-refresh rules and `no-console: warn`, and (5) an `e2e/**` block with `no-eval: 'off'`, `no-empty-pattern: 'off'`, `@typescript-eslint/no-explicit-any: 'off'`. There are zero `no-restricted-imports` rules anywhere in the config, no `eslint-plugin-security` (confirmed absent from package.json), and `no-eval` is not explicitly enabled for `src/` — `js.configs.recommended` …

</details>

---

#### 42. `previewlayer-reconcile-on-every-viewport-frame` _(verifier adjusted Medium → Low)_

**BrowserPreviewLayer store subscription runs full reconcile (alloc + O(n) loop) on every per-frame setViewport write during pan/zoom**

- **Where:** `src/renderer/src/canvas/boards/BrowserPreviewLayer.tsx`:878-891 · **dimension:** perf-arch · **category:** perf · **finder confidence:** high

**What it is.** The layer subscribes to the canvas store with NO selector: `useCanvasStore.subscribe((s) => { const selChanged = syncSelection(s); reconcile(toGeom(s.boards)); ... })`. Zustand fires this callback on EVERY state mutation, not just board changes. Canvas.tsx line 759-761 writes `setViewport({x,y,zoom})` from `useOnViewportChange.onChange`, which fires once per animation frame for the whole duration of any pan/zoom gesture, and each frame carries a genuinely new transform (so the store's own dedup at canvasStore.ts:460 does NOT short-circuit it). Therefore every camera frame triggers this subscription, which unconditionally allocates a fresh `BoardGeom[]` via `toGeom` (a `.filter().map()` over all boards, BrowserPreviewLayer.tsx:842-853) and then `reconcile`, which rebuilds `geomRef.current = new Map(...)` (line 746) and loops over every board (line 763). This runs IN ADDITION to the dedicated rAF camera-sync pump (startPump/flushBatch), so the per-frame camera cost is doubled: the pump does the real native-bounds work, while this subscription does redundant filter/map/Map-rebuild allocation every frame for no geometry change.

**Impact.** During every pan/zoom (the single most common interaction), each frame allocates a new boards-filtered array + a new Map + iterates all boards, on the main thread, purely as a side effect of the camera-position write. With many boards this competes with the rAF pump for frame budget and adds steady GC pressure across a long session. The reconcile is largely a no-op (diff-skips), but the allocation and iteration are not skipped.

**Evidence.**

```ts
const unsub = useCanvasStore.subscribe((s) => {
  const selChanged = syncSelection(s)
  reconcile(toGeom(s.boards))
  ...
  if ((selChanged || fullViewIdRef.current !== null) && !gestureRef.current) applyLiveness()
})
```

**Recommendation.** Guard the subscription on the slice it actually depends on. Capture the previous `boards` reference and `selectedId` and early-return when neither changed: `let prevBoards = state.boards; const unsub = subscribe((s) => { if (s.boards === prevBoards && !selChangedCheap(s)) return; prevBoards = s.boards; ... })`. Or use `subscribeWithSelector` keyed on `s.boards`. The camera transform is already read live inside the rAF pump via getViewport(), so a viewport-only write should not re-run reconcile at all.

<details><summary>Adversarial verifier (confirmed)</summary>

The finding is structurally correct. Walking through the actual code:

1. `canvasStore.ts:455-462` — `setViewport` dedup (`return s` at line 460) only short-circuits when the viewport is completely unchanged. During any active pan/zoom, the transform changes every frame, so `return { viewport: vp }` fires, producing a new state object and notifying all Zustand subscribers.

2. `BrowserPreviewLayer.tsx:878-880` — The subscribe callback has no guard on `s.boards`: `reconcile(toGeom(s.boards))` is called unconditionally on every store notification, including viewport-only writes.

3. `toGeom` (lines 842-853) unconditionally runs `.filter().map()` over every board, allocating a fresh `BoardGeom[ …

</details>

---

#### 43. `onnodeschange-perframe-snap-allocation`

**Drag/resize snap pass allocates a fresh others-array per pointer frame and runs O(n) alignment compute with a high constant**

- **Where:** `src/renderer/src/canvas/Canvas.tsx`:269-371 · **dimension:** perf-arch · **category:** perf · **finder confidence:** high

**What it is.** `onNodesChange` runs on every React Flow node-change emission, i.e. once per pointer-move frame during a drag or resize. On each frame it rebuilds `const others = boards.filter(...).map((b) => ({x,y,w,h}))` (Canvas.tsx:280-282 for drag, :316-318 for resize) — a full allocation over all other boards every frame — then calls `computeAlignment` / `computeResizeSnap`. Inside alignmentGuides.ts, `computeAlignment` itself allocates two more arrays (`xOthers`, `yOthers`, lines 289-290) and `bestAxisMatch` runs, per other board, a 3×3 align-stop double loop plus 4 gap candidates (lines 111-148), and `bestDistribution` sorts the neighbor list (line 184) and scans it again. Net per drag frame: ~4 array allocations of size n + O(n) compare work with a non-trivial constant. None of it is memoized or coalesced to rAF — it is synchronous inside the change handler.

**Impact.** On a canvas with many boards, dragging/resizing a single board does O(n) allocation + compute on the main thread per pointer frame, which can degrade drag smoothness and add GC churn during the gesture. Blast radius is bounded to active drag/resize and the constant is small for typical board counts, hence Low.

**Evidence.**

```ts
const others = boards
  .filter((b) => b.id !== single.id)
  .map((b) => ({ x: b.x, y: b.y, w: b.w, h: b.h }))
const rect = { x: single.position.x, y: single.position.y, w: dragged.w, h: dragged.h }
const snap = computeAlignment(rect, others, SNAP_THRESHOLD_PX / rf.getZoom())
```

**Recommendation.** Precompute the static `others` rects once at drag-start (they don't move during a single-board drag) and reuse the array across frames, rebuilding only on drag start / board-set change. The xOthers/yOthers projections in computeAlignment could likewise be hoisted or computed once per gesture. This removes the per-frame n-sized allocations.

<details><summary>Adversarial verifier (confirmed)</summary>

The code is exactly as the auditor described. In Canvas.tsx at lines 280-282 (drag path) and 316-318 (resize path), each pointer-move frame that carries an active `position` or `dimensions` change triggers a fresh `boards.filter().map()` allocation over all boards. These arrays are not cached across frames — there is no ref, no memoization, and no rAF coalescing guard on the snap pass itself (the only rAF coalescing in Canvas.tsx is for the ResizeObserver/pane-resize path at line 473-486, not for onNodesChange). In alignmentGuides.ts lines 289-290, `computeAlignment` then allocates two more axis-projected arrays (`xOthers`, `yOthers`) before calling `bestAxisMatch` (O(n) × 3×3 stop loop) and …

</details>

---

#### 44. `nodes-memo-data-object-churn`

**`nodes` useMemo mints a new `data` object for every board on each selection/focus/fullview change, defeating BoardNode render bailout**

- **Where:** `src/renderer/src/canvas/Canvas.tsx`:227-245 · **dimension:** perf-arch · **category:** perf · **finder confidence:** medium

**What it is.** The `nodes` memo maps every board to a node whose `data` is a freshly-allocated object literal `{ board: b, dimmed: ..., fullView: ... }`. The memo's deps include `selectedId`, `focusedId`, `fullViewId`, `cameraFullViewId` — so a change to ANY of those (e.g. selecting one board, or entering full view on one board) recomputes the whole array and hands EVERY BoardNode a brand-new `data` reference, even for boards whose dimmed/fullView/board values are all unchanged. React Flow passes `data` through to BoardNode; a new object reference means the prop identity changes for all nodes on every selection/focus transition.

**Impact.** Selecting a board or toggling focus/full-view re-renders every BoardNode (and re-runs its hooks/portal effects) rather than only the affected ones. On a dense canvas this is an O(n) render storm per selection click. BoardNode does its own internal useStore(isLod) subscription, but the data-object identity change still forces it through render. Bounded impact (selection is not a hot per-frame path), hence Low.

**Evidence.**

```ts
data: {
  board: b,
  dimmed:
    (focusedId !== null && focusedId !== b.id) ||
    (cameraFullViewId !== null && cameraFullViewId !== b.id),
  fullView: fullViewId === b.id || cameraFullViewId === b.id
},
```

**Recommendation.** React Flow already diffs node data when controlled; but to avoid re-rendering unaffected nodes, compute `dimmed`/`fullView` as primitives and only rebuild a node's `data` object when one of its own flags changed (e.g. memoize per-id, or keep `dimmed`/`fullView` out of `data` and derive them inside BoardNode from cheap store/context selectors). At minimum, memoize node objects so unchanged boards keep referential identity.

<details><summary>Adversarial verifier (confirmed)</summary>

The finding is genuine and the code path is exactly as described.

**Canvas.tsx lines 227–245:** The `nodes` useMemo maps every board to a fresh object literal on every recompute. Its deps include `selectedId`, `focusedId`, `fullViewId`, `cameraFullViewId`, so selecting any board (or changing focus/full-view) invalidates the whole memo and produces N new node objects — each with a freshly-allocated `data: { board, dimmed, fullView }`.

**React Flow internals (node_modules/@xyflow/system/dist/esm/index.mjs line 1613):** `adoptUserNodes` has a fast-path: `if (_options.checkEquality && userNode === internalNode?.internals.userNode)` — strict reference identity on the whole node object. Because …

</details>

---

#### 45. `planningboard-god-file-1188-loc` _(verifier adjusted Medium → Low)_

**PlanningBoard.tsx is a 1188-line god component owning ~10 distinct concerns (whiteboard engine, paste, export, context menu, drag/snap, erase, marquee)**

- **Where:** `src/renderer/src/canvas/boards/PlanningBoard.tsx`:112-1188 · **dimension:** perf-arch · **category:** arch · **finder confidence:** high

**What it is.** The PlanningBoard function body spans lines 112-1188 and bundles many independent subsystems into one component with a large shared closure: (1) tool state + tool cluster UI (88-98, 865-956), (2) the full pointer state machine for move/arrow/pen/erase/marquee with snapping (438-863), (3) image paste-from-clipboard document listener (258-294), (4) image drag-drop (296-312), (5) the export popover with portal + layout-measure + outside-click effects (314-362, 917-954), (6) the right-click context-menu builder with align/distribute/group/lock entries (621-767), (7) checklist auto-grow (419-435), (8) the render dispatch over element kinds (1096-1161). Many of these hold their own refs/state and effects in the single component scope, and the pointer-move handler (540-595) does live snap computation inline. This violates the repo's stated 'one file = one clear purpose' convention and makes the hot pointer-move path hard to isolate/optimize.

**Impact.** Every state change in any of these concerns re-renders the entire component and re-creates its many useCallbacks; the pointer-move snap math, export popover, and context-menu builder all live in one closure so they can't be independently memoized or unit-tested. High coupling raises regression risk on the whiteboard hot path and obscures where per-frame work happens.

**Evidence.**

```ts
export function PlanningBoard({...}: BoardViewProps<PlanningBoardData>): ReactElement {
  ... // 1076 lines of mixed concerns: pointer FSM, paste, export popover, context menu, render
}
```

**Recommendation.** Extract: (a) the pointer interaction state machine + snapping into a `usePlanningPointer(board, {...})` hook returning handlers + draft/drag/marquee state; (b) the export popover into a `<WhiteboardExportButton>` component (owns its portal/effects/layout); (c) the context-menu entry builder into a pure `buildPlanningMenu(...)` module (it is already nearly pure); (d) the element render dispatch into a `<PlanningElements>` component. This leaves PlanningBoard as a thin composition shell and isolates the per-frame move path.

<details><summary>Adversarial verifier (adjusted)</summary>

The file is confirmed at 1188 lines (ending at line 1188, function body from line 112) with 52 hook calls inside one component, so the structural observation is accurate. However, the finding's claimed impact is substantially overstated:

1. Pure logic already extracted: snapping.ts (86 lines, tested), erase.ts (110 lines, tested), marquee.ts (28 lines, tested), align.ts (160 lines, tested), elements.ts (478 lines, tested), exportBoard.ts (108 lines) all live in planning/ with their own *.test.ts files. The claim that "the snap math… can't be independently unit-tested" is false — computeSnap is in snapping.ts and is already unit-tested.

2. Pointer hot-path uses a ref, not state: `drag.curre …

</details>

---

#### 46. `canvas-god-file-857-loc-state-sprawl`

**Canvas.tsx CanvasInner concentrates ~15 useState/useRef plus four full-view/focus/tile state machines and all keyboard wiring in one component**

- **Where:** `src/renderer/src/canvas/Canvas.tsx`:102-842 · **dimension:** perf-arch · **category:** arch · **finder confidence:** medium

**What it is.** CanvasInner (102-842) holds focusedId, activeTile(+ref), fullViewId(+ref), fullViewHost, fullViewEntering, fullViewClosing, cameraFullViewId(+ref), priorViewportRef, guides, overlaps, snapSuppressRef, diag — and implements three overlapping camera/modal lifecycles (portal full-view, camera full-view, double-click focus) plus the live-tile responsive ResizeObserver, the snap pass inside onNodesChange, the tidy/tile apply pipeline, and four separate window keydown effects (654-740). The full-view portal logic and the camera-full-view logic are interleaved with refs mirroring state purely to keep callbacks stable, which is a symptom of too many concerns sharing one scope.

**Impact.** The component is hard to reason about and any change risks the delicate full-view/focus/tile interactions (already the source of multiple numbered bugs #14/#30/#38/#40/#41). Re-renders of CanvasInner re-create many callbacks. Bounded because most state here is not on a per-frame path, hence Low.

**Evidence.**

```ts
const [focusedId, setFocusedId] = useState<string | null>(null)
const [activeTile, setActiveTile] = useState<TileTemplate | null>(null)
... const [fullViewId, setFullViewId] = useState<string | null>(null)
... const [cameraFullViewId, setCameraFullViewId] = useState<string | null>(null)
// + fullViewEntering/closing, guides, overlaps, snapSuppressRef, 4 keydown effects
```

**Recommendation.** Extract a `useFullView()` hook (owns fullViewId/host/entering/closing + open/close/hardClose/entered/exited + camera-full-view), a `useTidyTile()` hook (activeTile + applyTile/tidyAndFit + the ResizeObserver), and a `useCanvasKeybindings(handlers)` hook for the four keydown effects. CanvasInner then composes them, halving its size and isolating each lifecycle for testing.

<details><summary>Adversarial verifier (confirmed)</summary>

The file was read in full (lines 102–842). The counts are accurate: CanvasInner contains exactly 10 useState calls (focusedId, activeTile, fullViewId, fullViewHost, fullViewEntering, fullViewClosing, guides, overlaps, cameraFullViewId, diag) and 6 useRef calls (paneRef, activeTileRef, snapSuppressRef, fullViewIdRef, cameraFullViewIdRef, priorViewportRef), totaling 16 hooks of these two types. There are 10 useEffect calls, including 3 that exist solely to sync a ref mirror to its paired state variable (lines 134, 165, 176 — the activeTileRef, fullViewIdRef, cameraFullViewIdRef pattern), and 4 keyboard effects (lines 657, 715, 730, 744). The three distinct lifecycles described by the finding — …

</details>

---

### ⬜ Info (12)

#### 47. `implicit-secure-defaults-not-pinned`

**webSecurity / allowRunningInsecureContent / experimentalFeatures not explicitly pinned on either window (rely on Electron defaults)**

- **Where:** `src/main/windowSecurity.ts`:16-30 · **dimension:** electron-security · **category:** arch · **finder confidence:** high

**What it is.** buildMainWindowWebPreferences explicitly sets sandbox:true, contextIsolation:true, nodeIntegration:false, webviewTag:false (strong), and the preview view sets sandbox/contextIsolation/nodeIntegration. Neither explicitly sets webSecurity (default true), allowRunningInsecureContent (default false), experimentalFeatures (default false), nodeIntegrationInSubFrames (default false), or enableBlinkFeatures. These rely on Electron's secure defaults, which is correct today. Given the 'never-weaken' contract, pinning them explicitly makes the security posture an asserted, test-covered invariant rather than an implicit default that a future Electron major or a stray webPreferences merge could silently flip. The existing windowSecurity.test.ts already asserts the explicit flags, so extending the asserted set is cheap.

**Impact.** No current vulnerability — defaults are secure. Risk is future-regression resistance and explicitness of the security contract.

**Evidence.**

```ts
return {
    preload: preloadPath,
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    webviewTag: false
  }  // webSecurity / allowRunningInsecureContent / experimentalFeatures not set
```

**Recommendation.** Explicitly set webSecurity:true, allowRunningInsecureContent:false, experimentalFeatures:false (and on the preview view too) and extend windowSecurity.test.ts to assert them, so the secure posture is pinned rather than inherited.

<details><summary>Adversarial verifier (confirmed)</summary>

The code at windowSecurity.ts lines 16-30 confirms that `buildMainWindowWebPreferences` explicitly sets only `sandbox:true`, `contextIsolation:true`, `nodeIntegration:false`, and `webviewTag:false`. The flags `webSecurity`, `allowRunningInsecureContent`, `experimentalFeatures`, and `nodeIntegrationInSubFrames` are not set, relying on Electron's defaults. The same pattern holds in preview.ts lines 231-241 where the `WebContentsView` webPreferences set only `sandbox:true`, `contextIsolation:true`, `nodeIntegration:false`, and `partition`. The windowSecurity.test.ts confirms the test coverage gap: only the four explicitly-set flags are asserted. There is no current vulnerability — Electron's de …

</details>

---

#### 48. `pty-launchcommand-trusted-autoexec`

**launchCommand is written verbatim into the shell (by design) — relies entirely on the restored-terminals-are-idle rule to avoid silent auto-exec from a hand-edited canvas.json**

- **Where:** `src/main/pty.ts`:521-525 · **dimension:** pty-terminal · **category:** arch · **finder confidence:** high

**What it is.** Per the locked 'spawn the SHELL, not the agent' contract, `opts.launchCommand` is free-text written as the first PTY line: `if (launch) proc.write(launch + '\r')`. This is intentional and matches the trusted-user threat model (launchCommand can be any agentic CLI). I confirmed the one residual risk — a corrupt/hand-edited or imported canvas.json carrying a hostile launchCommand auto-executing on project open — is mitigated renderer-side: `markRestoredIdle()` marks every restored terminal idle-on-mount (canvasStore.ts:198-202) and a duplicated terminal is added to `idleOnMountIds` (canvasStore.ts:333), so the spawn effect renders an explicit Start affordance instead of auto-spawning (TerminalBoard.tsx:393-403). launchCommand therefore only fires after an explicit user Start/Restart, never silently on restore. main does NOT independently re-validate launchCommand (it trusts the renderer), so the no-silent-auto-exec property is enforced solely in the renderer; if a future code path spawned a restored terminal without honoring isIdleOnMount, the launchCommand would auto-run.

**Impact.** None under the current code + trusted-user model. Noting the coupling: the 'no silent shell execution on project open' safety property lives entirely in the renderer's idle-on-mount gating, not in main. main will spawn + write whatever launchCommand it is handed.

**Evidence.**

```ts
`const launch = opts.launchCommand?.trim()
    if (launch) proc.write(launch + '\r')` (pty.ts:524-525). Mitigation: `for (const b of boards) if (b.type === 'terminal') idleOnMountIds.add(b.id)` (canvasStore.ts:201).
```

**Recommendation.** No change required. Optionally document the invariant 'main trusts the renderer to gate launchCommand auto-exec via idle-on-mount' near the proc.write call so a future refactor of the spawn path doesn't accidentally drop the gate. Defense-in-depth would be a main-side rule that does not write launchCommand on an adopt/restore code path.

<details><summary>Adversarial verifier (confirmed)</summary>

All code cited in the finding was verified exactly as described. At pty.ts:524-525, `launchCommand` is written verbatim to the PTY with no main-side validation or filtering — only `shell` is validated via `resolveShell` (pty.ts:432). The idle-on-mount gating is entirely renderer-side: `markRestoredIdle()` at canvasStore.ts:198-202 marks all restored terminals idle, `idleOnMountIds.add(cloneId)` at canvasStore.ts:333 marks duplicated terminals idle, and TerminalBoard.tsx:393-403 checks `isIdleOnMount(board.id)` before spawning — showing `setState('idle')` instead of calling `launch()`. The flag is non-consuming (uses `.has()` not `.delete()`) and is only cleared by explicit user Start action …

</details>

---

#### 49. `provider-error-message-leaks-response-body-to-renderer` _(verifier adjusted Low → Info)_

**Raw provider HTTP error body is forwarded verbatim to the renderer via provider-error.message**

- **Where:** `src/main/llmService.ts`:183 · **dimension:** llm-egress · **category:** leak · **finder confidence:** medium

**What it is.** On a non-ok provider response, the thrown error embeds the full response body (`await res.text()`); runSummarize catches it and returns { ok:false, reason:'provider-error', message } which crosses IPC to the renderer (llm:summarize). The response body is the provider's body, which does NOT contain the API key, so this is not a key leak. However it forwards arbitrary upstream error text (potentially large, potentially containing rate-limit/account identifiers or, for a misconfigured 'local' endpoint, internal-network response content) into the renderer unfiltered and untruncated. Combined with the unvalidated local baseUrl, an attacker who controls baseUrl could use the error channel as a small exfiltration/SSRF-oracle (the response text of an internal endpoint is reflected back to the renderer).

**Impact.** Untrusted/large upstream text reflected to the renderer; minor info-disclosure and a response-oracle for the local-baseUrl SSRF case. Not a key leak.

**Evidence.**

```ts
if (!res.ok) throw new Error(`${config.provider} HTTP ${res.status}: ${await res.text()}`)
```

**Recommendation.** Do not embed the raw response body in the renderer-facing message. Log the body MAIN-side if needed, and return a bounded, sanitized message to the renderer (e.g. `${provider} HTTP ${status}` plus a truncated/first-N-chars snippet), so the error channel can't reflect arbitrary upstream/internal content.

<details><summary>Adversarial verifier (adjusted)</summary>

The code at line 183 of `Z:\Canvas ADE\.claude\worktrees\audit-main\src\main\llmService.ts` confirms the pattern exactly as cited: `throw new Error(`${config.provider} HTTP ${res.status}: ${await res.text()}`)`. In `runSummarize` (lines 218-223) the catch block forwards `err.message` verbatim as the `message` field of the `SummarizeResult`. In `llmIpc.ts` line 81-85 the `llm:summarize` handler returns the full `SummarizeResult` directly to the renderer — no scrubbing, no truncation.

So the factual description is accurate: the full raw provider HTTP response body does cross IPC to the renderer.

However, the severity claimed (Low) should be adjusted down to Info given the actual threat model …

</details>

---

#### 50. `navigate-blocked-scheme-no-bounds-resync`

**Blocked-scheme navigate leaves view attached but renderer never re-pushes bounds after recovery (cosmetic, no leak)**

- **Where:** `src/main/preview.ts`:518-537 · **dimension:** preview-lifecycle · **category:** correctness · **finder confidence:** high

**What it is.** preview:navigate to a disallowed scheme sets e.failed = true and emits did-fail-load WITHOUT loading anything, leaving the native view attached over the board still showing the previously loaded page (or blank). The latch is only cleared by a later did-start-navigation from a real (allowed) loadURL. This is the intended trust-boundary behaviour and does not leak a renderer; noting it as the only observable rough edge: the board UI shows 'load-failed' over a still-live native view painting the old content underneath the snapshot fallback ordering.

**Impact.** Minor visual inconsistency only: a 'Couldn't load' overlay can sit over a native view still painting the prior page. No renderer leak, no security-contract break (the blocked URL is never fetched).

**Evidence.**

```ts
if (!isAllowedPreviewUrl(args.url)) {
      e.failed = true
      emit({ id: args.id, type: 'did-fail-load', url: args.url, errorCode: -1, errorDescription: 'blocked scheme' })
      return false
    }
    void e.view.webContents.loadURL(args.url)
```

**Recommendation.** Optional: on a blocked navigate, also load a benign about:blank (or keep the current page) and document that the native view intentionally stays attached. No code change required for correctness.

<details><summary>Adversarial verifier (confirmed)</summary>

The code confirms the finding exactly as described.

At `src/main/preview.ts` lines 524–534, a blocked-scheme `preview:navigate` sets `e.failed = true` and emits a synthetic `did-fail-load` event, but never calls `loadURL`, so the native `WebContentsView` remains attached and continues painting its prior content.

The renderer receives that event at `src/renderer/src/canvas/boards/BrowserPreviewLayer.tsx` line 966 and calls `patchRuntimeIfPresent(ev.id, { status: 'load-failed', ... })`, which causes `BrowserBoard`'s `DeviceContent` component to render the "Couldn't load" overlay (BrowserBoard.tsx line 308–316).

However, BrowserBoard.tsx line 300 documents that `DeviceContent` is "The fallba …

</details>

---

#### 51. `project-current-skips-unsafe-dir-guard` _(verifier adjusted Low → Info)_

**project:current uses recents[0].path without the isUnsafeProjectDir guard applied to project:open/create**

- **Where:** `src/main/projectIpc.ts`:167-187 · **dimension:** persistence · **category:** path-safety · **finder confidence:** high

**What it is.** project:open (line 103) and project:create (line 133) both reject the renderer-supplied dir via isUnsafeProjectDir before any fs touch. project:current instead reads recents[0].path from recent-projects.json (in userData) and feeds it straight into readProject, setCurrentDir, gcAssets, and scaffoldProjectMemory (lines 171-176) with NO isUnsafeProjectDir re-validation. recent-projects.json is a plain, user-writable JSON file; listRecents (recentProjects.ts lines 29-36) validates field *types* and existsSync but never the path's safety. The persisted path then becomes the authoritative currentDir for all subsequent asset/memory writes.

**Impact.** Limited: paths in recents are absolute by construction and an attacker able to edit userData already has substantial local access. But it is an inconsistency in the path-safety contract — the one fs entrypoint that does NOT re-validate its directory is the auto-open-on-launch path, which then drives scaffoldProjectMemory (writes .canvas/) and gcAssets (deletes files) in whatever dir the file names.

**Evidence.**

```ts
const recents = listRecents(userDataDir)\n    if (recents.length === 0) return null\n    const r = readProject(recents[0].path)   // no isUnsafeProjectDir(...) here\n    if (r.ok) {\n      setCurrentDir(r.dir)\n      ...\n      gcAssets(r.dir, collectAssetIds(r.doc))\n      scaffoldProjectMemory(r.dir)
```

**Recommendation.** Apply `if (isUnsafeProjectDir(recents[0].path)) return null` (and prune the bad entry) before readProject in project:current, matching the open/create handlers.

<details><summary>Adversarial verifier (adjusted)</summary>

The core observation is accurate: the `project:current` handler at lines 138–149 of `src/main/projectIpc.ts` does NOT call `isUnsafeProjectDir` on `recents[0].path` before passing it to `readProject`, `setCurrentDir`, and `gcAssets`. This is a real code-pattern inconsistency.

However, two pieces of the finding's evidence are stale/wrong, reducing the severity:

1. The claimed line range (167–187) is wrong — the handler is at lines 138–149 in the current file.
2. The quoted evidence includes `scaffoldProjectMemory(r.dir)` — this function does not exist anywhere in the codebase (`grep` found zero matches). The actual handler only calls `setCurrentDir`, `touchRecent`, and `gcAssets`.

More imp …

</details>

---

#### 52. `fresh-doc-stale-schemaversion`

**createProject writes a fresh canvas.json at schemaVersion 2 while the current SCHEMA_VERSION is 4**

- **Where:** `src/main/projectStore.ts`:84-101 · **dimension:** persistence · **category:** type · **finder confidence:** high

**What it is.** createProject seeds a brand-new project with `const fresh = { schemaVersion: 2, viewport: null, boards: [] }` (line 98) even though boardSchema.SCHEMA_VERSION is 4. New projects are therefore born two versions stale and immediately run through migrate (2->3->4) on first load. This is not data loss (the migrations are pure version bumps, viewport already null/boards empty), but it is an avoidable inconsistency: a hard-coded literal in MAIN must be manually kept in lockstep with the renderer's SCHEMA_VERSION, and MAIN cannot import the renderer constant (tsconfig.node boundary). If a future migration from v2/v3 ever does real backfill, freshly-created empty projects would needlessly traverse it.

**Impact.** None today; a latent drift hazard. A fresh project is needlessly down-rev and depends on the migration pipeline staying a no-op for the v2->current span.

**Evidence.**

```ts
const fresh = { schemaVersion: 2, viewport: null, boards: [] }\n  await writeProject(dir, fresh)
```

**Recommendation.** Define the current schema version as a shared constant MAIN can reference (or document the literal as 'must equal SCHEMA_VERSION' with a unit test asserting equality), and seed fresh docs at the current version.

<details><summary>Adversarial verifier (confirmed)</summary>

The code at `src/main/projectStore.ts` line 98 confirms the finding verbatim: `const fresh = { schemaVersion: 2, viewport: null, boards: [] }`. The renderer's `boardSchema.ts` line 15 confirms `export const SCHEMA_VERSION = 4`. The gap is real — fresh projects are seeded two versions behind the current schema. The migration chain (lines 230-239 of boardSchema.ts) shows that v2→v3 is a pure version bump (`(doc) => ({ ...doc, schemaVersion: 3 })`) and v3→v4 is likewise a pure version bump for the image element. Since a fresh project has no boards and viewport:null, both migrations are complete no-ops and no data is lost or transformed. The `fromObject` function (line 443) calls `migrate()` on …

</details>

---

#### 53. `module-lastrecorded-shared-singleton`

**Module-scoped `lastRecorded` (and `idleOnMountIds`) are process-global singletons shared across any store instance / test**

- **Where:** `src/renderer/src/store/canvasStore.ts`:129, 185 · **dimension:** store-undo · **category:** arch · **finder confidence:** high

**What it is.** `lastRecorded` and `idleOnMountIds` live at module scope, not in the Zustand store. The dedup ref is correctly cleared on `loadObject`/`applyOpenResult` (lines 504, 519) and after undo/redo (lines 490, 498). For the single-user desktop target (one store, one window) this is sound. The only sharp edge is test isolation: the test suite resets store state via `useCanvasStore.setState({ past:[], future:[], ... })` in beforeEach, but that does NOT reset the module `lastRecorded`. A test could therefore inherit a `lastRecorded` reference from a prior test pointing at a now-discarded boards array; since the guard is a reference-equality check against the live `s.boards`, a stale ref simply never matches and is harmless (it can only cause a MISSED dedup = an extra snapshot, never a wrong undo). No production path constructs a second store instance.

**Impact.** None in production (single store). In tests, a stale module ref across cases can at most suppress dedup for one beginChange; cannot corrupt state or produce a wrong undo result.

**Evidence.**

```ts
let lastRecorded: Board[] | null = null
// ...
const idleOnMountIds = new Set<string>()
```

**Recommendation.** Document that module-scoped undo-dedup state is intentionally process-global (single-window app). If future multi-window/multi-store support is ever added, move `lastRecorded` and `idleOnMountIds` into the store state so each instance is independent.

<details><summary>Adversarial verifier (confirmed)</summary>

The code at lines 129 and 185 of src/renderer/src/store/canvasStore.ts confirms both `lastRecorded` (Board[] | null) and `idleOnMountIds` (Set<string>) are module-scope singletons, exactly as described. The test file canvasStore.test.ts uses `useCanvasStore.setState({ boards: [], past: [], future: [], ... })` in every beforeEach, which only resets Zustand in-store state — it does not touch the module-level `lastRecorded`. A stale `lastRecorded` from a prior test pointing at a now-discarded boards array will never match the new test's `s.boards` reference (reference equality check at line 166 via `trackedChange`), so it can only cause a missed dedup (one extra undo snapshot), never a wrong un …

</details>

---

#### 54. `measured-ref-not-pruned`

**measuredRef map retains stale entries for deleted whiteboard elements**

- **Where:** `src/renderer/src/canvas/boards/PlanningBoard.tsx`:203-206 · **dimension:** renderer-react · **category:** leak · **finder confidence:** medium

**What it is.** measuredRef (Map<id,{w,h}>) is written by reportMeasure and read in marquee/snap/align, but entries are never removed when an element is deleted. The map grows monotonically with every text/checklist ever created on the board for the board's lifetime. Reads tolerate staleness (elementBBox falls back to nominal), so this is purely unbounded-per-board growth, bounded by element creation count within one board's mounted lifetime.

**Impact.** Minor memory growth in a long-lived planning board with heavy element churn; no correctness impact.

**Evidence.**

```ts
const measuredRef = useRef<Map<string, { w: number; h: number }>>(new Map())
  const reportMeasure = useCallback((id: string, w: number, h: number) => {
    measuredRef.current.set(id, { w, h })
  }, [])
```

**Recommendation.** Optionally prune measuredRef on commit/delete (e.g. delete entries whose id is no longer in elements), or accept it as a bounded per-session cache.

<details><summary>Adversarial verifier (confirmed)</summary>

The code at lines 203-206 of PlanningBoard.tsx confirms the Map is initialized once and entries are only ever added via `reportMeasure` (line 205: `measuredRef.current.set(id, {w, h})`). A full-text search for `measuredRef.current.delete` and `measuredRef.current.clear` returns no matches anywhere in the file. The two deletion paths — `deleteEl` (line 382, calls `commit(removeElement(elements, id))`) and the erase-tool pointer-up handler (line 820-822, calls `commit(removeElements(..., removed))`) — both commit the element removal to the store without touching `measuredRef`. So stale entries genuinely accumulate for the board's mounted lifetime.

The severity adjustment stays at Info because …

</details>

---

#### 55. `iconbtn-dead-longpress-timer`

**IconBtn long-press timer has no unmount cleanup (currently dead code)**

- **Where:** `src/renderer/src/canvas/BoardFrame.tsx`:68-83 · **dimension:** renderer-react · **category:** leak · **finder confidence:** high

**What it is.** IconBtn arms a window.setTimeout in handlePointerDown and clears it only on mouseup/mouseleave/click/contextmenu — there is no useEffect unmount cleanup. If a button unmounts mid-hold (e.g. a board deleted while a control is held), the timer would fire onLongPress on an unmounted component. This is currently latent/dead: a grep shows NO call site passes onLongPress (handlePointerDown early-returns `if (!onLongPress) return`), so no timer is ever armed today.

**Impact.** None today (feature unused). Would become a real leak/post-unmount-setState bug the moment any IconBtn is given an onLongPress.

**Evidence.**

```ts
const handlePointerDown = (): void => {
    if (!onLongPress) return
    heldRef.current = false
    timerRef.current = window.setTimeout(() => {
      heldRef.current = true
      onLongPress()
    }, longPressMs)
  }
```

**Recommendation.** Add a useEffect(() => () => clearTimer(), []) to clear timerRef on unmount before the long-press feature is wired up.

<details><summary>Adversarial verifier (confirmed)</summary>

The code at Z:\Canvas ADE\src\renderer\src\canvas\BoardFrame.tsx lines 68-83 exactly matches the quoted evidence. `timerRef` is armed via `window.setTimeout` in `handlePointerDown` and cleared in `handleClick`, `onMouseLeave`, `onMouseUp`, and `onContextMenu` — but there is no `useEffect` returning a cleanup that calls `clearTimer()` on unmount. A full grep of `src/` for `onLongPress` shows it appears only within BoardFrame.tsx itself (declaration, prop type, early-return guard, and the callback invocation). No external call site passes `onLongPress` to an `IconBtn`, so the `if (!onLongPress) return` guard at line 77 means the timer is never actually armed today. The finding is technically c …

</details>

---

#### 56. `before-quit-flush-no-catch` _(verifier adjusted Low → Info)_

**before-quit chains flushRenderer→shutdown with no .catch — a rejection at quit routes through unhandledRejection→crashShutdown(1) racing app.exit(0)**

- **Where:** `src/main/index.ts`:217-224 · **dimension:** silent-failures · **category:** silent-failure · **finder confidence:** medium

**What it is.** The guarded before-quit handler does `void flushRenderer().then(() => shutdown()).finally(() => app.exit(0))` with no .catch. flushRenderer is defensively coded (resolves on reply or timeout) and shutdown()'s drained promise is bounded, so in practice neither rejects today. But if shutdown()/disposeAllPtys()'s Promise.all ever rejects (e.g. a killTree implementation change), the unhandled rejection fires process.on('unhandledRejection') → crashShutdown(1, reason) (index.ts:240), which calls app.exit(1) racing the .finally's app.exit(0). The original quit error cause is logged only incidentally via crashShutdown(err) and the exit code is nondeterministic.

**Impact.** Latent: a future change that makes the shutdown chain reject turns a clean quit into a crash-path exit (code 1) with a confusing log, and double-fires the shutdown. No user-data impact today; flagged as a robustness/error-propagation gap at a critical lifecycle seam.

**Evidence.**

```ts
`void flushRenderer()\n    .then(() => shutdown())\n    .finally(() => app.exit(0))` (index.ts:221-223). No .catch; the only rejection sink is the global `process.on('unhandledRejection', (reason) => crashShutdown(1, reason))`.
```

**Recommendation.** Add `.catch((err) => console.error('quit shutdown failed', err))` before `.finally(() => app.exit(0))` so the quit path owns its own errors and never leaks into the crash handler.

<details><summary>Adversarial verifier (adjusted)</summary>

The structural gap is real: `src/main/index.ts` lines 221-223 run `void flushRenderer().then(() => shutdown()).finally(() => app.exit(0))` with no `.catch`, and the global unhandledRejection handler at line 240 calls `crashShutdown(1, reason)` → `app.exit(1)`, which would race the `.finally`'s `app.exit(0)` if the chain ever rejected.

However, the "latent" framing is the correct one. Reading the actual promise chain end-to-end:

1. `flushRenderer()` (lines 180-201) wraps in `new Promise<void>((resolve) => {...})` and only ever calls `resolve()` — on IPC reply or 1500ms timeout fallback. Cannot reject.

2. `shutdown()` (lines 164-170) returns `disposeAllPtys()`, which calls `disposeAllPtysCo …

</details>

---

#### 57. `detect-ports-error-not-propagated`

**onPreview detectPorts/IPC errors not handled — a rejected detectPorts leaves the 'preview' affordance dead with no feedback**

- **Where:** `src/renderer/src/canvas/boards/TerminalBoard.tsx`:561-576 · **dimension:** silent-failures · **category:** silent-failure · **finder confidence:** medium

**What it is.** onPreview awaits window.api.detectPorts(board.id) with no try/catch. detectPorts invokes the terminal:detectPorts IPC; if MAIN throws/rejects for any reason the await rejects and the async callback's rejection is unhandled (the click handler is `() => void onPreview('tap')`, BoardNode/TerminalBoard.tsx:601-603, so a rejection floats). In normal operation the MAIN handler returns [] for foreign senders and parses safely, so this is not currently reachable — hence Info — but the affordance has no error branch: a rejection would silently do nothing (no 'no server detected' note, no error).

**Impact.** Defensive gap only: the preview-detect button could become a silent no-op on an unexpected IPC error with the user getting no 'try again' note. Not currently triggerable from the read code paths.

**Evidence.**

```ts
`const urls = await window.api.detectPorts(board.id)` inside `onPreview` (TerminalBoard.tsx:564), wrapped by callers as `onClick={() => void onPreview('tap')}` (TerminalBoard.tsx:601).
```

**Recommendation.** Wrap the detectPorts await in try/catch and set the existing previewNote on failure, so the button always gives feedback.

<details><summary>Adversarial verifier (confirmed)</summary>

The code at `TerminalBoard.tsx:561-576` confirms the finding exactly: `onPreview` awaits `window.api.detectPorts(board.id)` at line 564 with no try/catch, and all three call sites wrap it as `() => void onPreview(...)` (lines 601-603), which discards the returned promise so any rejection floats unhandled. The MAIN handler at `pty.ts:408-413` cannot currently throw — it returns `[]` for foreign senders or calls the pure `parsePortsFromOutput()` which only iterates regex matches and always returns an array. So the rejection path is not currently reachable. However, the structural gap is real: if the IPC channel itself errors (renderer-side contextBridge throws, preload not loaded, etc.) the `a …

</details>

---

#### 58. `fittoboards-repeated-minmax-spread`

**fitToBoards and applyTile compute bounds with four separate Math.min/max spread passes over all boards**

- **Where:** `src/renderer/src/canvas/Canvas.tsx`:413-416 · **dimension:** perf-arch · **category:** perf · **finder confidence:** high

**What it is.** `fitToBoards` does four full spread-reductions over the boards array: `Math.min(...boards.map(b=>b.x))`, `Math.min(...boards.map(b=>b.y))`, `Math.max(...boards.map(b=>b.x+b.w))`, `Math.max(...boards.map(b=>b.y+b.h))` (lines 413-416). Each `.map()` allocates a temp array and each spread into Math.min/max is O(n); applyTile (435-452) and freeSlot in the store similarly use spreads. Beyond allocation, `Math.min(...arr)` / `Math.max(...arr)` with a very large board count can hit the JS engine argument-count limit (spreading a huge array as call args), though board counts realistically stay small.

**Impact.** Negligible for normal projects (small n). Listed as Info because it is invoked only on explicit fit/tidy/tile actions, not per frame; the spread-as-args pattern is a latent (very-large-n) correctness edge and an avoidable 4× allocation.

**Evidence.**

```ts
const minX = Math.min(...boards.map((b) => b.x))
const minY = Math.min(...boards.map((b) => b.y))
const maxX = Math.max(...boards.map((b) => b.x + b.w))
const maxY = Math.max(...boards.map((b) => b.y + b.h))
```

**Recommendation.** Replace the four spreads with a single for-loop accumulating minX/minY/maxX/maxY, removing the four temp arrays and the spread-as-args hazard. Pure mechanical change.

<details><summary>Adversarial verifier (confirmed)</summary>

The code at Canvas.tsx lines 413-416 exactly matches the quoted evidence: four separate `Math.min/max(...boards.map(...))` calls, each allocating a temporary array and spreading it as call arguments. `applyTile` at lines 441-442 adds two more spread-reductions over the same `cur` array. There is no consolidation or caching elsewhere. The claimed pattern is real. However, severity stays at Info: this app is a single-user desktop canvas where board counts are realistically in the single-to-low-double digits. The allocations are trivial at that scale, and the spread-as-args V8 argument-count limit (~65k) is unreachable in practice. These functions are invoked only on explicit user actions (fit/ …

</details>

---

## Refuted findings (false positives caught at verify)

These were raised by a finder and **killed** by the adversarial verifier. Listed for transparency — they are *not* issues.

- **`preview-view-no-explicit-websecurity`** _(claimed Info, electron-security, `src/main/preview.ts`:231-242)_ — Preview WebContentsView omits explicit webSecurity:true while hosting untrusted content
  - **Why false positive:** The defaults already provide the desired security posture. webSecurity is true by default and allowRunningInsecureContent is false by default in Electron/Chromium. The auditor themselves stated "None currently (defaults hold)" for impact — this is a style preference for explicit over implicit hardening flags, not an actual defect or vulnerability.
- **`pty-newchannel-typecast`** _(claimed Info, pty-terminal, `src/main/pty.ts`:184-188, 158, 454)_ — sessionDeps.newChannel casts MessageChannelMain to a structural PortPair without proving port1/port2 ordering — benign but unverified
  - **Why false positive:** The `PortPair` interface at lines 88–91 explicitly types `port1` and `port2` as `MessagePortMain`, and `SessionDeps.newChannel: () => PortPair` is satisfied by `() => new MessageChannelMain()` via TypeScript structural typing — no unverified cast exists. Both destructuring sites (adoptCore line 158, spawn line 454) use the same `port1`→proc / `port2`→renderer convention, verified by the compiler. There is no asymmetry and no runtime risk.
- **`canvas-llm-ping-unbudgeted-no-keystore`** _(claimed Info, llm-egress, `src/main/index.ts`:194-200)_ — CANVAS_LLM_PING dev probe runs runSummarize with defaultDeps() — no budget store and no safeStorage keyStore (env-key only)
  - **Why false positive:** The "issue" is fully documented in ADR 0003 §3 as an intentional, accepted exemption. The probe requires a manually set env var (`CANVAS_LLM_PING`), runs at most once per process start, is not renderer-reachable, and makes zero real calls without an env API key. The unbudgeted/no-keystore behavior is deliberate — it is a manual operator smoke-check, not a loop or user-reachable code path. The finding itself states it is not a defect and recommends no change.
- **`future-stack-loses-oldest-redo`** _(claimed Low, store-undo, `src/renderer/src/store/history.ts`:22-24)_ — applyUndo caps `future` by dropping the OLDEST redo entry (slice(0,LIMIT)) — past keeps newest, future keeps oldest
  - **Why false positive:** The behavior is correct: future uses prepend + slice(0,LIMIT) while past uses append + slice(-LIMIT), so both rails drop the oldest entries at the limit boundary. The auditor explicitly concedes correctness in the finding text. This is a code-style observation (asymmetric but correct), not a bug.
- **`openmenus-set-mutation-on-clear`** _(claimed Info, store-undo, `src/renderer/src/store/previewStore.ts`:128-137)_ — previewStore.clear/requestReload are immutable, but the openMenus Set is correctly cloned before mutation — no leak
  - **Why false positive:** This is not a bug report — it is a positive verification note confirming correct implementation. The code does exactly what the finding describes: clones the Set before mutating, guards no-ops with early returns, and uses spreads for all byId patches. No real issue exists.
- **`setpointercapture-unwrapped`** _(claimed Info, renderer-react, `src/renderer/src/canvas/boards/PlanningBoard.tsx`:468)_ — setPointerCapture calls are not wrapped (throws on synthetic events in E2E only)
  - **Why false positive:** The setPointerCapture calls in production are only ever reached via real OS pointer events (Electron's native input pipeline), where the call succeeds normally. Unit tests stub the API at `Element.prototype.setPointerCapture` (lines 13–16 of `PlanningBoard.interaction.test.tsx`). E2E tests use `sendInputEvent` (real OS input), not `dispatchEvent`. The project memory explicitly prescribes wrapping the synthetic *dispatcher* in try/catch, not the production handler. No production path is at risk.
- **`export-chunk-buildexport-no-perf-issue-note`** _(claimed Info, perf-arch, `src/renderer/src/canvas/boards/PlanningBoard.tsx`:323-336)_ — Export, paste and image-decode paths correctly keep heavy work off the render path (clean)
  - **Why false positive:** This is a positive "clean" coverage note, not a bug. The auditor confirmed correct patterns, not a defect. Re-reading lines 244-249, 291-294, and 323-336 of PlanningBoard.tsx shows every claim is accurate: dynamic import at 327, bmp.close() at 248, IPC asset write at 239, and properly cleaned-up document paste listener at 291-294 gated on well-focus at 268. No issue exists to confirm.

---

## Per-dimension coverage notes

What each finder actually read and what it found clean (credit where due).

### Electron security & window hardening `(electron-security)`

Read in full: src/main/index.ts (window creation, setWindowOpenHandler, will-navigate/will-redirect/will-frame-navigate guards, quit/crash teardown, smoke/shot env paths), src/main/windowSecurity.ts (buildMainWindowWebPreferences, windowOpenDecision, computeAppOrigin, navDecision) + its test src/main/windowSecurity.test.ts to confirm intended behavior, src/preload/index.ts (full contextBridge 'api' surface) + src/preload/index.d.ts, src/main/preview.ts (preview view webPreferences, nav guards, windowOpenHandler, isAllowedExternal/isAllowedPreviewUrl scheme allowlists, isForeignSender frame-guard). Also read src/renderer/index.html + electron.vite.config.ts cspMeta plugin (DEV/PROD CSP), src/main/e2eMain.ts (env-gated debug registry). Repo-wide greps confirmed: NO setPermissionRequestHandler/setPermissionCheckHandler anywhere; NO @electron/remote/enableRemoteModule; NO registerSchemesAsPrivileged/custom protocol handlers; NO global web-contents-created hook; only two setWindowOpenHandler sites (main window + preview), both deny in-app and route allowlisted schemes externally.\n\nVERIFIED CLEAN: (1) Main window webPreferences are strong — sandbox:true, contextIsolation:true, nodeIntegration:false, webviewTag:false. (2) setWindowOpenHandler on both the main window and every preview view returns action:'deny' and hands only allowlisted http/https/mailto schemes to shell.openExternal (file:/smb:/data:/custom dropped) — matches the contract. (3) Preview native views correctly have NO preload (no ipcRenderer reachable from untrusted content) and per-board partition isolation; page-driven nav is scheme-gated (will-navigate/will-redirect/will-frame-navigate via registerPreviewNavGuards, http(s)-only) and loadURL is scheme-allowlisted at the IPC boundary. (4) isForeignSender frame-guards every preview IPC handler against foreign-frame senders. (5) preload contextBridge surface is minimal and typed: no ipcRenderer/require/process/Node leak; the only window.postMessage re-post pins window.location.origin (not '*') and rides MessagePorts in the transfer list; onPreviewEvent/onFlush hand listeners only the payload, never the IpcRendererEvent. (6) The e2e debug surface (e2eMain.ts) is hard-gated on process.env.CANVAS_E2E and a no-op otherwise; CANVAS_SHOT/CANVAS_SMOKE are dev/env-gated.\n\nBLIND SPOTS: did not audit projectIpc.ts / pty.ts / localServer.ts internals beyond grepping for permission/protocol/session APIs (out of this dimension's scope — those carry their own IPC-validation and command-injection surface that another dimension should cover). CSP enforcement at runtime (meta vs onHeadersReceived) was read from config but not validated against a packaged build artifact. The LLM-egress / connect-src interaction (ADR 0003) is in MAIN and bypasses renderer CSP, so it is not assessable from these files. Drag-drop navigation finding (packaged-fileurl-nav-allowed) was corroborated by grepping the renderer for global drop/dragover preventDefault (only board-scoped handlers found) but full renderer drag-drop flow was not exhaustively traced.

### PTY / terminal security & lifecycle `(pty-terminal)`

Read in full: src/main/pty.ts (714 lines), src/renderer/src/canvas/boards/TerminalBoard.tsx (820), TerminalConfig.tsx, terminalState.ts, src/renderer/src/store/terminalRuntimeStore.ts. Cross-checked: src/main/portDetect.ts, src/preload/index.ts (data-plane re-post + control-plane invokes), src/main/preview.ts (to confirm Browser-board isolation from the PTY channel), src/main/index.ts (handler wiring, shutdown/crash paths), src/main/windowSecurity.ts (main-window sandbox/contextIsolation/nodeIntegration), src/renderer/src/lib/boardSchema.ts (terminal field typing + validation), src/renderer/src/canvas/Canvas.tsx delete/park flow, src/renderer/src/store/canvasStore.ts idle-on-mount gating.\n\nVERIFIED CLEAN:\n• Command injection: shell, launchCommand, cwd, args are all passed to pty.spawn as separate argv (no string concatenation into a shell command line); launchCommand goes through proc.write (a PTY line, the documented trusted-user design), never interpolated into spawn args. `SpawnOpts.args` exists in main but the renderer never sends it (boardSchema has no `args` field; both spawn call sites in TerminalBoard.tsx omit args) — the only args path is the hard-coded `['-l','-i']` for Git Bash. No unsanitized interpolation found.\n• Spawn-the-shell rule: pty.spawn(shell, args, ...) spawns the shell; launchCommand is a separate written line. Correct.\n• Shell selection hardening: resolveShell (M5) canonicalizes a persisted shell and only accepts it if it matches an enumerated system-discovered shell, else falls back to OS default — a corrupt canvas.json cannot name an arbitrary binary. canonicalizeShellPath resolves 8.3/junction/symlink. safeCwd (SEC-1) falls back to homedir for a missing/non-dir cwd.\n• Tree-kill correctness: killTreeCommand — Windows `taskkill /PID <pid> /T /F` (reaps re-parented descendants) PLUS proc.kill() for ConPTY/conout-worker disposal; POSIX kills the negative pgid with SIGKILL, falling back to proc.kill(). Awaitable with a bounded 2s fallback so shutdown awaits the reap (#49). disposeAllPtys drains BOTH live (sessions) and parked maps (PTY-1 fix for the parked-leak).\n• PID-reuse / stale-exit races: identity guards `live.proc === proc` on onData (stops late-flush bytes bleeding into a respawned session), onExit (stops a stale OLD-proc exit posting 'exited' to / reaping a NEW session under the same id, via isStaleExit + cleanupCore), and a Restart-race guard (pty:spawn reaps an existing session for the id before overwriting, #13). These directly address the memory-noted Windows pid-reuse class.\n• MessagePort lifecycle: spawn transfers port2 to the renderer and binds port1; cleanup/park close the renderer port (try/caught); adopt mints a fresh channel and re-binds; the renderer unmount closes portRef and calls killTerminal. Park closes the port but keeps the proc; delete sends parkTerminal BEFORE removeBoard so main parks before the unmount's kill arrives, and the post-park cleanup(id) no-ops because park already removed the entry from sessions. No port-leak path found.\n• IPC frame-guards: all 7 PTY/terminal handlers (pty:shells, terminal:detectPorts, pty:spawn, pty:kill, pty:disposeAll, pty:park, pty:adopt) call isForeignSender first and deny/no-op a foreign frame. Main window is sandbox:true, contextIsolation:true, nodeIntegration:false, webviewTag:false.\n• Browser-board → PTY isolation: preview WebContentsViews are created with no preload (so no ipcRenderer/window.api), sandbox:true, per-board partition; their only outward channels are scheme-allowlisted nav guards + setWindowOpenHandler(deny). They cannot reach pty:* (frame-guarded anyway). Confirmed Browser content has no path to the PTY write channel.\n• Resource leaks: node-pty kill() disposes ConPTY/worker; WebGL slot pooling releases on LOD/unmount/context-loss; xterm/FitAddon/listeners disposed on unmount; parked sessions have an unref'd TTL timer that reaps on expiry and is cleared on adopt/exit. uncaughtException/SIGINT/SIGTERM all route to crashShutdown → shutdown (best-effort tree-kill).\n• Env/PATH/auth: env: { ...process.env } forwards the full main env (documented 'inherit PATH/profile/auth'). Verified no LLM API key or secret lives in process.env in main (keys use safeStorage, not env), so this forwarding does not leak the egress credential into spawned shells.\n\nBLIND SPOTS: I did not read node-pty's native resize/kill internals (the pinned beta) — the resize-bounds finding assumes node-pty does not pre-validate cols/rows, which I could not confirm from this repo. I did not exercise the actual Windows taskkill behavior at runtime (read-only audit). The safeStorage key-store assertion is based on grep of src/main for env/API_KEY patterns, not a full read of the LLM key-store module (out of this dimension's scope).

### LLM egress, secrets & prompt-injection `(llm-egress)`

Audited the full LLM egress path on the MAIN branch (files do not exist on the current feat/expanse-site checkout; read every target file via `git show main:`). Read in full: src/main/llmService.ts (231 lines), src/main/llmIpc.ts (138), src/main/llmConfig.ts (74), src/main/llmKeyStore.ts (82), src/main/llmBudget.ts (95), src/renderer/src/lib/llmModels.ts (8), docs/decisions/0003-llm-egress.md (68). Also read the wiring/consumers to trace the end-to-end flow: src/main/summaryLoop.ts (the prompt-injection/digest surface that builds SummarizeInput from board content), src/main/memoryEngine.ts (change detector / digest field set), src/main/index.ts:140-214 (safeStorage Encryptor build + registerLlmHandlers + CANVAS_LLM_PING probe + e2e key-dir isolation), src/preload/index.ts:187-208 (llm.* bridge), and src/renderer/src/canvas/SettingsModal.tsx (the only renderer writer of setConfig/setKey).\n\nVerified CLEAN / correct: (1) safeStorage usage — keys encrypted via safeStorage.encryptString, base64-stored in userData/llm-keys.json (NEVER project folder/.canvas/canvas.json), and setKey returns false + writes nothing when isEncryptionAvailable() is false — no plaintext fallback. (2) No key/secret logging anywhere (grepped console.log/warn/error across llm*.ts + summaryLoop.ts; nothing logs keys, headers, or the request). (3) Key crosses IPC inbound-only; llm:status returns hasKey presence only, never key material. (4) All five llm:* channels are frame-guarded via isForeignSender (foreign sender → safe default / forbidden). (5) Egress is the ONLY outbound path: the sole outbound fetch in src/main is inside getProvider.summarize (line 177) via the injected transport (+ default adapter line 229); openrouter/openai/anthropic destinations are hardcoded and NOT user-overridable. (6) TLS — all hardcoded endpoints are https; the only non-TLS possibility is a user-set local baseUrl (by design). (7) Timeout/abort: AbortController + 30s default timeout with clearTimeout in finally. (8) Budget: read-check-write is fully synchronous (no await between read and write) so Node's single thread precludes double-spend; reserve-before-egress, not refunded on error (fail-closed); cap validated on read (finite, >=0, Math.floor); no integer-overflow risk (calls increment by 1, capped by >= comparison); a 0 cap cleanly disables egress. (9) Passive-output / lethal-trifecta: summary text from runSummarize goes only to disk (summaryLoop mem.writeBoard) or over IPC to the renderer — NO renderer consumer wires it to a PTY write or tool dispatch (grepped; none), and pty.write is never fed summary/memory text, so untrusted board content reaching the model never returns to the PTY/tool channel. (10) Digest privacy: only meaningful human-readable fields leave (terminal launchCommand/cwd/port, browser url/viewport, planning checklist titles+items+note text), capped at MAX_INPUT_CHARS=4000; browser previewSourceId is explicitly excluded.\n\nFindings are all Low/Medium/Info — no Critical/High. The single Medium (unvalidated local baseUrl SSRF) is explicitly documented as accepted residual risk in ADR 0003. Blind spots: I did not re-verify the global setWindowOpenHandler/CSP/sandbox flags (out of this dimension's scope), and I did not run the LLM unit tests — analysis is static from the source on the main branch.

### WebContentsView preview lifecycle & leaks `(preview-lifecycle)`

Read in full: src/main/preview.ts, src/renderer/src/canvas/boards/BrowserPreviewLayer.tsx, src/renderer/src/canvas/boards/BrowserBoard.tsx, src/renderer/src/store/previewStore.ts, src/renderer/src/store/disposeLiveResources.ts, src/renderer/src/lib/previewPlan.ts, src/renderer/src/lib/previewTarget.ts, src/renderer/src/lib/browserLayout.ts, plus cross-referenced src/renderer/src/lib/cameraBounds.ts, src/preload/index.ts (preview bridge), src/renderer/src/canvas/Canvas.tsx (mount + node-gesture wiring), src/renderer/src/canvas/AppChrome.tsx (project-switch dispose + Tidy menu detach), and src/main/index.ts (shutdown / before-quit / crash paths).\n\nCHECKED AND FOUND CLEAN:\n\n1. WebContentsView close-not-destroy: disposeOne (preview.ts:373-383) is the only teardown path; it does detach() then webContents.close() inside try/catch, then views.delete(id). No destroy() call exists anywhere. disposeAll (569-572) iterates over a COPIED key array ([...views.keys()]) so the in-loop delete is safe, and nulls owner. closeBoard (BrowserPreviewLayer 444-455) routes to closePreview → disposeOne. No remove-without-close path found.\n\n2. Leak paths around async opens: attachBoard's new-board branch (BrowserPreviewLayer 414-437) awaits openPreview, then re-checks recs.current.has(g.id) (Bug #48/#30) AND r.attached/attachSeq (ATTACH-1) before the trailing live:true patch — so a board deleted/closed mid-open can't resurrect a store entry. The MAIN-side view created by a late preview:open is still keyed in the views Map, so a subsequent reconcile→closeBoard→closePreview→disposeOne (or closeAll on unmount) closes it. IPC from the renderer is FIFO per send-order on the main thread and openPreview's handler returns synchronously (loadURL is fire-and-forget void), so open-then-closeAll on unmount creates-then-disposes; no orphaned view.\n\n3. ~4 live-view cap: MAX_LIVE=4 enforced in BOTH drivers — applyLiveness via pickLive(candidates, MAX_LIVE, center) (598-622) and the creation path in reconcile via the liveNow<MAX_LIVE guard (757-789, Bug #M1). Over-cap eligible boards are closed only when a snapshot/exists fallback is present (Bug #24).\n\n4. Per-board partition isolation: ensure() (preview.ts:231-242) sets partition: `preview-${id}` with sandbox:true, contextIsolation:true, nodeIntegration:false on every WebContentsView. Matches ADR 0002.\n\n5. rAF camera sync: driven by useOnViewportChange({onStart:beginMotion, onChange:startPump, onEnd:endMotion}) (648) — NOT React re-render. startPump (482-491) guards rafRef.current to prevent duplicate loops and self-stops after 4 idle frames. flushBatch (458-480) coalesces ALL attached boards into ONE setPreviewBoundsBatch IPC per frame, diff-skipped with rectsEqual. The dedicated full-view rAF (694-738) and the camera rAF both cancelAnimationFrame in cleanup; the unmount effect (973-979) also cancels rafRef + closeAllPreviews. The full-view pump self-terminates (Bug L4) and re-arms on window resize.\n\n6. Snapshot/LOD detach ordering: capture happens WHILE attached (demoteToSnapshot 346-375, beginMotion 495-554) — capture→await→patch snapshot→detach. capturePreview rejections are swallowed (catch→null) so the detach is NEVER skipped (Bug #8/#9), correctly prioritizing pulling the always-above native layer out. attachSeq + recs.current.has re-checks after every await guard against concurrent attach/delete (Bug #15/#45/#48). The demoting Set + try/finally drain (Bug H1) prevents permanently-frozen bounds. main preview:capture also guards e.attached and isEmpty().\n\n7. Full-view detach-vs-close: applyLiveness's full-view branch (564-592) uses demoteToSnapshot (detach, keep webContents) for non-full-view boards — never closeBoard — matching the fullview-detach-not-close memory; comments explicitly call out that a close would discard navigated page state and reset to board.url. The full-view board is HELD detached during fullViewMotion and re-attached at settle.\n\n8. Navigation handling for untrusted localhost: isAllowedPreviewUrl (http/https only) gates preview:open + preview:navigate at the IPC boundary; registerPreviewNavGuards blocks page-driven will-navigate/will-redirect/will-frame-navigate to disallowed schemes; setWindowOpenHandler denies in-app nav and routes to openExternalSafe (http/https/mailto allowlist). isForeignSender frame-guards every preview:* handler. No path lets preview content reach the PTY channel (renderer layer only calls preview:* IPC).\n\n9. setBounds/setZoomFactor math: round() applied main-side (round 204-211) and renderer-side (roundRect); fitZoomFactorForBounds derives the factor from the SAME rounded width fed to setBounds (Bug #20) keeping bounds.width/zoom===presetW exact; clamp [0.25,5] documented. applyZoom re-applies the held factor on every did-finish-load (a load resets zoom to 1).\n\n10. Listener leaks on unmount: onPreviewEvent returns an unsubscribe (preload 119-123) and the effect returns it (969); ResizeObserver + window resize listeners are disconnected in cleanup (908-911, 734-737). main-side per-view listeners live for the view's lifetime and die with webContents.close().\n\nBLIND SPOTS: This was a static read; I did not execute the e2e matrix. The known live-WebContentsView env flake (e2e-browser-trio-flake) and any GPU-contended capturePage behaviour are runtime concerns outside static scope. The single Info finding is a documented intentional trust-boundary behaviour, not a defect. No Critical/High/Medium/Low issues found in this dimension — the lifecycle, leak-prevention, cap enforcement, and camera-sync code is unusually well-guarded with explicit re-check-after-await discipline.

### Persistence, data integrity & path safety `(persistence)`

Audited the MAIN branch (working tree was checked out on feat/expanse-site, which predates the memory subsystem — confirmed via git, then read every in-scope file from `git show main:`). Files read in full from main: src/main/projectStore.ts, src/main/projectIpc.ts, src/main/recentProjects.ts, src/main/canvasMemory.ts, src/main/memoryEngine.ts, src/main/summaryLoop.ts, src/renderer/src/lib/boardSchema.ts; plus src/renderer/src/store/useAutosave.ts and persistence.integration.test.ts (identical on both branches). Cross-referenced: canvasStore.ts (toObject/loadObject/applyOpenResult/PATCHABLE_KEYS/setViewport), index.ts (flushRenderer/before-quit/crashShutdown + memoryEngine+summaryLoop wiring), AppChrome.tsx (switchTo), WelcomeScreen.tsx, preload/index.ts (project/asset/memory/export channels + onFlush reply). VERIFIED CLEAN: (1) atomic writes — every canvas.json/recents/llm/asset/memory writer goes through write-file-atomic; no direct writeFileSync/fs.writeFile bypass exists; canvas.json is written only via the one envelope-guarded writeProject path. (2) Envelope-level .bak fallback works (readProject tries primary then .bak on parse/envelope failure; torn files are rejected on read). (3) writeProject envelope-guards the incoming doc (PERSIST-1) so junk can't rotate into .bak. (4) Scene/session split is well enforced — toObject serializes only {schemaVersion,viewport,boards}; PATCHABLE_KEYS prevents ephemeral keys (tool/selection/draft/hover) landing on boards; structuredClone on both sides prevents aliasing (BUG-027 covered, confirmed by test). (5) Migration pipeline is sequential/version-gated and migrate() return-by-ref is safe because fromObject clones before migrating. (6) Autosave debounce + flush-on-blur/beforeunload + the MAIN project:flush quit handshake (awaited before app.exit(0)) is correct; concurrent flushes are de-duped by the dirty flag; project-switch cancels the pending timer (PERSIST-B) and aborts on a failed final flush (no silent tail loss). (7) Path traversal: isUnsafeProjectDir rejects relative paths and any `..` segment (checks both original and normalized, separator-agnostic) and is applied to project:open + project:create; assetId is regex-pinned to assets/<40-hex sha1>.<ext> with an ext allowlist; safeBoardId pins .canvas/memory writes to [A-Za-z0-9_-]{1,64}; memory:readBoards routes every id through safeBoardId; export:save sanitizes the default name and uses a dialog-chosen path; all asset/memory/save handlers operate on the already-validated getCurrentDir(). (8) All project:*/asset:*/memory:*/export:* IPC handlers are frame-guarded via isForeignSender (BUG-M6 null-window-denies fixed). (9) JSON parse errors are caught everywhere (tryParse, listRecents, readMd). Blind spots: did not execute the app or tests (read-only); LLM egress/key-store internals (llmService/llmKeyStore/llmBudget) were out of scope and only traced for the summaryLoop spend-gating contract; did not exhaustively audit canvasStore's undo/redo history machinery beyond its load/serialize touchpoints.

### Zustand store correctness & undo/history `(store-undo)`

Read in full: src/renderer/src/store/canvasStore.ts (533 lines), src/renderer/src/store/history.ts (39 lines), src/renderer/src/store/previewStore.ts (151 lines), src/renderer/src/lib/nodeChanges.ts (30 lines). Also read the two consumers that drive undo/history — src/renderer/src/canvas/Canvas.tsx (onNodesChange apply loop, onNodeDragStart beginChange, doUndo/doRedo focus-clear guard, setViewport via useOnViewportChange) and the relevant slices of src/renderer/src/canvas/boards/PlanningBoard.tsx (commit/beginChange wiring for element edits, growBoardHeight, the text-edit-vs-onEditStart split) — plus the test suites src/renderer/src/store/canvasStore.test.ts (470 lines) and history.test.ts.\n\nVERIFIED CLEAN: (1) State immutability — every mutating action (addBoard/removeBoard/duplicateBoard/updateBoard/resizeBoard/tidyBoards/tileBoards/growBoardHeight/setViewport/undo/redo/loadObject/applyOpenResult) produces new arrays via spread/map and never mutates a board object or array in place; undo snapshots the boards ARRAY reference onto `past` and structural sharing (unchanged boards keep their refs) is intentional and sound, so restoring an old array reference is safe because those objects were never mutated. (2) duplicateBoard uses structuredClone on plain board data + remaps element ids — boards carry only serializable fields (boardSchema), so no clone throw. (3) The lastRecorded phantom class — verified PER-ACTION: tidy/tile pass reflectPresent:true (sync), add/remove/duplicate pass reflectPresent:false (no sync, by design with documented tradeoff + dedicated regression tests at canvasStore.test.ts:377-414), undo/redo/loadObject/applyOpenResult all maintain lastRecorded correctly (lines 490/498/504/519). The 'tidyBoards was fixed but add/remove/duplicate may share the latent edge' concern is REAL but is the explicitly-tolerated #BUG M3 edge (reported Low), not a regression. (4) History bounds: recordPast caps past at 50 via slice(-limit); applyUndo caps future at 50 via slice(0,LIMIT) — both bounded, no unbounded growth. (5) Ephemeral exclusion: PATCHABLE_KEYS (lines 265-270) whitelists only durable per-type keys; selection/tool/draft/erase/hover/snapshot/preview-status all live in component state or previewStore and are never serialized or routed into a board patch. (6) Selector efficiency: setViewport no-op guard (Bug L2) and updateBoard/resizeBoard reference-equal no-change guards (STATE-2) prevent needless re-refs/subscriber churn; Canvas memoizes runningIds/edges/nodes to avoid the useSyncExternalStore fresh-Set infinite loop. (7) Race conditions: store actions are synchronous set() calls; the one async path (addImageFromBlob in PlanningBoard) calls beginChange()+commit() synchronously AFTER the await on the freshest closure, and onNodesChange reads useCanvasStore.getState() live for the remove-park ordering.\n\nBLIND SPOTS: did not trace every PlanningBoard pointer-gesture branch end-to-end (only the beginChange/commit wiring and the documented no-op-no-checkpoint discipline at lines 252/381/389/406/413/495/524/607/629/672/726/782/805/813/822/1029/1106/1121/1140); did not audit terminalRuntimeStore (out of scope). No Critical/High/Medium found — the store layer is well-disciplined with the phantom-undo tradeoff being intentional and test-locked.

### Renderer correctness & React hygiene `(renderer-react)`

Read in full: src/renderer/src/canvas/Canvas.tsx (857 lines), src/renderer/src/canvas/boards/PlanningBoard.tsx (1188 lines), src/renderer/src/canvas/BoardFrame.tsx (543 lines), src/renderer/src/canvas/BoardNode.tsx (262 lines), src/renderer/src/canvas/AppChrome.tsx (482 lines), src/renderer/src/canvas/FullViewModal.tsx (84 lines), src/renderer/src/App.tsx (42 lines). Cross-referenced: src/renderer/src/store/previewStore.ts (setMenuOpen/setNodeGesture ref-counting), src/renderer/src/store/canvasStore.ts (updateBoard replaces not merges; beginChange/growBoardHeight semantics), src/renderer/src/lib/motion.ts (cameraAnim/CAMERA_MS stability), src/renderer/src/canvas/boards/planning/tools.ts (shortcutTool excludes 1/0), src/renderer/src/canvas/fullViewContext.ts, src/renderer/src/main.tsx. Verified CLEAN: (1) Effect cleanups — all window/document listeners (Canvas keydown x2, Ctrl/Cmd tracker, FullViewModal host publish + enter/exit timers, BoardMenu/TidyMenu/exportPopover pointerdown+keydown+resize, PlanningBoard document paste, ResizeObserver) have matching removals; rAF in ResizeObserver and cancelAnimationFrame in FullViewModal are cancelled. (2) BoardMenu/TidyMenu setMenuOpen ref-counting and conditional cleanup `if(open) return ()=>...` correctly reattach previews on close AND unmount-while-open. (3) Stale closures — onNodesChange/boardActions/onWellPointerUp carry correct deps; fullViewId/cameraFullViewId/activeTile are mirrored to refs via effects so stable callbacks read live values; document paste re-subscribes when onWellPaste (and thus `elements`) changes, so no stale-elements there. (4) The BoardNode contentHost relocation (createPortal + useLayoutEffect with [contentHost,fullView,fullViewHost,lod] deps) correctly keeps boards mounted across LOD/full-view to preserve live PTY/native sessions. (5) Derived-state-in-effect resets (focusedId/fullViewId/cameraFullViewId heal on boards change; activeTile reset on open) are intentional and correctly guarded. (6) running→runningIds and boards→edges/nodes memos correctly avoid the documented useSyncExternalStore new-Set infinite-loop. Blind spots: did not run the app or tests; per-element card components (NoteCard/ChecklistCard/ImageCard/FreeText/WhiteboardSvg) and BrowserPreviewLayer were out of scope and not audited (the image-paste lost-update and any measure-loop behavior there are inferred from PlanningBoard's call sites only). No Critical/High found; the dimension is largely healthy with the error-boundary gap and the async-paste lost-update being the two most actionable items.

### Silent failures & error handling `(silent-failures)`

Read in full: all non-test src/main/*.ts — index.ts, pty.ts, preview.ts, projectStore.ts, projectIpc.ts, recentProjects.ts, localServer.ts, windowSecurity.ts, selfTest.ts, e2eMain.ts, portDetect.ts, ipcTestHarness.ts. Read in full or in the error-handling-relevant sections: renderer stores (canvasStore.ts, previewStore.ts, terminalRuntimeStore.ts, history.ts, useAutosave.ts, disposeLiveResources.ts), App.tsx, main.tsx, AppChrome.tsx, Canvas.tsx, BrowserPreviewLayer.tsx, TerminalBoard.tsx, BrowserBoard.tsx, TerminalConfig.tsx, PlanningBoard.tsx (image paste/drop/export region + catch sites), ImageCard.tsx, exportBoard.ts, ChecklistCard.tsx, NoteCard.tsx (drag handler), BoardNode.tsx (resize/detach region), WelcomeScreen.tsx, useRendererSmoke.ts, e2eRegistry.ts, e2eHooks.ts (catch sites), and the preload index.ts, plus boardSchema.ts fromObject/assertBoard. Grepped for catch / .catch( / try / void / as any / as unknown / eslint-disable across the whole scope and triaged every hit. CHECKED AND FOUND CLEAN: pty.ts — every catch is a deliberately-justified swallow of node-pty's documented throw-on-exited-pty/already-closed-port (with comments), and IPC errors DO propagate (pty:spawn rethrows for foreign senders, returns a typed spawn-failed result on real spawn errors which the renderer surfaces in TerminalBoard.respawn/launch); the .then/.catch on spawnTerminal correctly sets 'spawn-failed' and writes to the terminal. preview.ts — catches are window-gone / view-gone / capturePage-rejection swallows that are correct (a propagated capturePage rejection would skip the mandatory detach, Bug #9); did-fail-load/HTTP-error paths emit terminal states so a board never hangs on 'connecting'. projectStore writeProject envelope-guards before disk touch and project:save surfaces false on failure; autosave (useAutosave.ts) correctly surfaces a false/rejected save via onError→console.error and AppChrome.switchTo ABORTS the project switch on a failed final flush (a genuinely well-handled data-loss seam). gcAssets/readAsset/writeAsset swallows are bounded and intentional (locked/missing file must not abort the sweep). Process-level handlers (uncaughtException/unhandledRejection/SIGINT/SIGTERM) ARE present (index.ts:239-242) and route to a guarded best-effort crashShutdown — over-broad but defensible for a desktop app. previewStore/terminalRuntimeStore guard against resurrecting cleared orphans (patchIfPresent). Blind spots: did not execute the app or reproduce the corrupt-canvas.json crash at runtime (static read only, but the unguarded fromObject path and absence of any Error Boundary are textually confirmed); did not exhaustively read every planning whiteboard helper (align.ts, marquee.ts, snapping.ts, erase.ts, svgPaths.ts) — these are pure geometry with no IPC/await/catch surface per the grep, so low silent-failure risk.

### Type design, IPC contracts & validation `(type-contracts)`

Audited the audit-main worktree (.claude/worktrees/audit-main, detached HEAD 416464d) which is the canonical MAIN snapshot WITH the Context subsystem (PR #39) merged — the repo's own working tree (Z:\Canvas ADE) is on feat/expanse-site and lacks src/main/llmIpc.ts, so all paths below are repo-relative to that worktree.

Files read in full: src/renderer/src/lib/boardSchema.ts, src/preload/index.ts, src/preload/index.d.ts, src/renderer/src/canvas/boards/planning/elements.ts, src/main/projectIpc.ts, src/main/llmIpc.ts, src/main/llmService.ts, src/main/llmConfig.ts, src/main/llmKeyStore.ts, src/main/llmBudget.ts, src/main/projectStore.ts, src/main/canvasMemory.ts, src/main/memoryEngine.ts, src/main/summaryLoop.ts, src/renderer/src/lib/llmModels.ts. Traced the renderer->MAIN trust boundary into consumers: src/renderer/src/store/canvasStore.ts (loadObject/applyOpenResult), src/renderer/src/App.tsx, src/renderer/src/canvas/{WelcomeScreen,AppChrome,SettingsModal}.tsx, and src/main/index.ts (handler wiring + safeStorage encryptor).

CHECKED-AND-CLEAN: (1) boardSchema deep validation (assertBoard/assertPlanningElement) is robust — it rejects unknown board.type and element.kind, non-finite/zero geometry, malformed checklist items, bad tints/viewports, and clamps below-min sizes rather than dropping; the `as NoteTint`/`as BrowserViewport` casts are SAFE because they only feed .includes() membership guards. (2) PlanningElement union is exhaustive — elementBBox/shiftElement cover every kind with no fall-through (strict TS would error on a missing case). (3) asset:write trusts ext:string and bytes:Uint8Array from the renderer, but projectStore.writeAsset re-validates ext against ASSET_EXTS and content-addresses by sha1 (no path traversal); readAsset re-validates assetId against ASSET_RE — the MAIN-side runtime guard holds even though the IPC type is loose. (4) project dir traversal is guarded (isUnsafeProjectDir rejects `..` in original+normalized form, both path flavors). (5) memory:readBoards re-guards ids via safeBoardId regex. (6) API key is write-only inbound, never returned over IPC (llm:status returns hasKey boolean only), never logged. (7) writeProject envelope-guards the incoming doc before disk + rotates .bak. (8) Browser-content/PTY separation holds at the type level — preview:navigate args reach loadURL on the preview webContents, never a PTY write channel. BLIND SPOTS: did not exhaustively audit pty.ts/preview.ts handler bodies (out of dimension scope) beyond confirming the navigate/PTY separation; did not run typecheck.

### Test quality & coverage gaps `(tests-coverage)`

SCOPE: Audited the MAIN security-critical surface and its tests on the working tree (branch feat/expanse-site is docs-only; the MAIN app code is present and identical). Read in full: src/main/{windowSecurity,pty,preview,projectIpc,projectStore,ipcTestHarness,localServer,index}.ts and their tests (windowSecurity.test, pty.test + pty.integration.test, preview.test + preview.integration.test, projectIpc.test + projectIpc.integration.test, projectStore.test); src/preload/index.ts + preloadApi.integration.test.ts; src/renderer/src/store/canvasStore.test.ts (sampled), src/renderer/src/lib/boardSchema.test.ts (full), persistence.integration.test.ts (sampled); docs/testing/TESTING.md (full); the e2e specs e2e/{terminal,processTree}.e2e.ts and the e2e file list. Cross-checked with greps for enumerateShells / __ptyPort / setWindowOpenHandler / partition / launchCommand in *.test.* files.\n\nCHECKED CLEAN (solid coverage, no finding): boardSchema (de)serialize + deep per-type validation + migration v1→v4 + geometry clamps + deep-clone ownership is thorough. projectStore path-traversal (readAsset ../ and assets/../../ rejected), asset ext allowlist, .bak rotation, envelope-guard (PERSIST-1), gcAssets sweep are well-covered. The pure security primitives are all directly unit-tested: navDecision/windowOpenDecision/computeAppOrigin/buildMainWindowWebPreferences (#3/#4/#13/#14); isAllowedPreviewUrl/isAllowedExternal/registerPreviewNavGuards/registerLoadLatch/isErrorResponseCode/isHttpErrorCode (preview scheme allowlist + nav guards + failed-latch); isForeignSender (all 3 modules) + isUnsafeProjectDir (#17/#20, path traversal); killTreeCommand (tree-kill argv both platforms); resolveShell/canonicalizeShellPath/safeCwd (M5 spawn allowlist + cwd hardening); the park/adopt/reap/cleanup/disposeAll cores (T1, identity guards). Foreign-sender rejection is integration-tested per-handler for pty/preview/project (every guarded channel). Process-tree kill (no-orphan) has a robust e2e targeting the exact captured child pid. The preload invoke→channel contract is fully table-tested.\n\nNOTE: The prompt named an 'LLM egress service with safeStorage-backed keys' as in-scope — that subsystem does NOT exist on MAIN (it is on PR #39 feat/context per CLAUDE.md status; grep found safeStorage only in CLAUDE.md and unrelated planning-board paste code). So there is no key-storage test gap to report on this tree; it is simply absent.\n\nBLIND SPOTS: I did not run the suites (read-only audit) so I report structural gaps, not failures. I did not exhaustively read every renderer planning/whiteboard test (out of the security-MAIN scope). The e2e flakiness claims rely on the documented memory note (e2e-browser-trio-flake), not a re-run.

### Dependencies, build & config security `(deps-build)`

Read in full: package.json, electron-builder.yml, electron.vite.config.ts, eslint.config.mjs, tsconfig.json + tsconfig.{node,preload,web}.json, .github/workflows/{pr,staging,production}.yml, src/renderer/index.html, .npmrc. Resolved actual installed/locked versions from pnpm-lock.yaml + node_modules: electron@33.4.11, node-pty@1.2.0-beta.13, electron-updater@6.8.3. Verified the EOL status of Electron 33 against endoflife.date (EOL 2025-04-29; supported majors now 40/41/42) — the top Critical. CHECKED AND FOUND CLEAN: (1) asarUnpack correctly unpacks **/*.node and node_modules/node-pty/** so the native binary + ConPTY helpers ship outside app.asar; (2) no source maps are emitted to prod — `find out -name *.map` is empty and electron.vite.config.ts sets no sourcemap:true; (3) the build-time CSP rewrite WORKS — built out/renderer/index.html carries the PROD policy `script-src 'self'` with no 'unsafe-inline', so inline-script XSS is blocked in packaged builds (style-src 'unsafe-inline' retained, documented and acceptable for React inline-style attrs); (4) electron-updater is present but NOT wired (no autoUpdater/setFeedURL/checkForUpdates in src/, publish:null) so the unsigned-updater MITM risk is latent not active; (5) MAIN window security flags are enforced in src/main/windowSecurity.ts (sandbox/contextIsolation true, nodeIntegration/webviewTag false) and asserted by windowSecurity.test.ts — build config does not override them; (6) CI installs with --frozen-lockfile and runs typecheck+lint+format:check+test+build on every PR/push/release; tsconfig strict+noUnusedLocals/Params+isolatedModules on across all three projects. Blind spots: did not audit the full transitive dependency tree for individual CVEs (no SCA tooling available in-repo and that is itself a finding); did not validate runtime updater behavior since it is unwired; Electron-33 EOL severity is asserted from endoflife.date metadata, not a per-CVE enumeration. e2e/local-matrix CI nuances are out of this dimension's scope.

### Performance & architecture/coupling `(perf-arch)`

Read in full: src/renderer/src/canvas/Canvas.tsx (857 lines), src/renderer/src/canvas/boards/BrowserPreviewLayer.tsx (982), src/renderer/src/lib/motion.ts, src/renderer/src/lib/canvasView.ts, src/renderer/src/lib/tidyLayout.ts, src/renderer/src/lib/alignmentGuides.ts (519), src/renderer/src/canvas/boards/PlanningBoard.tsx (1188), src/main/index.ts (243). Read for cross-checking the hot paths: src/renderer/src/lib/previewPlan.ts, src/renderer/src/lib/cameraBounds.ts, src/renderer/src/canvas/BoardNode.tsx, src/renderer/src/store/canvasStore.ts, src/renderer/src/store/previewStore.ts, src/renderer/src/canvas/AlignmentGuides.tsx.\n\nVerified CLEAN: (1) The rAF camera-sync pump itself (startPump/flushBatch in BrowserPreviewLayer) is correctly coalesced (one setPreviewBoundsBatch IPC per frame), diff-skipped via rectsEqual, and self-stopping after ~4 idle frames — no per-frame IPC chatter when stationary, and the full-view rAF was already fixed (Bug L4) to self-terminate. (2) cameraBounds/worldRectToScreen/roundRect are pure and cheap, no layout thrash per frame. (3) The store's setViewport dedups identical transforms (canvasStore.ts:460) and BoardNode subscribes to the DERIVED isLod boolean not raw zoom (#39) so nodes don't re-render every intra-band zoom frame. (4) motion.ts cubicBezier is computed per-tween, not per-frame, and the easing fn is a module constant. (5) tidyLayout, alignmentGuides, previewPlan are pure/tested and only the alignment path runs per-frame (covered in onnodeschange finding); tidyLayout is O(n log n) and invoked only on explicit Tidy. (6) pickLive's O(n log n) sort and reconcile's live-count were already de-O(n^2)'d (Bug L3/M1 comments confirmed). (7) main/index.ts wiring is clean: handlers registered once, shutdown idempotent, no per-frame main work; not a perf concern. (8) Listener/memory hygiene: paste/keydown/resize/ResizeObserver listeners all have matching removeEventListener/disconnect cleanups; closeAllPreviews on unmount.\n\nBlind spots: did not measure actual frame timings (static analysis only); did not read tileLayout.ts, the planning sub-elements (NoteCard/ChecklistCard/etc.), or preview.ts (main side) — the IPC batch consumer in main could have its own per-frame cost not visible from the renderer. The Medium 'reconcile-on-every-viewport-frame' finding is reasoned from the no-selector subscribe + per-frame setViewport; a runtime profile would confirm the exact frame cost but the redundant allocation is provable from the code.

---

## Appendix — findings index

| # | Sev | ID | Dimension | Location |
|---|---|---|---|---|
| 1 | High | `gcassets-before-validation-data-loss` | persistence | `src/main/projectIpc.ts`:101-110 |
| 2 | High | `corrupt-canvas-json-crashes-load` | silent-failures | `src/renderer/src/store/canvasStore.ts`:513-531 |
| 3 | High | `fromobject-throw-unguarded-open` | type-contracts | `src/renderer/src/store/canvasStore.ts`:513-531 |
| 4 | High | `electron-33-eol-no-security-backports` | deps-build | `package.json`:67 |
| 5 | Medium | `no-permission-handler-preview-views` | electron-security | `src/main/preview.ts`:231-242 |
| 6 | Medium | `packaged-fileurl-nav-allowed` | electron-security | `src/main/windowSecurity.ts`:63-76 |
| 7 | Medium | `deep-validation-throw-no-bak-fallback` | persistence | `src/renderer/src/store/canvasStore.ts`:502-520 |
| 8 | Medium | `no-error-boundary` | renderer-react | `src/renderer/src/main.tsx`:1-7 |
| 9 | Medium | `image-paste-drop-lost-update` | renderer-react | `src/renderer/src/canvas/boards/PlanningBoard.tsx`:234-256 |
| 10 | Medium | `index-quit-shutdown-untested` | tests-coverage | `src/main/index.ts`:164-242 |
| 11 | Medium | `no-dependency-vuln-scanning` | deps-build | `.github/workflows/pr.yml`:26-31 |
| 12 | Medium | `browserpreviewlayer-god-file-982-loc` | perf-arch | `src/renderer/src/canvas/boards/BrowserPreviewLayer.tsx`:135-982 |
| 13 | Low | `prod-csp-style-unsafe-inline` | electron-security | `electron.vite.config.ts`:27-29 |
| 14 | Low | `pty-resize-unbounded` | pty-terminal | `src/main/pty.ts`:503-515, 159-169 |
| 15 | Low | `baseurl-no-scheme-validation-ssrf` | llm-egress | `src/main/llmService.ts`:70-84 |
| 16 | Low | `setconfig-baseurl-not-gated-to-local` | llm-egress | `src/main/llmIpc.ts`:118-137 |
| 17 | Low | `downgrade-newer-schema-crash-plus-asset-gc` | persistence | `src/renderer/src/lib/boardSchema.ts`:246-262 |
| 18 | Low | `bak-rotation-non-atomic-copy` | persistence | `src/main/projectStore.ts`:73-82 |
| 19 | Low | `tolerated-phantom-undo-step` | store-undo | `src/renderer/src/store/canvasStore.ts`:129-148, 466-483 |
| 20 | Low | `bare-1-0-keys-fire-while-well-focused` | renderer-react | `src/renderer/src/canvas/Canvas.tsx`:682-688 |
| 21 | Low | `project-switcher-no-outside-close` | renderer-react | `src/renderer/src/canvas/AppChrome.tsx`:51-144 |
| 22 | Low | `camera-fullview-prior-viewport-overwrite` | renderer-react | `src/renderer/src/canvas/Canvas.tsx`:204-221 |
| 23 | Low | `ctrl-suppress-ref-stuck-on-blur` | renderer-react | `src/renderer/src/canvas/Canvas.tsx`:730-740 |
| 24 | Low | `image-write-failure-silent-drop` | silent-failures | `src/renderer/src/canvas/boards/PlanningBoard.tsx`:238-240 |
| 25 | Low | `export-save-result-ignored` | silent-failures | `src/renderer/src/canvas/boards/PlanningBoard.tsx`:323-336 |
| 26 | Low | `recents-listrecents-empty-on-parse-fail` | silent-failures | `src/main/recentProjects.ts`:26-40 |
| 27 | Low | `project-current-readproject-swallow` | silent-failures | `src/main/projectIpc.ts`:138-149 |
| 28 | Low | `local-baseurl-ssrf-no-validation` | type-contracts | `src/main/llmService.ts`:70-85, 171-189 |
| 29 | Low | `preview-source-self-reference` | type-contracts | `src/renderer/src/lib/boardSchema.ts`:404-406, 437-442 |
| 30 | Low | `provider-union-hand-sync-drift` | type-contracts | `src/preload/index.ts`:72-79 |
| 31 | Low | `ipc-payloads-no-runtime-shape-guard` | type-contracts | `src/main/llmIpc.ts`:81-137 |
| 32 | Low | `preload-msgport-repost-untested` | tests-coverage | `src/preload/index.ts`:171-188 |
| 33 | Low | `enumerate-shells-untested` | tests-coverage | `src/main/pty.ts`:237-352 |
| 34 | Low | `preview-happy-path-wiring-untested` | tests-coverage | `src/main/preview.ts`:227-336 |
| 35 | Low | `pty-spawn-options-untested` | tests-coverage | `src/main/pty.ts`:415-528 |
| 36 | Low | `foreign-sender-guard-triplicated` | tests-coverage | `src/main/pty.ts`:387-399 |
| 37 | Low | `port-message-handler-throw-untested-spawn` | tests-coverage | `src/main/pty.ts`:503-515 |
| 38 | Low | `node-pty-pinned-beta` | deps-build | `package.json`:49 |
| 39 | Low | `electron-updater-unsigned-latent` | deps-build | `package.json`:48 |
| 40 | Low | `skiplibcheck-everywhere` | deps-build | `tsconfig.preload.json`:12 |
| 41 | Low | `no-security-eslint-rules` | deps-build | `eslint.config.mjs`:93-103 |
| 42 | Low | `previewlayer-reconcile-on-every-viewport-frame` | perf-arch | `src/renderer/src/canvas/boards/BrowserPreviewLayer.tsx`:878-891 |
| 43 | Low | `onnodeschange-perframe-snap-allocation` | perf-arch | `src/renderer/src/canvas/Canvas.tsx`:269-371 |
| 44 | Low | `nodes-memo-data-object-churn` | perf-arch | `src/renderer/src/canvas/Canvas.tsx`:227-245 |
| 45 | Low | `planningboard-god-file-1188-loc` | perf-arch | `src/renderer/src/canvas/boards/PlanningBoard.tsx`:112-1188 |
| 46 | Low | `canvas-god-file-857-loc-state-sprawl` | perf-arch | `src/renderer/src/canvas/Canvas.tsx`:102-842 |
| 47 | Info | `implicit-secure-defaults-not-pinned` | electron-security | `src/main/windowSecurity.ts`:16-30 |
| 48 | Info | `pty-launchcommand-trusted-autoexec` | pty-terminal | `src/main/pty.ts`:521-525 |
| 49 | Info | `provider-error-message-leaks-response-body-to-renderer` | llm-egress | `src/main/llmService.ts`:183 |
| 50 | Info | `navigate-blocked-scheme-no-bounds-resync` | preview-lifecycle | `src/main/preview.ts`:518-537 |
| 51 | Info | `project-current-skips-unsafe-dir-guard` | persistence | `src/main/projectIpc.ts`:167-187 |
| 52 | Info | `fresh-doc-stale-schemaversion` | persistence | `src/main/projectStore.ts`:84-101 |
| 53 | Info | `module-lastrecorded-shared-singleton` | store-undo | `src/renderer/src/store/canvasStore.ts`:129, 185 |
| 54 | Info | `measured-ref-not-pruned` | renderer-react | `src/renderer/src/canvas/boards/PlanningBoard.tsx`:203-206 |
| 55 | Info | `iconbtn-dead-longpress-timer` | renderer-react | `src/renderer/src/canvas/BoardFrame.tsx`:68-83 |
| 56 | Info | `before-quit-flush-no-catch` | silent-failures | `src/main/index.ts`:217-224 |
| 57 | Info | `detect-ports-error-not-propagated` | silent-failures | `src/renderer/src/canvas/boards/TerminalBoard.tsx`:561-576 |
| 58 | Info | `fittoboards-repeated-minmax-spread` | perf-arch | `src/renderer/src/canvas/Canvas.tsx`:413-416 |

_Generated from a 78-agent verified audit workflow (run `wf_7c5d5297-df6`). Report-only; no files in `main` were changed._
