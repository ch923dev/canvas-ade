# ADR 0010 — Data-shape inference: bodies-off-by-default, MAIN-side capped sampling, shape-not-values

- **Status:** Proposed (2026-06-23) — awaiting sign-off before the JD-3 MAIN sampling code lands
- **Context:** JD-3 (the [JSON & Data Flow umbrella](../research/2026-06-23-json-dataflow-visualization/EPIC.md),
  REPORT §6 P2) adds a **Data Flow** tab to the per-Browser-board Network inspector that infers an API's
  **endpoint inventory + response schemas + entities** from already-captured traffic. The inventory and
  page/endpoint grouping are computable **with no bodies** (`previewOsrNetwork.ts` already caps every
  page-controlled string before it is buffered). But **schema/entity inference needs response bodies** —
  and not one body on a user click (the only body egress today, `preview:osrNetGetBody`), but *many*
  bodies *automatically* so they can be merged into a shape.

  This is a genuinely new exfiltration surface: response bodies are page-controlled and can carry PII,
  tokens, and secrets. Per the locked rule ("Add an ADR when a load-bearing decision lands"), and mirroring
  the consent-gated egress contract of **ADR 0003 (LLM egress)** + the Context subsystem's
  `canvasMemory.setCommitOptIn`, this records the inference subsystem's privacy contract and its guards.
  Lands with **JD-3** (the slice that adds the MAIN sampling path).

  > **Scope note.** This ADR governs **JD-3** (inventory + schema + entity inference, panel-tab, ephemeral)
  > and is **reused and extended by JD-4** (the id-lineage pass + the structured-initiator capture + the
  > agent-context/Mermaid **export** — export is the additional consent moment JD-4 adds; see §Out of scope).
  >
  > **Sign-off (2026-06-23).** Design direction approved against
  > [`jd-3-inventory-tab-mock.png`](../research/2026-06-23-json-dataflow-visualization/jd-3-inventory-tab-mock.png):
  > (1) JD-3 ships a **two-column inventory + entity/shape inspector** and **defers the visual node/edge
  > graph to JD-4** (relationships are stated textually in JD-3); (2) entity/FK detection is **structural
  > name+type only** (no values cross IPC — see Accepted residual risk); (3) sampling caps =
  > **20 samples / 8 MB per pass / response-only** (§Decision 4). Status flips to Accepted when JD-3 merges.

## Decision

**MAIN may sample captured response bodies to infer the *shape* of an API — but only after an explicit
per-board opt-in, only lazily and capped, and the renderer never receives the raw bodies through the
inference path. The inference output is shape (types / field-names / presence / format-hints), never
values.** Concretely:

1. **Bodies-off by default; the inventory never needs them.** The Data Flow tab's **endpoint inventory**
   (route-template collapsing, call counts, status mix, timing) and **page/endpoint grouping** are built
   entirely from the existing body-free `NetRecord` ring — they render the moment the tab opens, opt-in or
   not. **No body is sampled for inference until the user flips the per-board toggle** *"Infer data shapes
   (reads response bodies)"*. With the toggle off, the tab is fully functional at the inventory layer and
   performs **zero** body reads beyond today's manual single-row Load-body. (Mirrors ADR 0003 §1
   "opt-in, never implicit".)

2. **Lazy, not a bulk scrape.** Even with the toggle on, inference runs **only for a route-template the
   user expands** — never a background sweep of all 1000 captured records. Expanding a template triggers
   one capped sampling pass over *that template's* records; the result is memoized for the session.

3. **MAIN-side enforcement; the renderer never receives raw bodies via inference.** All sampling + the
   value-dropping shape extraction happen in **MAIN**, behind a **new `isForeignSender`-guarded IPC**
   (`preview:osrNetSampleSchema`) built exactly like `preview:osrNetGetBody`: foreign senders rejected,
   the board id + every `requestId` re-validated against live MAIN state (unknown ⇒ no-op). MAIN returns
   **only value-less shape skeletons** (field path → type, present/absent per sample, format-hint) — the
   renderer's pure `lib/` passes (`schemaInfer.ts`, `entityInfer.ts`) merge skeletons into the displayed
   schema. **Raw response bodies reach the renderer through exactly one path, unchanged: the existing
   user-initiated single-row `preview:osrNetGetBody`.** The inference path carries no values.

