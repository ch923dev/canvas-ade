/**
 * Project-root containment — the file-tree epic's highest-risk piece (KICKOFF §4).
 *
 * Confine EVERY filesystem op a `file:*` handler performs to the open project folder.
 * Two layers, BOTH required (skipping either has produced real CVEs — node-static
 * CVE-2023-26111 for the lexical layer; @tinacms/graphql CVE-2026-34604 +
 * MCP-filesystem CVE-2025-53109 for the symlink layer):
 *
 *   1. LEXICAL  (`resolveWithinRoot`) — treat renderer input as RELATIVE-ONLY. Reject
 *      absolute / drive-relative / UNC / device forms, Windows reserved device names,
 *      alternate-data-stream colons and trailing dot/space up front, then `path.resolve`
 *      + a `path.relative`-based boundary predicate.
 *   2. PHYSICAL (`realResolveWithinRoot`) — `fs.realpath` the lexically-valid candidate
 *      and re-assert the SAME boundary, to defeat symlinks/junctions that point outside
 *      the root. For a not-yet-existing write target, realpath the PARENT then re-append
 *      the basename.
 *
 * Residual TOCTOU (a check-then-use symlink swap between this check and the fs op) is
 * ACCEPTED for the single-user desktop threat model — there is no portable openat /
 * per-component O_NOFOLLOW in Node. (KICKOFF §4 "Residual TOCTOU".)
 *
 * The renderer NEVER sends an absolute path; MAIN re-resolves the relative path against
 * the realpath'd root and re-validates. `rootAbs` passed by callers is ALREADY realpath'd
 * (the fileIpc handler does `await fs.realpath(dir)` once) — these helpers assume that.
 */
import path from 'node:path'
import { realpath } from 'node:fs/promises'

/**
 * Windows reserved device names (case-insensitive), optionally followed by an extension
 * (`NUL.txt` is still the device). Matched against a component AFTER trailing dots/spaces
 * are stripped + lower-cased.
 */
const RESERVED_DEVICE_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/

/**
 * Re-assert the boundary: `candidate` must be `rootAbs` itself or strictly under it.
 * `path.relative` is the Windows-safe form — a sibling whose name is a prefix of the root
 * (the `/r` vs `/r-evil` collision) yields a `..`-leading or absolute relative, both rejected.
 */
function isWithin(rootAbs: string, candidate: string): boolean {
  const rel = path.relative(rootAbs, candidate)
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel))
}

/**
 * Synchronous LEXICAL containment. Returns the resolved absolute candidate path inside
 * `rootAbs`, or THROWS on any escape / malformed input. Steps run in this exact order
 * (load-bearing): encoding/NUL → absolute/drive/UNC/device → per-component reserved/ADS/
 * trailing → lexical boundary.
 */
