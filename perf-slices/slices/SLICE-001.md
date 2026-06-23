# SLICE-001 — FileBoard: drop unreachable CodeMirror grammars

- **Dimension:** client render / bundle / payload size (lazy chunk) · **Severity:** med · **Effort:** M
- **Root cause of:** `cs-fileboard-codemirror-all-langs-chunk`, `ft-langs-barrel-all-grammars`,
  `fb-codemirror-all-langs-eager` (three confirmed findings, one root cause)
- **Where:** `src/renderer/src/canvas/boards/fileBoardSyntax.ts:13` (`import { loadLanguage } from
  '@uiw/codemirror-extensions-langs'`) + `:309` (`loadLanguage(name)`); reachability map
  `LANG_BY_EXT` at `:64-100`. Lazy boundary: `BoardNode.tsx:54`.

## Baseline (measured, reproduced)

- `out/renderer/assets/FileBoard-DrRL34Zb.js` = **2,602,396 B raw / ~708 KB gzip / ~529 KB brotli**
  (`stat -c%s`; `gzip -9`; `brotli -q11`). The **single largest renderer chunk** — 1.91× the main
  index chunk (1,361,679 B) and ~52% of all renderer JS (4,958,635 B total).
- Cause: `@uiw/codemirror-extensions-langs` is a generated barrel that **statically** imports 103
  grammar modules (20 `@codemirror/lang-*` + 83 `@codemirror/legacy-modes`, 228 `langs` entries).
  `loadLanguage(name)` indexes `langs[name]()` at **runtime**, so the bundler cannot tree-shake any
  grammar. `LANG_BY_EXT` reaches **only ~17–25 distinct grammars**, all modern `lang-*` packs — **not
  one entry uses `StreamLanguage`**, so the entire `@codemirror/legacy-modes` pack (1,957,828 B
  unpacked) is **unreachable dead weight**.
- Confirmed present-but-unreachable in the built chunk (grep): brainfuck, cobol, fortran, verilog,
  vhdl, smalltalk, tcl, scheme, erlang, julia, puppet, haskell, apl, clojure, … (81/81 sampled
  legacy modes + 6 unmapped modern grammars: nix, svelte, solidity, jinja, liquid, wast).
- Note: V8 compile of the 2.6 MB chunk is only ~3–4 ms (grammar tables sit in lazy factory
  closures), so **the cost is payload bytes + retained memory, not CPU** — this is a transfer/parse
  weight slice, scoped to first File-board open.

## Target

Ship only grammars reachable from `LANG_BY_EXT`. Replace the barrel with explicit per-language
imports (or a dynamic `import()` map keyed by language id, loaded on demand). **Target: FileBoard
chunk ≤ ~150–200 KB gzip** (drop the ~1.96 MB-raw legacy-modes pack entirely + unmapped modern
grammars). Express success in gzip, not raw (build is unminified — see SLICES.md caveat).

## Validation

1. `pnpm build`; `gzip -c out/renderer/assets/FileBoard-*.js | wc -c` ≤ ~200,000.
2. `grep -c 'StreamLanguage' out/renderer/assets/FileBoard-*.js` ≈ 0 (legacy pack gone).
3. Open files of every mapped extension (ts, js, py, rust, go, java, cpp, css, html, xml, php, sql,
   md, yaml, sass, less, vue) — syntax highlighting **identical** to before.
4. Open an unmapped extension (e.g. `.cob`) — still degrades to plaintext exactly as today.

## Invariant (must stay identical)

Every extension currently in `LANG_BY_EXT` highlights identically; unmapped files fall back to
plaintext; markdown code-fence highlighting (shared path via `fileBoardMarkdown.ts`) still works.

## Files touched

- `src/renderer/src/canvas/boards/fileBoardSyntax.ts` (replace barrel import + `loadLanguage`).
- Possibly `src/renderer/src/canvas/boards/fileBoardMarkdown.ts` if it also calls `loadLanguage`.

## Collisions

- **`fileBoardSyntax.ts` shared with SLICE-008** → sequence: land 001 first, 008 rebases.
