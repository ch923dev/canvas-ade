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

  it('counts a deletion line whose body starts with `--` (removed markdown rule)', () => {
    // The deleted content line is `--- a markdown rule`, so git renders it as `----- a markdown rule`
    // (a `-` prefix + the `--- …` body). The old `startsWith('---')` guard skipped it; the
    // hunk-aware parser must count it as one deletion.
    const diff = `diff --git a/notes.md b/notes.md
index 1111111..2222222 100644
--- a/notes.md
+++ b/notes.md
@@ -1,3 +1,2 @@
 title
----- a markdown rule
 footer`
    expect(parseDiffStat(diff)).toEqual({ insertions: 0, deletions: 1, files: 1 })
  })

  it('counts an addition line whose body starts with `++` (added marker)', () => {
    // The added content line body is `++ marker`, rendered `+++ marker`. The old `startsWith('+++')`
    // guard skipped it; the hunk-aware parser must count it as one insertion.
    const diff = `diff --git a/notes.md b/notes.md
index 1111111..2222222 100644
--- a/notes.md
+++ b/notes.md
@@ -1,2 +1,3 @@
 title
+++ marker
 footer`
    expect(parseDiffStat(diff)).toEqual({ insertions: 1, deletions: 0, files: 1 })
  })

  it('classifies by first char across multiple hunks in one file', () => {
    // Two `@@` hunks in a single file; `---` / `+++` bodied content in BOTH must be counted, and the
    // second `@@` must re-open hunk context after intervening context lines.
    const diff = `diff --git a/multi.txt b/multi.txt
index 1111111..2222222 100644
--- a/multi.txt
+++ b/multi.txt
@@ -1,3 +1,3 @@
 alpha
---- dashed deletion
+++ plus addition
 beta
@@ -20,2 +20,3 @@
 gamma
+tail one
-tail gone`
    // hunk 1: 1 del (`---- dashed deletion`), 1 ins (`++ plus addition`)
    // hunk 2: 1 ins (`tail one`), 1 del (`tail gone`)
    expect(parseDiffStat(diff)).toEqual({ insertions: 2, deletions: 2, files: 1 })
  })

  it('matches a hand-verified oracle on real git diff output (delete + binary)', () => {
    // Captured from real `git diff HEAD` after: modifying doc.md (whose hunk removes a `--- …` rule
    // and a `++ …` line and adds a `++ …` line + a tail), deleting a tracked text file (gone.txt),
    // and deleting a tracked BINARY file (pic.bin → `Binary files … differ`, no hunk → no content).
    const realGit = `diff --git a/doc.md b/doc.md
index 1234567..89abcde 100644
--- a/doc.md
+++ b/doc.md
@@ -1,4 +1,4 @@
 keep line
---- a markdown rule
-++ pseudo marker
+++ pseudo marker
 another keep
+new tail
diff --git a/gone.txt b/gone.txt
deleted file mode 100644
index abcdef0..0000000
--- a/gone.txt
+++ /dev/null
@@ -1,2 +0,0 @@
-old content line one
-old content line two
diff --git a/pic.bin b/pic.bin
deleted file mode 100644
index 0011223..0000000
Binary files a/pic.bin and /dev/null differ`
    // Hand-verified oracle:
    //   files = 3 (doc.md, gone.txt, pic.bin)
    //   insertions: doc.md hunk → `+++ pseudo marker` (1) + `+new tail` (1) = 2
    //   deletions:  doc.md hunk → `----- a markdown rule` (1) + `-++ pseudo marker` (1) = 2
    //               gone.txt hunk → 2 (both old lines)
    //               pic.bin → binary, no hunk → 0
    //               total deletions = 4
    expect(parseDiffStat(realGit)).toEqual({ insertions: 2, deletions: 4, files: 3 })
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