export function resolveWithinRoot(rootAbs: string, userPath: string): string {
  // 1. Input guards: require a string with no NUL byte. CONTRACT: callers pass an
  //    ALREADY-DECODED, real relative path (the tree surfaces real on-disk names). `%` is a
  //    legal filename char (`report%20final.pdf`, `50%off.png`) and Node's fs NEVER URL-decodes
  //    a path, so there is no decode-bypass to defend against here — we deliberately do NOT
  //    reject `%` (a literal `%2e%2e` dir name is a real folder, not traversal; the boundary
  //    check below contains it). Any caller holding still-encoded input must decode at its own
  //    trusted boundary before calling this.
  if (typeof userPath !== 'string') throw new Error('pathSafe: path is not a string')
  if (userPath.includes('\0')) throw new Error('pathSafe: path contains a NUL byte')

  // 2. Reject absolute / drive / drive-relative / UNC / extended-device forms. NOTE:
  //    `path.isAbsolute('C:foo')` is FALSE (drive-RELATIVE), so the `/^[A-Za-z]:/` regex
  //    is MANDATORY. `\\?\` and `\\.\` (and their `//?/` `//./` slash variants) DISABLE
  //    OS path parsing, so they must be rejected outright.
  if (
    path.win32.isAbsolute(userPath) ||
    path.posix.isAbsolute(userPath) ||
    /^[A-Za-z]:/.test(userPath) || // drive letter, incl. drive-relative `C:foo`
    /^[\\/]{2}/.test(userPath) || // UNC `\\srv\share` (and `//srv/share`)
    userPath.includes('\\\\?\\') ||
    userPath.includes('\\\\.\\') ||
    userPath.includes('//?/') ||
    userPath.includes('//./')
  ) {
    throw new Error(`pathSafe: absolute/UNC/device path rejected: ${userPath}`)
  }

  // 3. Per-component scan (split on runs of either separator). Reject a component that:
  //    - carries a `:` (alternate data stream / drive colon);
  //    - has a TRAILING dot/space on the component (`secret.txt.` / `secret.txt `) — Windows
  //      STRIPS those from the END of a name, so the on-disk name would differ from the request
  //      (a normalization-collision hazard). Only the END is stripped, so a space/dot BEFORE the
  //      extension (`foo .txt`) is a legitimate, distinct name and is NOT rejected.
  //    - after trailing dots/spaces are stripped + lower-cased, IS a reserved device name.
  //    '', '.' and '..' are structural (the boundary check below handles `..` escapes).
  for (const raw of userPath.split(/[\\/]+/)) {
    if (raw === '' || raw === '.' || raw === '..') continue
    if (raw.includes(':')) {
      throw new Error(`pathSafe: path component contains a colon (ADS): ${raw}`)
    }
    if (/[ .]$/u.test(raw)) {
      throw new Error(`pathSafe: trailing dot/space in path component (Windows-stripped): ${raw}`)
    }
    const bare = raw.replace(/[ .]+$/u, '').toLowerCase()
    if (RESERVED_DEVICE_RE.test(bare)) {
      throw new Error(`pathSafe: reserved device name rejected: ${raw}`)
    }
  }

  // 4. Lexical boundary: resolve against the root, then require equal-or-under.
  const candidate = path.resolve(rootAbs, userPath)
  if (!isWithin(rootAbs, candidate)) {
    throw new Error(`pathSafe: path escapes the project root: ${userPath}`)
  }

  // 5. The contained absolute path.
  return candidate
}

/**
 * `resolveWithinRoot` + a PHYSICAL re-check that defeats symlink/junction escape. Resolves
 * the lexical candidate's real path (`fs.realpath`) and re-asserts the SAME boundary. When
 * the target does not exist yet (a write to a new file → ENOENT), realpath the PARENT dir
 * and re-append `path.basename(candidate)` so a not-yet-created file still validates.
 * THROWS on any escape. Returns the real absolute path.
 *
 * `rootAbs` is assumed already realpath'd by the caller (fileIpc resolves it once).
 */
export async function realResolveWithinRoot(rootAbs: string, userPath: string): Promise<string> {
  const candidate = resolveWithinRoot(rootAbs, userPath)
  let real: string
  try {
    real = await realpath(candidate)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      // The target file may not exist yet (a write). Realpath the PARENT (which must
      // exist + must itself be within the root once resolved), then re-append the leaf.
      const parentReal = await realpath(path.dirname(candidate))
      if (!isWithin(rootAbs, parentReal)) {
        throw new Error(`pathSafe: realpath of parent escapes the project root: ${userPath}`)
      }
      real = path.join(parentReal, path.basename(candidate))
      // The re-joined real leaf must still be within the root (defensive; parent is).
      if (!isWithin(rootAbs, real)) {
        throw new Error(`pathSafe: realpath escapes the project root: ${userPath}`)
      }
      return real
    }
    throw err
  }
  if (!isWithin(rootAbs, real)) {
    throw new Error(`pathSafe: realpath escapes the project root (symlink): ${userPath}`)
  }
  return real
}
