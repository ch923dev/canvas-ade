#!/usr/bin/env node
/*
 * Parallel-session coordination hook for Canvas ADE worktrees.
 *
 * Modes (argv[2]):
 *   session-start      : print the shared ACTIVE-WORK board + recent edits by OTHER
 *                        worktrees, PLUS a fetch-backed STALE-BASE banner if this
 *                        worktree is behind origin/main -> injected as context so a
 *                        new session opens knowing what others own AND whether it
 *                        must rebase first.
 *   post-edit          : append {t, wt, file} to the shared edit-log.jsonl after an
 *                        Edit/Write/MultiEdit -> awareness that does NOT depend on the
 *                        agent remembering to self-report.
 *   user-prompt-submit : cheap LOCAL-ONLY check (no network) on every user turn -- if
 *                        HEAD does not contain the current integration tip, prepend a
 *                        one-line "base stale, rebase" nudge. Keeps a session aware
 *                        the moment main advances mid-session.
 *   post-merge         : PRODUCER side. Called by .claude/tools/signal-merge.ps1 after
 *                        a push to origin/main. Writes integration-tip.json (atomic) +
 *                        appends merge-signal.jsonl + syncs the **Auto-tip** line on the
 *                        board. Args: --sha <sha> [--pr <n>] [--subject <s>]
 *                        [--date <yyyy-mm-dd>] [--lockfile <1|0>].
 *
 * TWO-TIER DESIGN (2026-06-13):
 *   Tier 1 (signal)     = integration-tip.json + merge-signal.jsonl, written by the
 *                         merging session (best-effort, informative: PR# + subject).
 *   Tier 2 (self-check) = base-check below compares against the REAL origin/main via
 *                         git fetch + ancestry, so it fires even when Tier 1 was
 *                         skipped ("if send signal is not working ..."). Tier 2 is the
 *                         authority; Tier 1 just makes it louder.
 *
 * IMPORTANT: all shared state lives at the fixed MAIN-repo path below, accessed by
 * absolute path. A file inside a worktree is per-branch and would NOT be shared.
 * This hook is registered per-worktree (project settings.json) so it only ever runs
 * inside a Canvas ADE worktree -- no global gating needed. Every consumer path is
 * wrapped so a git/IO failure NEVER blocks an edit, a prompt, or a session start.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const COORD = 'Z:\\Canvas ADE\\.claude\\coordination';
const MANIFEST = path.join(COORD, 'ACTIVE-WORK.md');
const LOG = path.join(COORD, 'edit-log.jsonl');
const TIP_JSON = path.join(COORD, 'integration-tip.json');
const SIGNAL_LOG = path.join(COORD, 'merge-signal.jsonl');
const FETCH_STAMPS = path.join(COORD, 'fetch-stamps');
const LOG_MAX_BYTES = 80 * 1024; // rotate when larger; keep tail
const FETCH_THROTTLE_MS = 180 * 1000; // at most one fetch / 3 min / worktree

function readStdin() {
  try { return fs.readFileSync(0, 'utf8'); } catch { return ''; }
}
function stamp() {
  return new Date().toISOString().slice(0, 16).replace('T', ' ');
}

// Run a git command in `cwd`, never throw. Returns { status, stdout }.
// status 0 = success; non-zero = git's exit code (e.g. is-ancestor returns 1 when
// not an ancestor, 128 when the object is unknown locally). GIT_TERMINAL_PROMPT=0
// guarantees a missing credential never hangs the hook.
function git(args, cwd, timeout) {
  try {
    const stdout = execFileSync('git', args, {
      cwd,
      timeout: timeout || 8000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: Object.assign({}, process.env, { GIT_TERMINAL_PROMPT: '0' })
    });
    return { status: 0, stdout: (stdout || '').trim() };
  } catch (e) {
    return { status: typeof e.status === 'number' ? e.status : 1, stdout: (e.stdout || '').toString().trim() };
  }
}

function readTip() {
  try {
    const j = JSON.parse(fs.readFileSync(TIP_JSON, 'utf8'));
    if (j && j.sha) return j;
  } catch { /* none yet */ }
  return null;
}

