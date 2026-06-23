# SLICE-008 — FileBoard: snapshot highlight off the main thread

- **Dimension:** algorithmic complexity / hot loops; concurrency (blocking) · **Severity:** med ·
  **Effort:** L
- **Finding:** `ft-snapshot-sync-lezer-parse`
- **Where:** `src/renderer/src/canvas/boards/fileBoardSyntax.ts:338-355` (`buildSnapshotHtml`:
  `parser.parse(code)` + per-token string append), invoked from `FileBoard.tsx:259`
  (`snapshotHtml = useMemo(..., [text, parser])`).

## Baseline (measured, reproduced)

- For VIEW mode, `buildSnapshotHtml` runs **synchronously** in a `useMemo`: a full Lezer
  `parser.parse(code)` of the whole file, then a walk appending every highlight token to one growing
  string. One-shot per file open (not per frame), but an **unbroken main-thread block**:
  - Real production TS tiled to the `HIGHLIGHT_MAX_CHARS=200,000` cap (28,705 tokens): **~64 ms
    median** full `buildSnapshotHtml` (parse ~57 ms + concat).
  - Synthetic token-dense TS @200 KB (76,645 tokens): **~197 ms median** (max 224 ms).
  - Typical 30 KB file: ~7 ms. >cap escape-only fallback: ~0.4 ms (cheap).
- (The original candidate cited only the ~5.5 ms concat half; the Lezer **parse dominates** — true
  block is 10×–35× that.)

## Target

Move the parse + highlight off the main thread (a worker — the `diagramWorker.ts` hidden-window
precedent or a web worker), or chunk/yield the token walk so no single task exceeds a frame. **Target:
no main-thread long-task >16 ms on file open at the 200 KB cap.** Acceptable interim: render plaintext
immediately, then swap in highlighted HTML when the async pass resolves.

## Validation

1. Open a 200 KB source file; Performance trace shows no >16 ms long-task on the open (parse moved
   off-thread or chunked).
2. Highlighted output is identical to the current synchronous result for files ≤ cap.
3. `@core`/file-board e2e green.

## Invariant (must stay identical)

Highlighted HTML identical for files ≤ `HIGHLIGHT_MAX_CHARS`; >cap plaintext fallback unchanged; no
flash of wrong content that persists.

## Files touched

- `src/renderer/src/canvas/boards/fileBoardSyntax.ts` (`buildSnapshotHtml` → async/worker/chunked).
- `src/renderer/src/canvas/boards/FileBoard.tsx` (`snapshotHtml` consumption becomes async).

## Collisions

- **`fileBoardSyntax.ts` shared with SLICE-001** (land 001 first) and **`FileBoard.tsx` shared with
  SLICE-009** → Wave 2 (after 001), then 009 in Wave 3.
