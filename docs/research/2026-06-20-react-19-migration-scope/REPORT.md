# React 18 → 19 migration scope (Canvas ADE)

**Date:** 2026-06-20
**Status:** scoping only — no code changed. This is a *measured* scope (the React 19 bump was
applied in a throwaway worktree and `pnpm typecheck` was run against the real `@types/react@19`),
not an estimate.
**Driver:** dependabot **#77** (`react`/`react-dom`/`@types/react` 18→19), which was blocked because
it is a **major** bump with no migration done. This doc says exactly what the migration costs.

> **Stack note.** `CLAUDE.md` › Stack locks the app to **React 18**. Adopting React 19 changes a
> locked decision, so it needs an explicit sign-off — see *Recommendation*. This doc establishes
> that the change is **technically small and low-risk**; whether to spend the change is a product call.

---

## TL;DR

- **The migration is small and mechanical.** Measured fallout against `react@19.2.7` /
  `@types/react@19.2.17` / `@types/react-dom@19.2.3`: **5 typecheck errors**, all the *same* canonical
  React 19 type change (`RefObject<T | null>`). Fixable in ~6–8 one-line type-annotation edits.
- **No dependency blocks React 19.** `@xyflow/react@12.11` (peer `react >=17`), `@testing-library/react@16.3.2`,
  `zustand@5.0.14`, and `@vitejs/plugin-react@5.2` all accept React 19 — a clean install produced
  **zero React peer warnings**.
- **The codebase is already React-19-shaped:** modern `createRoot` root, automatic `react-jsx`
  transform, `ReactElement` return types (not `JSX.Element`), and **none** of the removed legacy APIs.
