import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Only the REFUSAL path is exercised: the passing path runs a real build + package.
const release = (flag: string, extra: Record<string, string> = {}) => {
  const env = { ...process.env, ...extra }
  for (const k of ['CSC_LINK', 'WIN_CSC_LINK']) if (!(k in extra)) delete env[k]
  return spawnSync(process.execPath, [join(__dirname, 'release.mjs'), flag], {
    env,
    encoding: 'utf8'
  })
}

describe('release.mjs — ADR 0008 signing guard', () => {
  it.each(['--win', '--mac', '--linux'])(
    '%s without a signing cert refuses before building',
    (f) => {
      const r = release(f)
      expect(r.status).toBe(1)
      expect(r.stderr).toContain('ADR 0008')
      expect(r.stdout).not.toContain('$ ') // no step ran
    }
  )

  it('a mac-only cert does not satisfy a linux release', () => {
    expect(release('--linux', { CSC_LINK: 'x' }).stderr).toContain('cannot be code-signed')
  })
})
