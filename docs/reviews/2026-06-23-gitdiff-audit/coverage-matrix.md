# gitdiff — coverage matrix (behavior × implemented / tested / wired / passing)

Legend: ✅ yes · ⚠️ partial / approximate · ❌ no · n/a not applicable.
"Tested" = an automated test asserts it. "Wired" = reachable on a real end-to-end path.
Gap IDs (GAP-00x) link to `punch-list/`.

| # | Behavior | Impl | Tested | Wired | Passing | Notes / Gap |
|---|----------|:----:|:------:|:-----:|:-------:|-------------|
| I1 | no cwd → `''` | ✅ | ✅ unit | ✅ | ✅ | `gitDiff.ts:19-20`; `gitDiff.test.ts:17` |
| I2 | non-repo cwd → `''` | ✅ | ✅ unit | ✅ | ✅ | `gitDiff.ts:22`; `gitDiff.test.ts:22` |
| I3 | `git diff HEAD` raw | ✅ | ✅ unit+e2e | ✅ | ✅ | `gitDiff.ts:26`; `e2e:88-94` (real repo) |
| I4 | no-commits fallback `git diff` | ✅ | ⚠️ mock-only | ✅ | ✅ | `gitDiff.ts:32-33`; `gitDiff.test.ts:35` (mock). Never exercised vs real git → **GAP-005** |
| I5 | re-throw non-HEAD error | ✅ | ✅ unit | ⚠️ | ✅ | `gitDiff.ts:31-35`; `gitDiff.test.ts:44`. Renderer swallows it anyway (A4) — effect only on MCP/e2e consumers |
| I6 | board-not-found → throw | ✅ | ✅ unit+e2e | ✅ | ✅ | `mcpOrchestrator.ts:936`; `e2e:108` |
| I7 | non-terminal → throw | ✅ | ✅ unit+e2e | ✅ | ✅ | `mcpOrchestrator.ts:937-939`; `e2e:97` |
| I8 | registry not wired → throw | ✅ | ✅ unit | ✅ | ✅ | `mcpOrchestrator.ts:940`; `mcpOrchestrator.test.ts:277` |
| I9 | 100 KB byte-clamp, char-safe | ✅ | ✅ unit | ✅ | ✅ | `mcpOrchestrator.ts:946-950`; `.test.ts:282,288` (ascii+CJK) |
| I10 | simple-git MAIN-only | ✅ | ✅ (arch) | ✅ | ✅ | `gitDiff.ts` MAIN module; renderer has no import |
| I11 | read-only (no mutation) | ✅ | ✅ (arch) | ✅ | ✅ | only `checkIsRepo`/`diff`; no write call exists |
| I12 | `mcp:gitDiff` frame-guarded | ✅ | ✅ integ | ✅ | ✅ | `mcpOrchestratorIpc.ts:116-121,53-58`; `integration.test.ts:180` |
| I13 | renderer holds no token | ✅ | ✅ (arch) | ✅ | ✅ | IPC drive only; `mcpOrchestratorIpc.ts` header |
| I14 | full renderer→simple-git chain | ✅ | ✅ e2e+integ | ✅ | ✅ | seam e2e proves the live diff returns |
| I15 | output consumed (chip/view/recap) | ✅ | ⚠️ unit-only | ✅ | ✅ | `TaskCard.tsx:80-249`, `CommandRecapView.tsx:127`, `GroupsView.tsx:106`. No e2e/RTL asserts the rendered chip → **GAP-005** |
| I16 | `git_diff` MCP tool → orchestrator | ✅ pkg | ❌ | ⚠️ | ✅* | pkg `@expanse-ade/mcp@0.13.0` registers it (`dist/index.js:612`); app comments say "not wired yet" (STALE) → **GAP-004**. No app-side test over the wire |
| I17 | CANVAS_E2E seam | ✅ | ✅ e2e | ✅ | ✅ | `e2eMain.ts:140,397`; `mcp.ts:107,207` |
| I18 | empty/nullish → EMPTY_DIFFSTAT | ✅ | ✅ unit | ✅ | ✅ | `diffStat.ts:20`; `diffStat.test.ts:23` |
| I19 | count +/- excl. +++/---, files | ⚠️ | ✅ unit | ✅ | ✅ | `diffStat.ts:24-36`; **under-counts content lines whose body starts with `--`/`++`** → **GAP-003** (demonstrated) |
| I20 | hasDiff gates chip | ✅ | ✅ unit | ✅ | ✅ | `diffStat.ts:40-42`; `diffStat.test.ts:44` |
| I21 | modified file shown+counted | ✅ | ✅ e2e | ✅ | ✅ | `e2e:90-92` |
| I22 | added file (`-N`) shown | ✅ | ✅ e2e | ✅ | ✅ | `e2e:93-94` (`new file mode`) |
| I23 | untracked (never-added) file | ❌ | ❌ | ✅ | ⚠️ | **invisible in `git diff HEAD`** (demonstrated). Unstaged rename shows only the delete half → **GAP-001** |
| I24 | deleted file shown+counted | ✅ | ❌ | ✅ | ✅ | git renders `deleted file mode` + `-`lines (demonstrated); no test → **GAP-005** |
| I25 | renamed file | ⚠️ | ❌ | ✅ | ⚠️ | `git mv` → rename header; rm+create → delete + (untracked) add invisible → ties to **GAP-001/005** |
| I26 | binary file | ⚠️ | ❌ | ✅ | ✅ | `Binary files … differ` → chip "+0 −0", 1 file (demonstrated); no test → **GAP-005** |
| I27 | clean repo → '' → chip hidden | ✅ | ⚠️ mock-only | ✅ | ✅ | covered by I1/I2 mocks only; no real-repo clean test → **GAP-005** |
| I28 | large diff > 100 KB clamped | ✅ | ✅ unit | ✅ | ✅ | clamp tested; not tested that clamped output stays parseable (minor) |
| I29 | determinism | ✅ | ✅ (pure) | ✅ | ✅ | git deterministic; `parseDiffStat` pure |
| I30 | bounded MAIN memory on huge tree | ❌ | ❌ | ✅ | ⚠️ | simple-git streams+buffers **entire** diff before the clamp (demonstrated: `spawn`, no maxBuffer). Clamp is downstream-only → **GAP-002**. Also no timeout/abort → **GAP-007** |

## Roll-up
- **Implemented:** 26/30 ✅, 4 ⚠️/❌ (I19 approx, I23 missing, I25 partial, I26 approx, I30 missing).
- **Tested (automated):** 18/30 ✅; real-git behavioral cases (I24/I26/I27) + the no-HEAD
  fallback (I4) + rendered consumption (I15) + the MCP tool (I16) are untested → **GAP-005/004**.
- **Wired:** the renderer + seam paths are fully live and proven (e2e green); the agent-facing
  MCP tool is registered in the pinned package but the app's comments deny it → **GAP-004**.
- **Passing:** every existing test (120 unit/integration relevant + 99 orchestrator + 3 e2e) is
  green — see `diagnoses/DIAG-001.md`.
