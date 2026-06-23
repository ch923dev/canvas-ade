# SLICE-009 — FileBoard: debounce markdown re-parse

- **Dimension:** algorithmic complexity / hot loops; caching gaps · **Severity:** med · **Effort:** S
- **Finding:** `ft-markdown-split-reparse-per-keystroke`
- **Where:** `src/renderer/src/canvas/boards/FileBoard.tsx:262-265` (`markdownHtml = useMemo(...,
  [showMarkdown, text])`) → `fileBoardMarkdown.ts:215` (`renderMarkdownToHtml`); the live editor's
  `onChange={setText}` at `FileBoard.tsx:604`.

## Baseline (measured, reproduced)

- In Split/Preview mode, `text` is a dep of the `markdownHtml` useMemo, so `renderMarkdownToHtml(text)`
  re-runs **every keystroke** (no debounce): `md.parse(source)` over the whole doc + recursive walk +
  per-fence highlight.
- Micro-bench with the real bundled deps on a realistic 9.5 KB code-fence-heavy README:
  `renderMarkdownToHtml` = **~1.80 ms/call**; the parallel `snapshotHtml` useMemo
  (`FileBoard.tsx:259`) also re-runs on the markdown parser per keystroke = **~0.72 ms** → **~2.5 ms
  synchronous main-thread per keystroke**, scaling to ~4.3 ms `md.parse` at ~38 KB. (Per-fence
  `resolveLanguage`/`loadLanguage` is negligible — ~1.2 µs each — correcting the original
  over-claim.)

## Target

Debounce the markdown render (and the parallel snapshot recompute in markdown mode) to ~150–250 ms of
typing idle; keep the editor's own input fully responsive (it has its own state). **Target: keystroke
handler <1 ms; the ~2.5 ms parse runs once per idle, not per keystroke.**

## Validation

1. Type a burst into a 9.5 KB markdown file in Split mode; the `renderMarkdownToHtml` /
   `buildSnapshotHtml` calls fire once after idle, not per keystroke (counter/Profiler).
2. After idle, the preview matches the source exactly.

## Invariant (must stay identical)

Preview eventually (post-debounce) matches the source byte-for-byte; no lost final keystroke; editor
typing latency unchanged.

## Files touched

- `src/renderer/src/canvas/boards/FileBoard.tsx` (`markdownHtml` + `snapshotHtml` memos → debounced
  value).

## Collisions

- **`FileBoard.tsx` shared with SLICE-008** → Wave 3, after 008.
