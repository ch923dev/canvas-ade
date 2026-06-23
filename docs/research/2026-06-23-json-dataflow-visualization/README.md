# 2026-06-23 — JSON responses & full data-flow visualization (Browser board)

Design research + proposal + mocks for replacing the Network inspector's flat-`<pre>` JSON dump with
an optimized JSON tree viewer, and for a new **Data Flow** view that visualizes the full API surface a
developer is building.

**Start here → [`REPORT.md`](./REPORT.md)** (proposal, mocks, feasibility/decisions, roadmap).
**Build plan → [`EPIC.md`](./EPIC.md)** (the JD umbrella: 4 file-zone-partitioned slices, ship order, decision gates).

## Contents

- [`REPORT.md`](./REPORT.md) — the full report (§1 problem → §7 open decisions → mocks → §8–§9 feasibility & decisions → research appendix).
- [`EPIC.md`](./EPIC.md) — **JD umbrella build plan**: JD-1 (viewer fix) · JD-2 (enrichments) · JD-3 (inventory+schema) · JD-4 (graph+canvas/agent), with the file-zone collision map.
- [`JD-1-SPEC.md`](./JD-1-SPEC.md) — **locked** implementation spec for JD-1 (the viewer fix): `lib/osrJson.ts` API, `JsonView.tsx`, the two call-site swaps, CSS, tests, acceptance.
- `mock-a-json-viewer.html` / `.png` — the optimized JSON viewer (the P0 fix).
- `mock-b-data-flow.html` / `.png` — the Data Flow view (inventory · schema · graph).
- `mock-c-canvas.html` / `.png` — Data Flow promoted onto the canvas (Planning / agent context).
- `mock-d-syntax-palettes.html` / `.png` — A/B/C JSON syntax-palette comparison (for the §7.1 decision).
- `mock-e-data-flow-flat.html` / `.png` — the **flat / no-relationships** case: how Data Flow degrades when responses share no identifiers (inventory + schemas only, **zero fabricated edges**).
- [`_research/`](./_research/) — raw 14-agent workflow outputs (synthesis, reviews, appendices).

## Status

**Awaiting sign-off** — no implementation code yet. Three decisions are open (REPORT §7/§9): the syntax
palette (recommend **Option A**, accent-on-keys), the Data Flow surface (recommend **panel tab → React
Flow board**), and the scope of P0 (recommend tree + folding + Option A + Raw toggle +
truncation-tolerance, **no** virtualization/search until P1).

The mocks are token-faithful (built from `tokens.css`/`browser-devtools.css`) and were de-rainbowed to
Option A before screenshotting — see REPORT §8.4/§8.6.