4. **Capped sampling (bounded MAIN memory + egress).** The sampling pass enforces, in MAIN:
   - `BODY_CAP` (5 MB) per fetched body — reused from `previewOsrNetwork.ts`, the existing bound.
   - `SCHEMA_SAMPLE_CAP` bodies per template per pass (default **20**) — newest-first; the rest are
     skipped (the merge is associative, so a sample is representative).
   - `SCHEMA_BYTES_CAP` total bytes read per pass (default **8 MB**) — a hard ceiling across the pass.
   - **Response bodies only** (the inferable surface); request payloads are out of the inference path in
     JD-3. Each fetch rides its record's own `sessionId` (worker sub-targets resolve correctly), exactly
     like the single-body fetch.
   Whatever the cap drops is **surfaced in the UI** ("sampled 20 of 86 — newest"), never dropped
   silently, so a bounded sample never reads as "analyzed everything".

5. **Shape, not values (the core privacy invariant).** The shape skeleton MAIN emits stores, per field:
   its **path** (`data.items[].id`), its **type(s)** (union, e.g. `string | null`), a **present/absent**
   bit per sample (→ `required`/`optional`), and a **format-hint** derived by *pattern class only*
   (`uuid` / `date-time` / `email` / `uri` / `int64`) — **never the matched value**. No raw value, no
   example value, leaves MAIN. **Example values are explicitly out of scope for JD-3** (a separate,
   deeper opt-in with a PII warning — see Out of scope).

6. **Truncated / parse-fail samples are shape-only.** A body cut at `BODY_CAP` (or otherwise unparseable)
   contributes **types** but **not presence** — a trailing field clipped by truncation must not be
   mis-inferred as `optional`. `required` is "present in every **complete** sample" (B3 in the REPORT).
   A sample that fails to parse is skipped (and counted), never partially trusted for presence.

7. **Scrub + secret/PII never read as a value.** Header values (`Authorization` / `Cookie` /
   `Set-Cookie`) are **never** read by the inference path (it reads bodies, not headers). The shared
   secret-scrubber `redactSecrets` (`src/main/summaryLoop.ts`) is applied to any string that could ever
   cross the IPC (format-hint derivation works on a redacted copy); since JD-3 crosses **no** values,
   this is belt-and-suspenders for the format-hint classifier and the export path JD-4 adds. Field
   **names** that match a PII/secret name pattern (`email` / `ssn` / `phone` / `token` / `secret` / …) are
   surfaced with a `⚠ PII` chip in the schema — **with no value shown** (there is no value to show).

8. **Ephemeral; nothing persists in JD-3.** Inferred schemas live in the ephemeral `osrNetworkStore`
   (no `schemaVersion`, no migration — like the rest of the inspector). **No schema bump.** Nothing is
   written to `.canvas/` in JD-3. The **export** of inferred shapes to `.canvas/memory/` is **JD-4** and
   is that slice's added consent moment (and inherits `.canvas/` git-ignore-by-default for body-derived
   data, per ADR 0009).

