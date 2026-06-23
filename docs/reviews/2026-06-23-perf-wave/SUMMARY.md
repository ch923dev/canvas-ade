# Performance wave — 2026-06-23 (collapsed)

**Shipped:** PR #219 (squash `64c04f3b`; build-history `b0e0beeb`). **Status: COMPLETE — no open
backlog.** This is the dated residue of the measurement-grounded `perf-slices/` package (formerly at
the repo root). The raw artifacts — the 12 other per-slice cards, `FIX-REPORT.md` (Wave-1 report),
`SLICES.md` (the live wave queue/status table), `skipped-roadmap.md` (roadmap reconciliation), and
`unconfirmed.md` (killed candidates) — are collapsed to **git history**. To recover them:
`git log --all --oneline -- perf-slices/` then check out that path at the commit shown.

## Method

Codebase-wide, measurement-grounded perf review: 8 parallel file-zone discovery agents → one
adversarial verifier per candidate (re-derive complexity / re-measure bytes / re-count allocs /
micro-bench) → roadmap reconciliation → slicing. **43 candidates → 15 confirmed → 13 slices** (3
findings shared a root cause); 27 killed as not-material. The obvious wins were already shipped (the
PA umbrella + the Planning epic), so the queue was "deep cuts": the File Tree / File Board / Command
Board white space + the OSR frame pipeline's MAIN-side cost.

## Outcome — 12 shipped, 1 closed

| Slice | Area | What shipped | Result |
|---|---|---|---|
| 001 | bundle | drop ~100 unreachable CodeMirror grammars from the FileBoard chunk | 708 → 486 KB gzip (−31%) |
| 003 | render | CommandBoard derived-fingerprint subscription | ~60 per-drag-frame re-renders/s → 0 |
| 004 | hot loop | Planning per-drag static snap cache | per-pointermove rebuild eliminated |
| 005 | OSR payload | crop frames to the dirty-rect at supersample>1 (device-px dirtyRect) | small paints 16.4 MB → ≈KB/frame |
| 006 | OSR hot loop | BGRA→RGBA swizzle off the main thread (round-trip worker) | ~0.58 core reclaimed @4 boards |
| 007 | hot loop | memoize the OsrNetworkPanel filter/sort pipeline + decorate-sort `urlName` | ~13 → <2 ms/render |
| 008 | blocking | time-slice the snapshot Lezer highlight off the open-time critical path | 64–197 ms sync → <16 ms; byte-identical |
| 009 | hot loop | defer FileBoard markdown reparse (`useDeferredValue`) | per-keystroke reparse → on idle |
| 010 | scalability | virtualize the OsrNetworkPanel request table (table-preserving spacer-row windowing; **no `react-window` dep**) | ~10,000 elements/delta → ~30 `<tr>` |
| 011 | O(N²) | incremental pen-draft tessellation | ~135 ms over an 800-pt stroke → O(N)/frame |
| 012 | memory | cap xterm default scrollback 5000 → 2000 | bounded terminal memory |
| 013 | cold-start | lazy-load the FileTree side panel into an on-demand chunk | ~50 KB gzip off the entry |
| **002** | I/O / IPC | **OSR transferable ArrayBuffer for frame IPC** | **CLOSED — not achievable** (see [`SLICE-002.md`](SLICE-002.md)) |

**SLICE-002** was the only confirmed finding that could not be shipped: zero-copy is impossible across
the main→renderer **process** boundary (every Electron 42 transfer list is
`MessagePort[]`/`MessagePortMain[]`, never `ArrayBuffer`), so a `MessageChannelMain` rewrite would
still structured-clone the buffer while adding a security-sensitive preload port surface for zero
gain. SLICE-005 already shrank the copy to KB for the common case; the only true zero-copy path is
shared-texture OSR (a WebGL/GPU pipeline rewrite, out of scope). Full analysis preserved verbatim in
[`SLICE-002.md`](SLICE-002.md).

## Verification

Gate green (typecheck · lint 0-err · format · unit **3282**, +8 new `computeRowWindow` tests); **full
e2e matrix BOTH legs ×2** (pre-PR and post-#220-rebase: Windows **180** / Linux Docker **180**). CI
check/CodeQL/analyze/claude-review all pass. Reviewer's one real `[warning]` (SLICE-010 blank-table on
panel reopen) fixed (`bd78c46c`) with a reopen regression test; two CodeQL alerts dispositioned as
dedicated-worker / test-only false-positives. Security invariants untouched
(contextIsolation/sandbox/thin preload; `PROD_CSP script-src 'self'` unchanged — the 006 worker and
the 008 slice scheduler are CSP-safe). Per-PR detail: `docs/archive/build-history.md` › 2026-06-23.
