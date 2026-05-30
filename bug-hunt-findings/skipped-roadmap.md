# Confirmed Bugs Skipped — Already On The Roadmap

Each was confirmed by the hunt but a later roadmap phase will fix it. `docs/roadmap.md` has been annotated in place for each (greppable `🐛 Bug-hunt finding` block).

| Location | Severity | Title | Roadmap phase that covers it |
|----------|----------|-------|------------------------------|
| `src/renderer/src/canvas/AppChrome.tsx` | Low | Fit (button + '1' key) snaps the camera instantly with no animation, violating the DESIGN.md §9 contract that fit animate 200ms (and inconsistent with the animated Overview/Focus siblings) | Phase 4 — Design pass & polish |

## Partial-coverage cross-references (kept in the active package, roadmap lightly annotated)

| Card | Location | Roadmap item it relates to |
|------|----------|----------------------------|
| BUG-025 | `src/renderer/src/lib/boardSchema.ts` | Phase 3: Project create / open — canvas.json load + migrations + full-reopen-fidelity test |
| BUG-027 | `src/renderer/src/lib/boardSchema.ts` | Phase 3: Project create / open — canvas.json load + migrations + full-reopen-fidelity test |
