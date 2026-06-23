// src/main/platformIpc.test.ts
// Unit coverage for the pure Windows-build parser behind the A-Win xterm windowsPty hint.
import { describe, it, expect } from 'vitest'
import { winBuildFromRelease } from './platformIpc'

describe('winBuildFromRelease — parse the build from os.release()', () => {
  it('extracts the build segment from a Windows release string', () => {
    expect(winBuildFromRelease('10.0.22631')).toBe(22631) // Win 11 23H2
    expect(winBuildFromRelease('10.0.19045')).toBe(19045) // Win 10 22H2
    expect(winBuildFromRelease('10.0.26100')).toBe(26100) // Win 11 24H2
  })

  it('tolerates a trailing build-revision suffix', () => {
    expect(winBuildFromRelease('10.0.22631.4317')).toBe(22631)
  })

  it('returns null for unparseable release strings (only ever called on win32, where release() is "10.0.BUILD")', () => {
    expect(winBuildFromRelease('')).toBeNull()
    expect(winBuildFromRelease('garbage')).toBeNull()
    expect(winBuildFromRelease('10.0')).toBeNull() // no build segment
  })
})
