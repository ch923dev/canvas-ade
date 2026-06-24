# Planning-MCP — checklist label wrap (read the whole line, no clicking)

> 2c follow-up, surfaced by the live eyeball: a long checklist item label **truncated** mid-word; you
> had to click into the item and arrow through the text to read it. 2c's card-widen (240→300) only
> *delayed* the clip — the item label was a single-line `<input>`, which can never wrap. The fix is to
> make the label **wrap to multiple lines** so it reads in full at a glance.

## Change

**`ChecklistCard.tsx` — item label `<input>` → auto-growing `<textarea>`** (this is the
`planning-cross-board-transfer` lane's `boards/planning/*` zone — edited here per the user's call,
with a cross-zone notice on `ACTIVE-WORK.md`; that lane has not touched this file → low conflict risk).
- `rows={1}` base; height set to `scrollHeight` on every relevant change (the same `height:auto →
  scrollHeight` pattern NoteCard uses), so the row grows as the label wraps. A `useLayoutEffect` keyed
  on `[element.items, element.w]` re-sizes every row on edit / add / remove / undo / paste / **card
  resize** (a width change re-wraps); `onChange` also sizes the edited row directly for instant
  feedback. The card's existing `ResizeObserver` then grows the board to fit.
- **Enter still ADDS an item** (never inserts a literal newline) — long labels read across lines via
  soft **wrap**, so a hard newline is never wanted. Backspace-on-empty (remove / blur), draw-gesture
  passthrough, done strikethrough, focus-after-add/remove — all preserved.
- The item row switches `align-items: center → flex-start` so the checkbox sits on the **first** line
  of a multi-line label instead of floating to the vertical middle. `resize:none` + `overflow:hidden`
  (auto-grown, no scrollbar) + `overflow-wrap:break-word` (a long unbroken token can't overflow-x).
- Benefits **all** checklists (user-created + agent-written), not just MCP ones.

**`planningMcpApply.ts` — make the checklist height estimate wrap-aware.** 2c's estimate
(`CHECK_HEAD + count × CHECK_ROW + CHECK_FOOT`) assumed single-line rows. With wrapping, a long agent
label is several lines tall, so the count-based estimate would **undershoot** and re-introduce the
overlap 2c fixed (a sibling card stacked below would land on the wrapped checklist). Now
`estimateChecklistHeight(items, width)` sums each label's **wrapped line count**
(`ceil(label.length / charsPerLine)`, `charsPerLine` from `width − CHECK_ROW_INSET`) × `CHECK_ROW`. It
reduces to the old `count × CHECK_ROW` when every label fits one line, and stays ≥ the real render when
they wrap. Callers in `opCell` (MCP_CHECKLIST_W) and `elementLayoutBox` (the element's own `w`) pass
the items + width.

Renderer-only — no `@expanse-ade/mcp` bump, no `schemaVersion` bump (the stored `ChecklistItem.label`
is unchanged; this is render + layout-estimate only).

## Tests
- `planningMcpApply.test.ts`: a wrapping label reserves MORE vertical space than a short one (the
  estimate counts wrapped lines) — guards the overlap invariant against the wrap regression.
- `mcpPlanning.e2e.ts`: an agent checklist with a deliberately long label renders its textarea **> one
  line** tall (real wrap, end-to-end) and the columns stay non-overlapping; screenshot evidence.
- Existing single-line behaviour (focus, add/remove, the 2c overlap-invariant test) all unchanged.

## Out of scope
- **2b** — agent board title (next, last umbrella phase).
