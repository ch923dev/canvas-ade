import { describe, expect, it } from 'vitest'
import path from 'node:path'
import { buildDaemonBundleInMemory } from './daemonBundle'

/**
 * Regression guard for the staged-daemon boot crash: as a Rollup entry the daemon shared the
 * main build's module graph, protocol.ts got chunk-split into out/main/chunks/, and the staged
 * copy (which carries ONLY ptyHostDaemon.js) died on its first require — silently, before it
 * could log or listen. The bundle MUST stay self-contained forever.
 */
describe('daemonBundle', () => {
  const built = buildDaemonBundleInMemory(path.resolve(__dirname, 'daemonMain.ts'))

  it('emits a self-contained bundle (no chunk requires, node-pty the only external)', () => {
    expect(built.text).not.toContain('./chunks/')
    // Every require left in the output must be node-builtin or node-pty — a relative require
    // means esbuild left a file behind that the stage copy would sever.
    const relativeRequires = [...built.text.matchAll(/require\(["'](\.[^"']*)["']\)/g)].map(
      (m) => m[1]
    )
    expect(relativeRequires).toEqual([])
  })

  it('never reaches electron or app-runtime modules from the daemon entry', () => {
    expect(built.text).not.toMatch(/require\(["']electron["']\)/)
    // Exactly the daemon's own plain-Node modules. Growth here means someone made daemonMain
    // reach into app-runtime code — keep the daemon standalone (it runs under RUN_AS_NODE
    // from a stage dir where nothing else exists).
    const names = built.inputs.map((i) => i.replace(/\\/g, '/').split('/').pop()).sort()
    expect(names).toEqual(['daemonMain.ts', 'protocol.ts', 'ring.ts'])
  })
})
