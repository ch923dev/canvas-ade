# FIND-014 — isUnderApprovedRoot case-folds segments, over-approving case-variant project paths on case-sensitive (POSIX) filesystems (defense-in-depth loosening)

| | |
|---|---|
| **Severity** | Low |
| **Category** | security · authz (defense-in-depth) |
| **Status** | CONFIRMED (independently re-verified) |
| **Primary location** | `src/main/projectIpc.ts:61-83` |
| **Discovery slice** | M-PERSIST (run 2) |

## Summary
pathSegments() lower-cases every path component (`.map((s) => s.toLowerCase())`, line 66) to be Windows-case-insensitive, and isUnderApprovedRoot compares those lower-cased segments. On POSIX (case-SENSITIVE filesystems) `/home/User/proj` and `/home/user/proj` are DIFFERENT directories, but this approval check treats them as the same root. So a renderer can get a path approved that only case-matches a genuinely approved root — a (small) over-approval that widens the BUG-006 approved-target gate beyond the directory the user actually picked. Defense-in-depth weakening only; single-user desktop limits practical impact.

## Trigger
On Linux/macOS, the user approves `/home/user/proj`; a (compromised) renderer then requests open/create at `/home/USER/proj` (a different real directory). isUnderApprovedRoot returns true because both lower-case to the same segments, passing isApprovedTarget for a path the user never picked.

## Evidence / concrete faulty path (code-grounded)
src/main/projectIpc.ts:66 `.map((s) => s.toLowerCase()) // Windows paths are case-insensitive; harmless on POSIX` lower-cases every segment; isUnderApprovedRoot (lines 79-82) compares them: `const r = pathSegments(root); const d = pathSegments(dir); ... return r.every((seg, i) => seg === d[i])`. Repro on POSIX (case-sensitive FS): user approves /home/user/proj (dialog pick → approvedRoots.add at line 209); a compromised renderer invokes project:create with dir='/home/USER/proj'; line 300 `isApprovedTarget` → line 176 `isUnderApprovedRoot('/home/USER/proj', '/home/user/proj')` returns true (both segment-lists lower-case to home/user/proj); createProject runs mkdirSync(dir,{recursive:true}) (projectStore.ts:154) and writeProject at a directory the user never picked. Intentional per projectIpc.test.ts:71-72 (`is case-insensitive ...` expects `isUnderApprovedRoot('C:\\Users\\X\\PROJ','c:\\users\\x\\proj')` toBe true). Bounded: reject tests at projectIpc.test.ts:60-62 (/etc/passwd, C:\Windows\System32) still pass — no arbitrary-path escape. No realpath layer on this gate (realResolveWithinRoot/pathSafe is used only by fileIpc.ts, not project create/open).

## Verifier reasoning (why CONFIRMED; scope & severity)
The candidate's technical claim is accurate and I confirmed it directly. pathSegments (src/main/projectIpc.ts:61-68) lower-cases EVERY path segment at line 66 (`.map((s) => s.toLowerCase())`), and isUnderApprovedRoot (lines 77-83) compares those lower-cased segments via `r.every((seg, i) => seg === d[i])`. On a case-SENSITIVE POSIX filesystem `/home/user/proj` and `/home/USER/proj` are genuinely different directories, yet both lower-case to the same segments, so the approval check treats them as the same root. This gate (used at lines 232 and 300 via isApprovedTarget) is the SOLE containment for project:open/project:create — unlike fileIpc.ts, the project create/open path does NOT pass through the realpath/pathSafe.realResolveWithinRoot machinery, so no upstream guard renders this moot. A concrete faulty path therefore exists: a compromised renderer calling project:create({dir:'/home/USER/proj'}) when only /home/user/proj was approved passes the gate and reaches createProject → mkdirSync + canvas.json write at a path the user never picked.

However the impact is genuinely minimal, matching the candidate's own Low rating: (1) The behavior is INTENTIONAL — there is an explicit inline comment ("Windows paths are case-insensitive; harmless on POSIX") and the unit suite at projectIpc.test.ts:71-72 explicitly asserts case-insensitivity as a designed property, chosen so the host-neutral suite can drive both `/...` and `C:\...` shapes on one OS. (2) The over-approval is BOUNDED to case-variants of already-approved roots; it does NOT permit arbitrary escape to /etc, /root, ~/.ssh — those have no case-variant approved-root prefix, so the existing reject tests (lines 60-68) still hold. (3) The precondition is contrived: a distinct case-twin directory and matching case-variant parent segments must exist. (4) This is a defense-in-depth layer (BUG-006) on a single-user desktop where renderer input is treated as trusted-user-only. So it is a real, narrow weakening of a defense-in-depth check, not an exploitable escalation.

## Fix direction (audit only — NOT applied)
Compare path segments case-SENSITIVELY on POSIX (only case-fold on win32), matching pathSafe.ts platform-aware isWithin discipline, so a case-variant path cannot be over-approved on a case-sensitive filesystem.

## Files this card touches
- `src/main/projectIpc.ts (isUnderApprovedRoot 61-83)`

## Collision flags (sequence with)
- projectIpc.ts → FIND-004 (reopenFromBak)
