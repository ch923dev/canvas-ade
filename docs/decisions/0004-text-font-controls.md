# ADR 0004 — Text font controls (narrow reversal of "Tweaks panel cut")

**Status:** Accepted · **Date:** 2026-06-07 · **Supersedes (narrowly):** the "Tweaks panel cut entirely"
line in CLAUDE.md › Locked decisions, and the ADR 0001 AVOID entry "Font/size/align props panel · Excalifont".

## Context
The Planning board's free-`text` element had a single fixed font/size/color. Developers asked for basic
typography. The locked design cut the Tweaks panel and forbade a font/size/align props panel to protect the
calm, single-accent Linear/Raycast aesthetic.

## Decision
Add a **floating, contextual** font toolbar for the **`text` element only**: family (sans·mono·serif), size
(S/M/L/XL presets), alignment (L/C/R), bold, and color drawn from the **neutral text ramp + the single
accent** — no multi-hue palette. Values are closed tokens (schema v6), not free-form CSS.

## What stays cut
A general/persistent properties panel; per-element opacity; arbitrary/handwriting fonts; per-span rich text;
multi-hue color; note/checklist typography. The single blue accent remains the only color.

## Consequences
- Schema bumps to **v6**; this slice owns it. The Mermaid diagram element takes **v7**; the draw.io-D2,
  file-editor, and PR #72 Diagram docs rebase their bump numbers off v6.
- Tokenized + closed, so the feature cannot grow into the full Tweaks panel without another ADR.
- Reversible: the fields are optional; dropping the toolbar leaves data that still validates.
