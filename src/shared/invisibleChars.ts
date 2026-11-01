/**
 * ONE definition of "an invisible code point" for every sanitizer whose output a human reads in a
 * confirm gate: `groupName.ts` (Named-Group names, which also reach `canvas://contexts`) and
 * `dispatchSanitize.ts` (the prompt-dispatch line). An invisible code point lets a string render
 * differently from its logical text, or carry text the human never sees.
 *
 * The set is Unicode's `Default_Ignorable_Code_Point` property plus the interlinear-annotation
 * controls U+FFF9-U+FFFB (format characters that property leaves out). That one property covers:
 *  - bidi embeddings/overrides U+202A-U+202E, isolates U+2066-U+2069, LRM/RLM U+200E/U+200F,
 *    ALM U+061C (the Trojan Source class);
 *  - zero-width U+200B-U+200D, word joiner U+2060, BOM U+FEFF;
 *  - variation selectors U+FE00-U+FE0F and U+E0100-U+E01EF;
 *  - tag characters U+E0000-U+E007F (the "ASCII smuggling" carrier: `U+E0041` is an invisible "A");
 *  - soft hyphen U+00AD, CGJ U+034F, Mongolian vowel separator U+180E and free variation selectors,
 *    invisible operators U+2061-U+2064, deprecated format controls U+206A-U+206F, Hangul fillers
 *    U+115F/U+1160/U+3164/U+FFA0.
 * Reading the property (not a hand-kept range list) keeps the set current with the runtime's
 * Unicode tables.
 *
 * Pure: no Node / DOM / Electron imports, so it compiles under tsconfig.node and tsconfig.web alike.
 */
const INVISIBLE = /^[\p{Default_Ignorable_Code_Point}\u{FFF9}-\u{FFFB}]$/u

/** ZERO WIDTH JOINER — invisible, but it binds emoji sequences (see `groupName.ts`). */
export const ZWJ = '‍'

/** True when `ch` (ONE code point, as `for…of` yields it) is an invisible code point. */
export function isInvisibleCodePoint(ch: string): boolean {
  return INVISIBLE.test(ch)
}