- **Effort: ~half a day** including the full gate + e2e matrix + manual dev check. **Risk: low.**
- **Prerequisite already met:** the `@xyflow/react` 12.11 bump (#189, merged) removes 3 unrelated
  `onNodeDrag` type errors that otherwise show up alongside the React 19 ones.

---

## What was measured

In a throwaway worktree (`docs/react-19-migration-scope`), bumped:

| Package | 18.x (current) | 19.x (tested) |
|---|---|---|
| `react` | 18.3.1 | **19.2.7** |
| `react-dom` | 18.3.1 | **19.2.7** |
| `@types/react` | 18.3.x | **19.2.17** |
| `@types/react-dom` | 18.3.x | **19.2.3** (latest; note: not .17 — versions diverge from `@types/react`) |
| `@xyflow/react` | 12.11 | 12.11 (post-#189 state) |

`pnpm install` → **clean, no React peer warnings**. `pnpm typecheck` → **8 errors total**, of which
**3 are the already-fixed `onNodeDrag` xyflow change (#189)** and **5 are React-19-specific**.

### The 5 React-19 errors (all `TS2322`, all the same root cause)

```
src/renderer/src/canvas/Canvas.tsx(197,34)            RefObject<HTMLDivElement | null> ⇏ RefObject<HTMLDivElement>
src/renderer/src/canvas/Canvas.tsx(536,40)            (same)
src/renderer/src/canvas/boards/PlanningBoard.tsx(173) (same)
src/renderer/src/canvas/boards/TerminalBoard.tsx(119) (same)
src/renderer/src/canvas/hooks/useGroupInteractions.test.tsx(45)  { current: null } ⇏ RefObject<HTMLDivElement>
```

**Root cause (the canonical React 19 `@types` change):** in `@types/react@19`, `useRef<T>(null)` now
returns `RefObject<T | null>` (React 18 returned a `RefObject<T>` whose `current` was `T | null`, and
`MutableRefObject<T>` for the value overload). The refs themselves are fine — the errors are at the
**consumer signatures** that declare a parameter/prop as the non-null `RefObject<HTMLDivElement>`.

### Fix sites (the consumer signatures to widen `RefObject<T>` → `RefObject<T | null>`)

```
src/renderer/src/canvas/boards/planning/usePlanningImageIO.ts:29   wellRef:    RefObject<HTMLDivElement>
src/renderer/src/canvas/boards/terminal/useTerminalSpawn.ts:135    screenRef:  RefObject<HTMLDivElement>
src/renderer/src/canvas/boards/terminal/useTerminalWebgl.ts:41     suspendRef: RefObject<boolean>
src/renderer/src/canvas/hooks/useGroupInteractions.ts:35           paneRef:    RefObject<HTMLDivElement>
src/renderer/src/canvas/hooks/useTidyTile.ts:44                    paneRef:    RefObject<HTMLDivElement>
# test helpers:
src/renderer/src/canvas/hooks/useBoardKeyboardNav.test.tsx:30      pane(): React.RefObject<HTMLDivElement>
src/renderer/src/canvas/hooks/useGroupInteractions.test.tsx:45     { current: null } literal
```

Each is a one-line edit. (Not every line above produces an error today, but widening all of them is
the consistent, future-proof fix; `tsc` confirms the exact required set.)

---

## Why the surface is so small (baseline audit)

Grepped the whole `src/` tree for every React-19 removal / breaking pattern — **all came back empty:**

| React 19 removal / change | Occurrences in repo | Status |
|---|---|---|
| `ReactDOM.render` / `hydrate` / `unmountComponentAtNode` | 0 | already on `createRoot` (`main.tsx`) |
| `defaultProps` on function components | 0 | ✅ |
| `propTypes` / `PropTypes` | 0 | ✅ |
| `findDOMNode` | 0 | ✅ |
| Legacy context (`contextTypes` / `childContextTypes`) | 0 | ✅ |
| String refs (`ref="…"`) | 0 | ✅ |
| `forwardRef` (deprecated path; ref-as-prop in 19) | 0 | ✅ nothing to migrate |
| `react-dom/test-utils` (`act` moved) | 0 | ✅ (`@testing-library` handles `act`) |
| no-arg `useRef<T>()` (requires arg in 19) | 0 | ✅ |
| ref-callback implicit return (must return void/cleanup) | 0 | ✅ |
| bare `JSX.Element` (global `JSX` namespace → `React.JSX`) | 0 | uses `ReactElement` from `react` |
| JSX transform | `react-jsx` (automatic) | ✅ React-19 ready |

The only deprecation present is `MutableRefObject<T>` (`useTerminalReraster.ts`, `useCanvasKeybindings.ts`):
in React 19 it's a still-working alias of `RefObject<T>`. **Not required** for the migration — optional
cleanup.

---

## Dependency compatibility

| Package | Version | React 19? | Evidence |
|---|---|---|---|
| `@xyflow/react` | 12.11.0 | ✅ | `peerDependencies.react: ">=17"`; clean install, no peer warning |
| `@testing-library/react` | 16.3.2 | ✅ | RTL 16.3.x officially supports React 19 (16.3.2 fixed `onCaughtError` types) |
| `zustand` | 5.0.14 | ✅ | zustand 5 supports React 19 |
| `@vitejs/plugin-react` | 5.2.0 | ✅ | supports React 19 |
| `@types/react-dom` | 19.2.3 | ⚠️ note | latest is **19.2.3**, *not* lockstep with `@types/react@19.2.17` — pin them independently |

No dependency forces a downgrade or override. (Note: `@xyflow/react` bundles `zustand@^4.4.0`
*internally* as a normal dependency — that's React Flow's own store, independent of our app's
`zustand@5`, and is unaffected by React 19.)

---

## Recommended migration plan (one focused PR)

1. **Branch** `feat/react-19` off current `main` (which already has #189's xyflow 12.11 fix).
2. **Bump** `react` & `react-dom` → `^19.2.7`; `@types/react` → `^19.2.17`; `@types/react-dom` → `^19.2.3`.
   Regenerate the lockfile from `main`'s last-good base (avoid the dependabot 3-way-merge lockfile
   corruption class — see [[dependabot-lockfile-merge-corruption]]).
3. **Fix the ~6–8 `RefObject<T>` → `RefObject<T | null>`** consumer signatures listed above; re-run
   `pnpm typecheck` until clean (tsc is the exact checklist).
4. **Optional polish (not required):** replace deprecated `MutableRefObject<T>` with `RefObject<T>`;
   consider adopting `createRoot`'s `onCaughtError`/`onUncaughtError` callbacks (our `ErrorBoundary`
   already covers render errors, so this is additive).
5. **Verify:** `pnpm typecheck · lint · format:check`, full unit/integration (`pnpm test`), **full e2e
   matrix** (`pnpm test:e2e:matrix` — both legs), and a **title-stamped manual dev check** (`CANVAS_DEV_TITLE='React 19' pnpm dev`)
   per `CLAUDE.md`. The renderer is the entire React surface, so e2e + the dev check are the real
   runtime gate.
6. **Close #77** (its bare bump is superseded by this migration PR).

**Effort:** ~half a day (the code change is minutes; the bulk is the e2e matrix + manual check).
**Risk:** low — no removed-API usage, modern root already in place, all deps compatible, runtime
behavior changes (automatic batching, StrictMode double-invoke) were already adopted in React 18.

---

## Runtime behavior worth a glance during the dev check

None are expected to bite (we're already on the React 18 concurrent root), but verify during the
manual check:

- **StrictMode double-invocation of effects** — already React 18 behavior; no change expected.
- **Error surfacing** — React 19 routes uncaught render errors through `onUncaughtError`; our
  `ErrorBoundary` fallback (`main.tsx`) still catches them. Confirm the "Something went wrong" screen
  still appears on a thrown render (there's an e2e/unit test for this).
- **Refs** — after widening the signatures, confirm terminal/planning/group pane interactions
  (drag, tidy, image paste) still work — those hooks are the ones whose ref params changed.

---

## Sources

- [React 19 Upgrade Guide](https://react.dev/blog/2024/04/25/react-19-upgrade-guide)
- [@xyflow/react releases](https://github.com/xyflow/xyflow/releases) (12.11 peer `react >=17`)
- [@testing-library/react releases](https://github.com/testing-library/react-testing-library/releases) (React 19 support in v16.3.x)
- [zustand React 19 discussion](https://github.com/pmndrs/zustand/discussions/2842)
- Measured locally: throwaway `react@19.2.7` install + `pnpm typecheck` (8 errors → 5 React-19 + 3 already-fixed-by-#189).
