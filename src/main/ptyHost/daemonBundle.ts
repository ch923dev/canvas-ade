/**
 * Build-time bundler for the PTY-host daemon. NOT imported by the app runtime — only
 * electron.vite.config.ts and the unit suite consume it (the csp.ts precedent), so esbuild
 * stays a devDependency and never ships in the packaged app.
 *
 * WHY THIS EXISTS: out/main/ptyHostDaemon.js used to be a plain Rollup entry in the main
 * build's shared module graph. Rollup factored protocol.ts (imported by BOTH client.ts and
 * daemonMain.ts) into out/main/chunks/protocol-<hash>.js — but runtimeStage.ts stages ONLY
 * ptyHostDaemon.js beside the exe. The staged daemon then died on its first require
 * ("Cannot find module './chunks/protocol-…'"), before it could log or listen, and every
 * terminal spawn burned the full connect-retry ladder (~10 s) before falling back in-proc.
 * Bundling the daemon SELF-CONTAINED with esbuild makes the one-file staging contract real:
 * whatever daemonMain.ts imports is inlined; only node-pty stays external (staged as a
 * node_modules subset beside the bundle, resolved at runtime via createRequire — native
 * .node files can't inline anyway).
 */
import * as esbuild from 'esbuild'

export interface DaemonBundleOptions {
  /** Absolute path of src/main/ptyHost/daemonMain.ts. */
  entry: string
  /** Absolute path of the emitted bundle (out/main/ptyHostDaemon.js). */
  outfile: string
}

const BASE = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  // Electron 42's embedded Node (process.version v24.15.0) — the runtime the staged exe
  // provides under ELECTRON_RUN_AS_NODE.
  target: 'node24',
  external: ['node-pty'],
  logLevel: 'silent'
} satisfies esbuild.BuildOptions

/** Bundle the daemon to disk. Returns the resolved input files (from esbuild's metafile) so
 *  the build plugin can register them as watch files — after leaving Rollup's module graph,
 *  dev edits to daemon-only modules would otherwise not trigger a rebuild. */
export function buildDaemonBundle(opts: DaemonBundleOptions): { inputs: string[] } {
  const r = esbuild.buildSync({
    ...BASE,
    entryPoints: [opts.entry],
    outfile: opts.outfile,
    metafile: true
  })
  return { inputs: Object.keys(r.metafile.inputs) }
}

/** In-memory variant for the unit suite: bundle text + resolved inputs, no files written.
 *  Tests assert the bundle is self-contained (no chunk requires) and that electron never
 *  becomes reachable from the daemon entry. */
export function buildDaemonBundleInMemory(entry: string): { text: string; inputs: string[] } {
  const r = esbuild.buildSync({
    ...BASE,
    entryPoints: [entry],
    write: false,
    metafile: true
  })
  return { text: r.outputFiles[0]?.text ?? '', inputs: Object.keys(r.metafile.inputs) }
}
