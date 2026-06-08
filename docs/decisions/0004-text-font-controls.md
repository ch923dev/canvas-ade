# ADR 0004 — Text font controls (narrow reversal of "Tweaks panel cut")

**Status:** Accepted · **Date:** 2026-06-07 · **Supersedes (narrowly):** the "Tweaks panel cut entirely"
line in CLAUDE.md › Locked decisions, and the whiteboard-epic AVOID entry "Font/size/align props panel ·
Excalifont" (`docs/archive/2026-06-03-whiteboard-epic.md`).

## Context
The Planning board's free-`text` element had a single fixed font/size/color. Developers asked for basic
typography. The locked design cut the Tweaks panel and forbade a font/size/align props panel to protect the
calm, single-accent Linear/Raycast aesthetic.

## Decision
Add a **floating, contextual** font toolbar for the **`text` element only**: family (sans·mono·serif), size
(S/M/L/XL presets), alignment (L/C/R), bold, and color drawn from the **neutral text ramp + the single
accent** — no multi-hue palette. Values are closed tokens (schema v7), not free-form CSS.

## What stays cut
A general/persistent properties panel; per-element opacity; arbitrary/handwriting fonts; per-span rich text;
multi-hue color; note/checklist typography. The single blue accent remains the only color.

## Consequences
- Schema bumps to **v7**; this slice owns it. (Originally drafted as v6, but Named Board Groups (#84)
  landed v6 = `groups` on `main` first, so this slice rebased v6 → v7 at merge — exactly the
  first-to-land-takes-the-number rule below.) The text create+edit UX follow-up took **v8**
  (see § Follow-up: area-text UX + schema v8 below); the Mermaid diagram element now takes
  **v9**; PR #72 Diagram docs rebase their bump numbers off v8.
- Tokenized + closed, so the feature cannot grow into the full Tweaks panel without another ADR.
- Reversible: the fields are optional; dropping the toolbar leaves data that still validates.

## Follow-up: area-text UX + schema v8

**Date:** 2026-06-08 · **Branch:** `feat/text-create-edit-ux`

### Schema v8 — `TextElement.width`
The area-text wrap-box width is stored as an optional `width: number` on `TextElement` (board px).
Absent ⇒ point text (auto-size); all-optional → identity bump (no backfill). The v7→v8 migration
is a pass-through. **v8 is owned by this follow-up slice; the Diagram / visual-spec work (PR #72)
rebases to v9** (first-to-land-takes-the-number rule, same as v6→v7 above).

### Drag-to-create area text
The Text tool's well-drag produces an area-text box: **drag width → wrap-box width**; **drag height
→ font-size token** (S/M/L/XL via `tokenFromHeight`). A click (no drag) makes point text at the
default size. Gives users a spatial "I want text about this big" gesture that maps onto the closed
token system — no free-form size entry.

### Toolbar-on-edit
The typography toolbar now surfaces while a text element is **focused / being edited**
(`editingTextId` ephemeral state) in addition to when it is grip-selected. A keep-focus guard
(`onMouseDown preventDefault` on the toolbar) prevents the empty-text prune from firing when the
user clicks a toolbar button immediately after creating a fresh text element.
