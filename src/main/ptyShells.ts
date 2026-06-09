import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

/** One discoverable shell on this OS, surfaced to the per-board shell picker. */
export interface ShellInfo {
  /** Absolute path or bare command passed to `pty.spawn`. */
  path: string
  /** Short display label, e.g. `pwsh` / `bash`. */
  label: string
  /** True for the OS-aware default (the first match). */
  default?: boolean
}

/**
 * Canonical dedupe key for a shell path. Resolves 8.3 short names, junctions,
 * and symlinks via `realpathSync.native` (so a non-canonical COMSPEC and
 * `onPath('cmd')` that point at the SAME cmd.exe collapse to one key), falling
 * back to a normalized path when the target doesn't exist. Pure except for the
 * realpath probe; the resolver is injectable so it is unit-testable.
 */
export function canonicalizeShellPath(
  p: string,
  realpath: (q: string) => string = (q) => fs.realpathSync.native(q)
): string {
  try {
    return realpath(p)
  } catch {
    return path.normalize(p)
  }
}

/** First existing path on the system PATH for a bare command name. */
function onPath(cmd: string): string | null {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean)
  for (const dir of dirs) {
    for (const ext of exts) {
      const full = path.join(dir, cmd + ext)
      try {
        if (fs.existsSync(full) && fs.statSync(full).isFile()) return full
      } catch {
        /* unreadable PATH entry */
      }
    }
  }
  return null
}

/** First of the candidate absolute paths that exists as a file. */
function firstFile(...candidates: Array<string | null | undefined>): string | null {
  for (const c of candidates) {
    if (!c) continue
    try {
      if (fs.existsSync(c) && fs.statSync(c).isFile()) return c
    } catch {
      /* unreadable */
    }
  }
  return null
}

/**
 * SEC-1: validate a spawn cwd. The renderer's `opts.cwd` is trusted-user input but a
 * corrupt/hand-edited canvas.json can carry a missing or non-dir path; an invalid cwd
 * throws inside pty.spawn. Mirror the `shell`/`dir` hardening: fall back to home unless
 * cwd is an existing directory.
 */
export function safeCwd(cwd?: string): string {
  try {
    if (cwd && fs.statSync(cwd).isDirectory()) return cwd
  } catch {
    /* not accessible / does not exist → fall through */
  }
  return os.homedir()
}

/**
 * Git for Windows' `bash.exe` (Git Bash), if installed. Probes the install root
 * derived from `git` on PATH (`…\Git\cmd\git.exe` → `…\Git\bin\bash.exe`) plus
 * the usual Program Files / per-user locations. This is the REAL Git Bash, not
 * the `WindowsApps\bash.exe` Store alias (which is just the WSL launcher).
 */
function findGitBash(): string | null {
  const roots: string[] = []
  const git = onPath('git') // …\Git\cmd\git.exe → root is two dirs up
  if (git) roots.push(path.dirname(path.dirname(git)))
  const pf = process.env.ProgramFiles || 'C:\\Program Files'
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
  roots.push(path.join(pf, 'Git'), path.join(pf86, 'Git'))
  if (process.env.LOCALAPPDATA) roots.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'Git'))
  return firstFile(...roots.map((r) => path.join(r, 'bin', 'bash.exe')))
}

/** WSL launcher — prefer the real System32 binary over the WindowsApps alias. */
function findWsl(): string | null {
  const sysRoot = process.env.SystemRoot || 'C:\\Windows'
  return firstFile(path.join(sysRoot, 'System32', 'wsl.exe')) || onPath('wsl')
}

/**
 * Discoverable shells, OS-aware, best-default first (CLAUDE.md: Win
 * pwsh > powershell > cmd; *nix `$SHELL` then zsh > bash). Pure of side effects
 * beyond filesystem probes; the list drives the per-board shell picker, and the
 * head element is the spawn default when the board has no explicit `shell`.
 */