function hooksPathOk(cwd) {
  const r = git(['config', 'core.hooksPath'], cwd, 4000);
  return r.status === 0 && r.stdout === '.githooks';
}

// Tier 2 authority: fetch-backed comparison against the real origin/main.
// Returns banner lines (empty array = fresh / not applicable). Fails open.
function baseCheck(cwd, doFetch, wt) {
  const lines = [];
  const head = git(['rev-parse', 'HEAD'], cwd, 5000);
  if (head.status !== 0) return lines; // not a git repo / odd state -> skip

  if (doFetch) {
    try {
      fs.mkdirSync(FETCH_STAMPS, { recursive: true });
      const stampFile = path.join(FETCH_STAMPS, wt);
      let last = 0;
      try { last = parseInt(fs.readFileSync(stampFile, 'utf8'), 10) || 0; } catch { /* first run */ }
      if (Date.now() - last > FETCH_THROTTLE_MS) {
        const f = git(['fetch', '--quiet', 'origin', 'main'], cwd, 15000);
        if (f.status === 0) { try { fs.writeFileSync(stampFile, String(Date.now())); } catch { /* advisory */ } }
      }
    } catch { /* fetch is best-effort */ }
  }

  const om = git(['rev-parse', '--verify', '--quiet', 'origin/main'], cwd, 5000);
  if (om.status !== 0 || !om.stdout) return lines; // no remote-tracking ref -> skip
  const isAnc = git(['merge-base', '--is-ancestor', 'origin/main', 'HEAD'], cwd, 5000);
  if (isAnc.status === 0) return lines; // HEAD already contains origin/main -> fresh

  const behind = git(['rev-list', '--count', 'HEAD..origin/main'], cwd, 5000).stdout || '?';
  const tip = readTip();
  lines.push('');
  lines.push('================ ⚠️  STALE BASE — REBASE REQUIRED ================');
  lines.push(`This worktree (${wt}) is BEHIND origin/main by ${behind} commit(s).`);
  if (tip) lines.push(`Latest integration tip: ${tip.shaShort} — ${tip.subject}${tip.pr ? ` (PR #${tip.pr}` : ''}${tip.pr ? `, ${tip.date})` : ''}.`);
  lines.push('Rebase BEFORE more work or any push for merge:');
  lines.push('  git fetch origin && git rebase origin/main' + (tip && tip.lockfileTouched ? '   # then: pnpm install && pnpm rebuild  (lockfile changed)' : ''));
  if (!hooksPathOk(cwd)) {
    lines.push('NOTE: core.hooksPath != .githooks — the pre-push gate is BYPASSED here. Fix: git config core.hooksPath .githooks');
  }
  lines.push('=================================================================');
  return lines;
}

// Tier 1 consumer (cheap, no network): does HEAD contain the recorded tip sha?
function promptNudge(cwd) {
  const tip = readTip();
  if (!tip || !tip.sha) return [];
  const head = git(['rev-parse', 'HEAD'], cwd, 4000);
  if (head.status !== 0) return [];
  const isAnc = git(['merge-base', '--is-ancestor', tip.sha, 'HEAD'], cwd, 4000);
  if (isAnc.status === 0) return []; // contains the tip -> fresh, say nothing
  const reason = isAnc.status === 128 ? 'not in your local history (fetch first)' : 'not in your branch';
  return [`⚠️ Base stale: integration tip ${tip.shaShort}${tip.pr ? ` (PR #${tip.pr})` : ''} ${reason} — \`git fetch origin && git rebase origin/main\` before pushing for merge.`];
}

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--sha') o.sha = argv[++i];
    else if (a === '--pr') o.pr = argv[++i];
    else if (a === '--subject') o.subject = argv[++i];
    else if (a === '--date') o.date = argv[++i];
    else if (a === '--lockfile') o.lockfile = argv[++i];
  }
  return o;
}

const mode = process.argv[2];

// Only the event-driven modes receive a JSON payload on stdin. post-merge is invoked
// directly (no piped stdin) -> do NOT read fd 0 there or it can block on a console.
let payload = {};
if (mode === 'session-start' || mode === 'post-edit' || mode === 'user-prompt-submit') {
  try { payload = JSON.parse(readStdin() || '{}'); } catch { payload = {}; }
}
const cwd = String(payload.cwd || process.cwd() || '').replace(/\//g, '\\');
const wt = path.basename(cwd) || 'unknown'; // worktree identity = dir name

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

if (mode === 'user-prompt-submit') {
  try {
    const nudge = promptNudge(cwd);
    if (nudge.length) console.log(nudge.join('\n'));
  } catch { /* never block a prompt */ }
  process.exit(0);
}

if (mode === 'session-start') {
  // Lead with the stale-base banner (Tier 2) so it is not buried under the long board.
  try {
    const base = baseCheck(cwd, true, wt);
    if (base.length) console.log(base.join('\n'));
  } catch { /* never block session start */ }

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

if (mode === 'post-merge') {
  const a = parseArgs(process.argv.slice(3));
  const sha = String(a.sha || '').trim();
  if (!sha) { console.error('[signal-merge] ERROR: --sha is required'); process.exit(2); }
  const shaShort = sha.slice(0, 7);
  const subject = String(a.subject || '').trim() || '(no subject)';
  const pr = a.pr ? String(a.pr).replace(/^#/, '').trim() : '';
  const prNum = pr ? Number(pr) : null;
  // Render the PR as a suffix, and only when the subject doesn't already mention it
  // (commit subjects routinely carry `#NNN` or `(#NNN)`) — avoids "#136 #136 ...".
  const prSuffix = (pr && !new RegExp('#' + pr + '\\b').test(subject)) ? ` (PR #${pr})` : '';
  const date = String(a.date || '').trim() || stamp().slice(0, 10);
  const lockfileTouched = /^(1|true|yes)$/i.test(String(a.lockfile || ''));

  const tipObj = { sha, shaShort, subject, pr: prNum, date, lockfileTouched, updatedBy: wt, ts: stamp() };
  try {
    fs.mkdirSync(COORD, { recursive: true });
    const tmp = TIP_JSON + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(tipObj, null, 2) + '\n');
    fs.renameSync(tmp, TIP_JSON); // atomic single source of truth
    fs.appendFileSync(SIGNAL_LOG, JSON.stringify({ t: stamp(), wt, sha, pr: prNum, subject }) + '\n');
  } catch (e) {
    console.error(`[signal-merge] ERROR writing signal files: ${e && e.message}`);
    process.exit(1);
  }

  // Sync the single machine-owned **Auto-tip** line on the board; the human narrative
  // paragraph below it stays untouched (we only ever rewrite this one anchored line).
  try {
    let md = fs.readFileSync(MANIFEST, 'utf8');
    const autoLine = `**Auto-tip:** \`origin/main\` @ \`${shaShort}\` — ${subject}${prSuffix} · ${date} · machine-synced with \`integration-tip.json\`.`;
    if (/^\*\*Auto-tip:\*\* .*$/m.test(md)) {
      md = md.replace(/^\*\*Auto-tip:\*\* .*$/m, autoLine);
    } else if (/^## Integration tip[^\n]*\n/m.test(md)) {
      md = md.replace(/(^## Integration tip[^\n]*\n)/m, `$1\n${autoLine}\n`);
    }
    fs.writeFileSync(MANIFEST, md);
  } catch { /* board update is best-effort; integration-tip.json is the authority */ }

  console.log(`[signal-merge] origin/main → ${shaShort} (${subject}${prSuffix}).`);
  console.log('[signal-merge] integration-tip.json + merge-signal.jsonl written; Auto-tip line synced.');
  console.log('[signal-merge] Other sessions get a STALE-BASE banner at their next prompt / session start, and a hard gate on push-to-main.');
  process.exit(0);
}

process.exit(0);
