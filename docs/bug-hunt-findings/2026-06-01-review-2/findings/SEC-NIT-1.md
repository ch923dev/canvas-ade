# SEC-NIT-1: isUnsafeProjectDir dual-check redundancy

- **Severity:** Nit
- **Category:** security-ipc / code-clarity
- **Status:** REFUTED as a defect → kept as clarity note only
- **Files touched:** `src/main/projectIpc.ts`
- **Assigned:** _(blank)_

## Summary
`isUnsafeProjectDir` (`line 52`) checks for `..` segments in **both** the normalized path AND the original:
```ts
return path.normalize(dir).split(/[/\\]/).includes('..') || dir.split(/[/\\]/).includes('..')
```

## Why this is NOT a defect
- **No functional/security impact** — the OR rejects a strict superset; it is never *less* safe.
- The comment (`48-51`) is **not** misleading: it correctly explains the original-input check exists to catch
  traversals that fully resolve away (e.g. `C:\Users\x\..\..\evil`) which a normalized-only check would miss. It
  never claims to "only" check the original.
- `path.normalize` does not always collapse leading `..` on relative inputs, so the normalized check is not pure
  dead code (though `line 47 isAbsolute` makes surviving `..` unlikely here).

The code works correctly and securely. Remaining is a subjective redundancy observation — **no action required**.

## Suggested fix direction
None needed. If tidying: a one-line comment noting the dual check is intentional defense-in-depth.

## Collision notes
None — informational.
