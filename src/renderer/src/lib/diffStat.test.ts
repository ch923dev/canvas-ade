import { describe, it, expect } from 'vitest'
import { parseDiffStat, hasDiff, EMPTY_DIFFSTAT } from './diffStat'

const SAMPLE = `diff --git a/src/auth/reset.ts b/src/auth/reset.ts
index 1111111..2222222 100644
--- a/src/auth/reset.ts
+++ b/src/auth/reset.ts
@@ -1,4 +1,9 @@
 import { db } from '../db'
+import { randomBytes } from 'crypto'
+
+export async function issueResetToken(email: string) {
+  const token = randomBytes(32).toString('hex')
-  // TODO: reset flow
diff --git a/src/auth/email.ts b/src/auth/email.ts
--- a/src/auth/email.ts
+++ b/src/auth/email.ts
@@ -10,2 +10,3 @@
+await send(email)
-stub()`

describe('parseDiffStat', () => {
  it('returns the empty stat for empty / nullish input', () => {
    expect(parseDiffStat('')).toEqual(EMPTY_DIFFSTAT)
    expect(parseDiffStat(undefined)).toEqual(EMPTY_DIFFSTAT)
    expect(parseDiffStat(null)).toEqual(EMPTY_DIFFSTAT)
  })

  it('counts content +/- lines and changed files, excluding +++/--- headers', () => {
    const stat = parseDiffStat(SAMPLE)
    // additions: 4 (reset.ts) + 1 (email.ts) = 5 ; the +++ headers are NOT counted
    expect(stat.insertions).toBe(5)
    // deletions: 1 (reset.ts) + 1 (email.ts) = 2 ; the --- headers are NOT counted
    expect(stat.deletions).toBe(2)
    expect(stat.files).toBe(2)
  })

  it('does not mistake the +++/--- file headers for content', () => {
    const headersOnly = `diff --git a/x b/x\n--- a/x\n+++ b/x`
    expect(parseDiffStat(headersOnly)).toEqual({ insertions: 0, deletions: 0, files: 1 })
  })
})

describe('hasDiff', () => {
  it('is false for empty / whitespace / nullish, true for real content', () => {
    expect(hasDiff('')).toBe(false)
    expect(hasDiff('   \n  ')).toBe(false)
    expect(hasDiff(undefined)).toBe(false)
    expect(hasDiff(SAMPLE)).toBe(true)
  })
})
