# 2026-06-19 — Feature-improvement audit (Post-Audit Polish "PA" umbrella) — COMPLETE

> Summary index. The raw package (`2026-06-19-feature-audit/`: `REPORT.md` · `REMEDIATION-EPIC.md` ·
> `HANDOFFS.md`) was collapsed to git history on 2026-06-21 in the PA-R PR (doc-lifecycle: a review
> package collapses to a dated summary once every finding is dispositioned). Recover via
> `git log --all --oneline -- docs/reviews/2026-06-19-feature-audit/`.

## Outcome

- **Scope:** all features shipped on `main` — canvas core/camera/chrome, terminal, browser/preview
  (OSR), planning/whiteboard, groups & connectors, persistence/schema/undo, MCP/Context/LLM + digest
  UI, app chrome / Ctrl+K palette. **Excluded** (in-flight, iterated separately): File Tree and
  Command Board.
- **Method:** forward-looking perf/UX/a11y/code-quality audit (NOT a bug hunt), adversarial
  multi-agent verify: 52 raw → **43 confirmed** (3 High · 17 Med · 23 Low) + 7 verify-first terminal
  notes. Decomposed into a file-disjoint remediation umbrella: **10 work slices (PA-1…PA-10) + 1 lint
  ratchet (PA-R)**, partitioned by file-zone ownership so parallel sessions never edit the same file.
- **Result:** **all 11 slices merged**; every confirmed finding fixed or consciously deferred (below).
  Full gate + full e2e matrix (both legs) green at each merge.

## Slice → PR map

| Slice | Findings | PR / squash |
|---|---|---|
| PA-1 — Canvas camera & core | CANVAS-01 (H), 02, 04, 06 | #186 `0c43c035` |
| PA-2 — Board chrome (a11y keystone) | PLAN-02 (H, IconBtn), PERF-04, 05, CANVAS-05 | #190 `a6214466` |
| PA-3 — App chrome + save status | CHROME-01, 02, A11Y-01, PERSIST-03 | #197 `f9a2d724` |
| PA-4 — Modals & token conformance | STYLE-01, MCP-01, 05 | #199 `1f3d5f57` |
| PA-5 — Planning / whiteboard | PLAN-01 (H), 02-labels, 03, 04, 05, 06, 07 | #200 `f71d219d` |
| PA-6 — Groups & connectors | GROUP-01…07 | #202 `bf9fc8a7` |
| PA-7 — Preview / OSR | PREV-01, 02, 04 | #196 `2c2f93fa` |
| PA-8 — Persistence & autosave | PERSIST-01 (+PERF-07), 02 | #195 `b8600463` |
| PA-9 — Terminal | TERM-01, 03, 04, 06, 07, PERF-06 (02, 05, 08 verified) | #203 `a9035a71` |
| PA-10 — Context / MCP UI | MCP-03, 04, 06, 07, 08 | #196 `2c2f93fa` |
| PA-R — Token-enforcement lint ratchet | STYLE-02 | this PR |

> The 3 Highs landed across PA-1 (CANVAS-01, per-frame digest re-render), PA-2 (PLAN-02, the IconBtn
> a11y keystone that named every icon button app-wide), and PA-5 (PLAN-01, lazy camera-zoom read).

## PA-R (this slice) — token-drift lint guard

STYLE-02 ships as a renderer `no-restricted-syntax` rule (`eslint.config.mjs`) flagging the
**high-signal** token drift — raw **hex + rgb/rgba color** literals (change `--accent` and a
hard-coded `#4f8cff` goes stale) and raw **px/%/em-string** `fontSize`/`borderRadius` — scoped to
`src/renderer/**/*.tsx`. **Warn-only** (`eslint .` exits 0 on warnings) so it surfaces the existing
backlog (~32 hits, all pre-existing in already-merged slices PA-R cannot touch) without failing the
gate; the ratchet to `error` happens file-by-file as a file's literals migrate to `var(--token)`.

- **Bare NUMERIC `fontSize`/`borderRadius` deliberately not flagged** — ~210 hits, a pervasive
  *accepted* pattern (used in fresh design-reviewed code), the fs/radius tokens change rarely (low
  propagation risk), and ~half the hits live in `boards/command/**` (the out-of-scope Command Board).
  Flagging them would bury the lint's signal for near-zero benefit; the numeric ratchet is a
  documented follow-up (flip on a `[value>=0]` selector once those literals are migrated).
- `.tsx`-only: xterm's numeric `fontSize` is a genuine library API in a `.ts` hook (an expression,
  not a literal), and `.ts` theme modules (CodeMirror, Mermaid, planning text tokens) legitimately use
  concrete values for worker / 3rd-party contexts that cannot read CSS vars.

## Deferred / not-fixed (consciously, with rationale)

- **PLAN-08** (arrow text labels) — needs an additive v12→v13 schema bump touching files outside
  PA-5's zone; deferred to a dedicated schema PR.
- **PREV-03** (rect-cover freeze) — skipped; duplicates the existing off-screen / below-LOD paint-gate
  for marginal gain.
- **CHROME-05 / TERM-07-host** — `AppChrome.tsx` host split deferred (file stays under the 700-code-line
  cap; `max-lines` ratchet guards it). TERM-07 shipped the terminal context-menu extraction in PA-9.
- **STYLE-02 numeric ratchet** — the bare-numeric `fontSize`/`borderRadius` half of STYLE-02 (above).
- **Rejected at audit** (out of scope per `REPORT.md` §6.1): CANVAS-03, PERSIST-04, MCP-02, CHROME-04.

## Related

- Per-slice detail (what each fix did, gate/matrix results, bot dispositions) is in
  `docs/archive/build-history.md` › *2026-06-19/21 — Post-Audit Polish*.