9. **Security posture unchanged.** `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`
   stay untouched. The new `preview:osrNetSampleSchema` handler is `isForeignSender`-guarded like every
   other `preview:osrNet*` channel; an opt-in flag set from the renderer is re-validated in MAIN per pass
   (the renderer cannot sample a board it doesn't own, nor without the live opt-in). Browser-board page
   content still never reaches the PTY write channel. No `eval`/`Function`/dynamic-import of body content.

## Consequences

- A privacy-sensitive user gets the **full endpoint inventory** (routes, counts, status, timing) with
  **zero** body reads, and simply never flips the toggle — schema/entity inference stays dark.
- When the user does opt in, body reads are **bounded** (lazy per-expanded-template, ≤20 samples, ≤8 MB/
  pass, 5 MB/body) and **value-free at the IPC boundary** — the renderer's store can never hold a raw
  sampled value, only merged shapes.
- The single pre-existing raw-body egress (`preview:osrNetGetBody`, user clicks Load body on one row) is
  **unchanged**; this ADR adds exactly one new, narrower, value-dropping egress beside it.
- No new persisted state, no schema bump (JD-3). The graceful-degradation requirement (flat APIs ⇒
  inventory + schemas + island shapes, **no fabricated edges**) is a *rendering* guarantee, unaffected by
  the privacy contract.

## Accepted residual risk

- **Field *names* can themselves be sensitive (`salary`, `ssn`, `diagnosis`).** Names are the shape, so
  JD-3 keeps them — dropping them defeats the feature. Mitigated by: values dropped at the MAIN boundary,
  off-by-default, lazy, ephemeral (never persisted in JD-3), and a `⚠ PII`-name chip that warns without
  ever revealing a value. Revealing example **values** is a deliberate future opt-in (out of scope), gated
  behind its own consent + PII warning. **Accepted.**
- **The inference fetch uses the same CDP `Network.getResponseBody` as the approved single-body path** —
  same trust boundary (a body the board itself already loaded), just N-at-a-time and value-stripped before
  crossing IPC. The `SCHEMA_SAMPLE_CAP × BODY_CAP` product bounds peak MAIN memory per pass. **Accepted.**
- **Value-overlap (inclusion-dependency) FK confirmation needs values.** JD-3's entity/PK-FK detection is
  therefore **name+type structural** (PK = `id`/`*Id`/`uuid`; FK = `<entity>Id` matching another entity's
  name) — it needs **no values** and crosses no values. If value-overlap confirmation is later wanted, it
  **runs MAIN-only over the sampled values and emits a single boolean confidence flag**, never the values.
  **Accepted** (structural-only for JD-3).
- **Route-template over/under-collapse** (e.g. `/api/v1` vs `/api/v2` wrongly merged, or a single-endpoint
  GraphQL `POST /graphql` collapsing 50 ops into one node) is a *legibility* risk, not a privacy one;
  mitigated by the editable example set + GraphQL-operation-name grouping (guardrail tests in the spec).
  **Accepted** (covered by JD-3 tests, not this ADR).

## Out of scope (not decided here)

- **Example-value reveal** — showing representative captured values inside a schema. A separate, deeper
  per-board opt-in with an explicit PII warning; **not** JD-3. (When built it must keep the MAIN-side
  scrub + cap + the per-field PII gate.)
- **The id-lineage pass + structured-initiator capture** (JD-4) — ~~deferred~~ **now decided in the
  JD-4 amendment below.** request→request edges need MAIN to preserve a structured initiator (the
  triggering `requestId`), and id-lineage reads response/request *values* to match ids — the first
  value-read past JD-3's shape-only contract.
- **Persisted / exported inferred schemas** (JD-4) — ~~deferred~~ **now decided in the JD-4 amendment
  below.** the agent-context/Mermaid export into `.canvas/memory/` is JD-4's added consent moment
  (scrub-on-export); it inherits ADR 0009's `.canvas/` git-ignore-by-default.
- **Request-payload *shape* inference** — JD-3/JD-4 infer response shapes only; full request-body shape
  inference (beyond the bounded id-token slice id-lineage reads, §B below) is a later add behind the
  same contract.

## Amendment (JD-4) — structured-initiator capture + the id-lineage value-read

- **Status:** Accepted (2026-06-23) — signed off with the JD-4 board mock + the schema-bump confirmation;
  lands with JD-4 (the slice that adds the MAIN initiator + lineage path). Extends the Decision above.

JD-4 extends this ADR's MAIN contract with two changes. They are **deliberately separated because only
the second reads values** — the first is request metadata, the second is the one genuine privacy delta.

### A. Structured-initiator capture — body-free, metadata only (NOT a value-read)

Today `initiatorOf` (`previewOsrNetwork.ts`) flattens the CDP `Network.initiator` object to a display
**string** (the initiating script url or a CDP type word), discarding the triggering `requestId`
(finding B1 — so a request cannot be resolved back to its trigger). JD-4 additionally preserves the
**structured initiator**: the CDP-supplied initiating `requestId` (when present), on a new **optional**
`NetRecord.initiatorRequestId?`. The existing `initiator` display string is unchanged.

This **reads no body** — `Network.initiator` is request metadata CDP already delivers on
`requestWillBeSent`. It is a string, capped/validated at the trust boundary like every other
page-controlled field, rides the existing replay/delta channel, and crosses **no new trust boundary**.
It promotes the page→endpoint edges (already loader-derived) to the few true request→request edges
without any value read.

### B. The id-lineage pass — the only value-read, MAIN-side and capped

id-lineage is the **first** pass that compares actual response/request **values**: an id returned by
response A reappearing in request B ⇒ a directed `A ⊳ B` edge. Its contract:

1. **Opt-in + frame-guarded.** Runs only under the existing per-board *"Infer data shapes"* opt-in (it
   reads bodies). The new `preview:osrNetLineage` IPC is `isForeignSender`-guarded; the board id + every
   `requestId` are re-validated against live MAIN state (unknown ⇒ no-op), built exactly like
   `preview:osrNetSampleSchema` / `preview:osrNetGetBody`.
2. **MAIN-side only; capped.** All value extraction + matching run in **MAIN**, reusing the JD-3 sampling
   subsystem and its caps (`SCHEMA_SAMPLE_CAP` 20, `SCHEMA_BYTES_CAP` 8 MB/pass, `BODY_CAP` 5 MB/body).
   Lineage adds its own bounds: only **id-shaped** tokens are extracted (short strings matching
   `uuid` / opaque-id / numeric-id, length-capped); the count of distinct id values tracked per pass is
   capped (`LINEAGE_VALUE_CAP`); consumer-side matching scans only the request **URL / query / path
   segments + a capped slice of request post-data** — never an O(n²) full-body cross-join of all samples.
3. **Edge-list-only over IPC — never the matched value.** MAIN emits **only** the lineage edge list:
   `{ idName, fromTemplateKey/fromRequestId, toTemplateKey/toRequestId, location: 'url'|'query'|'path'|'body', confidence }`.
   The matched raw id **value is never serialized** — only the field *name* that carried it and the
   source/target request identifiers (the same value-less discipline as JD-3's shape skeletons).
4. **Scrub before match + on export.** Every candidate id value is passed through `redactSecrets`
   (`src/main/summaryLoop.ts`) **before** it is used for matching; a value that scrubs to a secret/token
   is **excluded** from lineage (we never correlate on a bearer token / session secret). An id *name* in
   the PII/secret class is surfaced with the `⚠ PII` chip — never a value.
5. **Ephemeral; export is the consent moment.** Lineage edges live in the ephemeral store; **nothing
   persists** in `canvas.json` (the Data-Flow board persists only its `sourceBoardId` binding — no
   body-derived data). The **"→ Planning / Mermaid"** and **"→ Agent context (`.canvas/memory/`)"**
   exports are JD-4's added consent moments: they write **shape only** (entity / field names + types +
   relationships — *no values*), run `redactSecrets` over the serialized payload, and inherit ADR 0009's
   `.canvas/` git-ignore-by-default for body-derived data.

### Security posture unchanged

`contextIsolation: true`, `sandbox: true`, `nodeIntegration: false` untouched. The new `osrNetLineage`
handler is `isForeignSender`-guarded like every `preview:osrNet*` channel. No `eval` / `Function` /
dynamic-import of body content; no `dangerouslySetInnerHTML` in any viewer (the Data-Flow board renders
page-controlled strings as React-escaped text only). Browser-board content never reaches the PTY.

### Accepted residual risk (JD-4)

- **A reused id value is a weak correlator.** Two unrelated requests that both carry the same common
  value (e.g. a tenant id or an enum) could produce a spurious lineage edge. Mitigated by: id-SHAPED
  extraction only (not arbitrary values), a confidence score surfaced on the edge, the
  focus-on-node-default graph (never the whole surface), and the never-invent-edges rule (a flat API
  draws **zero** lineage edges). **Accepted** — lineage is a navigational hint, not an assertion.
- **The lineage scan reuses the approved `Network.getResponseBody` trust boundary** (a body the board
  already loaded), value-stripped before the edge list crosses IPC, bounded by
  `LINEAGE_VALUE_CAP × BODY_CAP`. **Accepted** (same boundary as the JD-3 single-body + sampling paths).