function enumerateShellsUncached(): ShellInfo[] {
  const found: ShellInfo[] = []
  const seen = new Set<string>()
  const seenLabels = new Set<string>()
  const add = (p: string | null | undefined, label: string): void => {
    if (!p) return
    // Canonicalize first so 8.3/junction/symlink variants of the same binary
    // (e.g. a non-canonical COMSPEC vs onPath('cmd')) collapse to one entry, and
    // store the resolved path so the picker shows a single stable value.
    const resolved = canonicalizeShellPath(p)
    const key = resolved.toLowerCase()
    // Belt-and-suspenders: also dedupe by label, so the two `cmd` adds can never
    // both surface even if their canonical paths somehow differ.
    if (seen.has(key) || seenLabels.has(label)) return
    seen.add(key)
    seenLabels.add(label)
    found.push({ path: resolved, label })
  }

  if (process.platform === 'win32') {
    add(onPath('pwsh'), 'pwsh')
    add(onPath('powershell'), 'powershell')
    add(process.env.COMSPEC, 'cmd')
    add(onPath('cmd'), 'cmd')
    add(findGitBash(), 'git bash')
    add(findWsl(), 'wsl')
    // A standalone bash/zsh on PATH (e.g. MSYS2/Cygwin), skipping the
    // WindowsApps Store alias which is just the WSL launcher (already added).
    const stdBash = onPath('bash')
    if (stdBash && !/WindowsApps/i.test(stdBash)) add(stdBash, 'bash')
    const stdZsh = onPath('zsh')
    if (stdZsh && !/WindowsApps/i.test(stdZsh)) add(stdZsh, 'zsh')
  } else {
    if (process.env.SHELL) add(process.env.SHELL, path.basename(process.env.SHELL))
    add(onPath('zsh'), 'zsh')
    add(onPath('bash'), 'bash')
    add('/bin/bash', 'bash')
  }

  if (found.length === 0) found.push({ path: defaultShell(), label: 'shell' })
  found[0].default = true
  return found
}

/**
 * Process-lifetime memo of the enumerated shells. Installed shells don't change
 * mid-session, yet `enumerateShells` was running a full blocking-sync FS probe set
 * on EVERY `pty:spawn` (and every `pty:shells`) on the MAIN thread. Cache the
 * finished list once and reuse it — `enumerateShellsUncached` mutates only its own
 * local `found` (`found[0].default = true`) and callers treat the result as
 * read-only (`resolveShell` reads it; the `pty:shells` IPC handler structure-clones
 * it over the wire), so returning the same reference is safe — no defensive clone.
 * The public return type is `readonly` (below) so the shared cache cannot be mutated
 * (push/splice or `found[0].default = …`) by a future caller — enforced, not just documented.
 */
let cachedShells: ShellInfo[] | null = null

/**
 * Discoverable shells, OS-aware, best-default first — memoized for the process
 * lifetime (see `cachedShells`). The first call runs the FS probe set; later calls
 * return the cached array. `clearShellCache` resets it (tests / shell-set changes).
 * Returns a `readonly` view so the shared memo can't be mutated by a caller.
 */
export function enumerateShells(): ReadonlyArray<Readonly<ShellInfo>> {
  return (cachedShells ??= enumerateShellsUncached())
}

/**
 * Drop the memoized shell list so the next `enumerateShells()` re-probes the FS.
 * A test hook (the cache is process-lifetime in production; installed shells don't
 * change mid-session), also usable if the shell set is known to have changed.
 */
export function clearShellCache(): void {
  cachedShells = null
}

function defaultShell(): string {
  if (process.platform === 'win32') {
    return process.env.COMSPEC || 'powershell.exe'
  }
  return process.env.SHELL || '/bin/bash'
}

/**
 * M5 (defense-in-depth): validate a board's persisted `shell` before it reaches
 * `pty.spawn`. A corrupt/hand-edited `canvas.json` could otherwise name an
 * arbitrary binary that main would execute. Accept `shell` ONLY if (after
 * canonicalization) it matches one of the enumerated, system-discovered shells;
 * otherwise fall back to the OS-aware default (`shells[0]`). `undefined`/empty
 * also falls back. Pure (the canonicalize probe is the only side effect) so it
 * is unit-testable against a fixed `shells` list.
 */
export function resolveShell(
  shell: string | undefined,
  shells: ReadonlyArray<Readonly<ShellInfo>>
): string {
  const fallback = shells[0]?.path ?? defaultShell()
  if (!shell) return fallback
  const wanted = canonicalizeShellPath(shell).toLowerCase()
  const ok = shells.some((s) => canonicalizeShellPath(s.path).toLowerCase() === wanted)
  return ok ? shell : fallback
}
