#!/usr/bin/env node
/*
 * Parallel-session coordination hook for Canvas ADE worktrees.
 *
 * Modes (argv[2]):
 *   session-start : print the shared ACTIVE-WORK board + recent edits by OTHER
 *                   worktrees to stdout -> Claude Code injects it as context, so
 *                   every new session opens knowing what the other sessions own.
 *   post-edit     : append {t, wt, file} to the shared edit-log.jsonl after an
 *                   Edit/Write/MultiEdit -> awareness that does NOT depend on the
 *                   agent remembering to self-report.
 *
 * IMPORTANT: all shared state lives at the fixed MAIN-repo path below, accessed by
 * absolute path. A file inside a worktree is per-branch and would NOT be shared.
 * This hook is registered per-worktree (project settings.json) so it only ever runs
 * inside a Canvas ADE worktree -- no global gating needed.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const COORD = 'Z:\\Canvas ADE\\.claude\\coordination';
const MANIFEST = path.join(COORD, 'ACTIVE-WORK.md');
const LOG = path.join(COORD, 'edit-log.jsonl');
const LOG_MAX_BYTES = 80 * 1024; // rotate when larger; keep tail

function readStdin() {
  try { return fs.readFileSync(0, 'utf8'); } catch { return ''; }
}
function stamp() {
  return new Date().toISOString().slice(0, 16).replace('T', ' ');
}

let payload = {};
try { payload = JSON.parse(readStdin() || '{}'); } catch { payload = {}; }

const cwd = String(payload.cwd || process.cwd() || '').replace(/\//g, '\\');
const wt = path.basename(cwd) || 'unknown'; // worktree identity = dir name
const mode = process.argv[2];

if (mode === 'post-edit') {
  const ti = payload.tool_input || {};
  const fp = ti.file_path || ti.filePath || ti.path;
  if (fp) {
    const rel = String(fp).replace(/\//g, '\\').replace(/^Z:\\[Cc]anvas[ -][Aa][Dd][Ee][^\\]*\\/, '');
    try {
      fs.mkdirSync(COORD, { recursive: true });
      fs.appendFileSync(LOG, JSON.stringify({ t: stamp(), wt, file: rel }) + '\n');
      // light rotation
      const st = fs.statSync(LOG);
      if (st.size > LOG_MAX_BYTES) {
        const tail = fs.readFileSync(LOG, 'utf8').trim().split('\n').slice(-300);
        fs.writeFileSync(LOG, tail.join('\n') + '\n');
      }
    } catch { /* advisory log; never block an edit */ }
  }
  process.exit(0);
}

if (mode === 'session-start') {
  const out = [];
  let manifest = '';
  try { manifest = fs.readFileSync(MANIFEST, 'utf8').trim(); } catch { /* none yet */ }
  if (manifest) out.push(manifest);

  try {
    const entries = fs.readFileSync(LOG, 'utf8').trim().split('\n')
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
    const others = entries.filter((e) => e.wt !== wt).slice(-12);
    if (others.length) {
      out.push('\nRecent edits by OTHER worktrees:');
      for (const e of others) out.push(`  [${e.wt}] ${e.file} @ ${e.t}`);
    }
  } catch { /* none yet */ }

  if (out.length) {
    console.log(`=== PARALLEL-SESSION COORDINATION (this worktree: ${wt}) ===`);
    console.log(out.join('\n'));
    console.log('=== Read this before editing. Stay in YOUR zone in ACTIVE-WORK.md; declare cross-zone edits there first. ===');
  }
  process.exit(0);
}

process.exit(0);
