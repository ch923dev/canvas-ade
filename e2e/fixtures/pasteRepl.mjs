// e2e/fixtures/pasteRepl.mjs — deterministic bracketed-paste REPL for the relay-integrity spec.
// Enables DECSET 2004 (exactly what claude/readline do), then appends every raw stdin byte to the
// dump file (argv[2]) and echoes an `RX <n>` line per chunk so the dispatch gate's echo-confirm
// observes ingestion. The dump IS the ground truth: whatever bytes reached this process's stdin.
import { writeFileSync, appendFileSync } from 'node:fs'
const out = process.argv[2]
if (!out) {
  console.error('usage: node pasteRepl.mjs <dump-file>')
  process.exit(2)
}
writeFileSync(out, '') // truncate: one dump per spawn
// 2004h BEFORE the READY line — once a spec sees READY in the framebuffer, the MAIN-side
// tracker has necessarily already observed the toggle and armed paste framing.
process.stdout.write('\x1b[?2004h')
if (process.stdin.isTTY) process.stdin.setRawMode(true)
process.stdin.on('data', (d) => {
  appendFileSync(out, d)
  process.stdout.write(`RX ${d.length}\n`)
})
console.log('PASTE_REPL_READY')
