# File-size doctrine

A `max-lines` ESLint rule (`eslint.config.mjs`) caps new source files at **700 code-lines** (blanks
and comments are skipped — dense documentation is never penalised) and freezes today's code-heavy
files at pinned counts. The five rules that keep files maintainable:

1. **Ratchet.** Pins move DOWN only. Lower a file's pin in the same PR that shrinks it; delete the
   entry once the file drops under 700 (the global cap then guards it).
2. **Extract-on-touch.** A NEW concern goes in a new `use*.ts` / `lib/*.ts`, never inline into a file
   already near its pin. Reference shape: `src/renderer/src/canvas/hooks/useTidyTile.ts`.
3. **Test the real extracted symbol, not a replica.** Import the moved function in its test.
4. **Security invariants never scatter.** Keep a whole gate in one file — the
   sanitize→confirm→nonce→audit→write chain in `mcpOrchestrator.ts`; the `isForeignSender` perimeter,
   kill-tree, and identity-guarded cleanup in `pty.ts`. Extract *around* them, never through them.
5. **Close the test gap before a risky extract.** Add the unit test first, then refactor under it.

**Layers (the established idiom):** pure logic → `lib/*.ts` (or `main/*.ts`); renderer sub-hooks →
`canvas/hooks/use*.ts` or `boards/<type>/use*.ts`; MAIN pure cores → `xCore(args, deps)` + a thin
wrapper.

**Current pins (measured 2026-06-09, code-lines):** `TerminalBoard.tsx` 1025 · `Canvas.tsx` 925 ·
`PlanningBoard.tsx` 850. (`mcpSmoke.ts` was pinned at 1000 until its retirement — the
`CANVAS_SMOKE=mcp` harness was ported to `e2e/mcp.e2e.ts` and deleted; dx-audit PR-5.) Every other
file is under the 700 global cap — including
the comment-dense `pty.ts` (524), `usePreviewManager.ts` (597), `canvasStore.ts` (612), and
`mcpOrchestrator.ts` (673), which are large by total lines but well under the cap by code.

Full backlog, per-file seams, and the ~21 security invariants a split must preserve:
`docs/research/2026-06-09-god-file-maintainability.md`.
