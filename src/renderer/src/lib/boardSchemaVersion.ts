/**
 * Schema version constants — kept in a DEPENDENCY-FREE module so any consumer (renderer OR a
 * main-side lock-step test) can import the authoritative numbers WITHOUT dragging in the rest of
 * boardSchema's module graph (which transitively imports DOM-only code via terminalFont, breaking
 * the node tsconfig). `boardSchema.ts` re-exports these; MAIN's `projectStore.ts` hand-mirrors them
 * (a renderer→main import is avoided in shipped code) and a lock-step test asserts parity (BUG-013/014).
 *
 * Bump on any breaking change to the persisted shape and add a migration in `boardSchema.ts`.
 *
 * SCHEMA-VERSION CLAIM:
 * - v5 = MCP M2 — spatial connectors.
 * - v6 = board groups (named board clusters, #84). Backfills an empty `groups` array.
 * - v7 = free-text typography tokens (fontFamily / fontSize / align / color / bold — all optional on
 *   TextElement; defaulted at render time). Identity migration. #84 took v6 first, so v6 → v7 (ADR 0004).
 * - v8 = optional TextElement.width (area-text wrap-box width in board px). All-optional → identity bump.
 * - v9 = optional root `background` (canvas backdrop). Optional + defaulted-at-read → identity bump.
 * - v10 = optional TerminalBoard `agentKind` + `monitorActivity` (New Terminal agent presets). Both
 *   optional + defaulted-at-read → identity bump; ADDITIVE so MIN_READER_VERSION stays 9.
 *   Do not silently reuse a version for a new shape.
 */
export const SCHEMA_VERSION = 10

/**
 * Two-tier versioning (ADR 0007): the compat floor stamped into every written doc as
 * `minReaderVersion` — the lowest SCHEMA_VERSION an app needs to read what we write.
 *
 * - ADDITIVE change (new OPTIONAL fields, defaulted at read): bump SCHEMA_VERSION only.
 *   Older readers (>= this floor) still open the doc; unknown optional fields ride through
 *   fromObject's structuredClone and survive a save round-trip.
 * - BREAKING change (new board type / element kind, a semantic change an older validator rejects or
 *   misreads, or a NEW DOC-LEVEL KEY — toObject rebuilds the root object, so an older reader's save
 *   would DROP it): bump BOTH to the same value.
 *
 * Floor starts at 9: v9's root `background` key is exactly the doc-level case above — a v8 reader
 * would open the doc but silently DROP the user's wallpaper on its next save, so v9 is the breaking
 * baseline. Pre-9 apps keep their old strict refuse-on-newer behavior; every app from 9 on can read
 * all future additive docs.
 */
export const MIN_READER_VERSION = 9
