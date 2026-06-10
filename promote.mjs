// zk-prover-arena — promote: the full submission pipeline on the CANONICAL machine.
//
// Modeled on bot-promoted monotone audit trails (ecdsa.fail/Yukon), adapted for a
// noisy wall-clock metric: acceptance is margin-based (see submissions/SPEC.md), the
// boards only ever gain rows (accepted submissions + maintainer reference runs), and
// every acceptance is a single bot commit carrying the full grader transcript.
//
// Pipeline:  intake checks -> scratch worktree of pinned base -> git apply -> cmake
// configure+build (streamed) -> grade.mjs --runs=5 --json (isolated boards dir, process
// group killed on timeout) -> noise-margin acceptance rule -> on accept: append boards
// rows + submissions/log.jsonl, save transcript, regen LEADERBOARD.md, bot git commit.
// On rejection/failure: JSON verdict, nothing touches the canonical boards. Scratch
// worktrees are always removed.
//
// Usage:
//   node promote.mjs <submission-dir>             full pipeline
//   node promote.mjs <submission-dir> --dry-run   stop after cmake configure (no build/grade/boards)
//   node promote.mjs --regrade-champion           re-grade baseline, warn on >10% drift vs trailing median
//   env: BB_REPO, BB_BUILD_PRESET (homebrew), BREW_PREFIX (/opt/homebrew), BASELINE_BB, NARGO_BIN
//
// stdout carries exactly one JSON verdict; all progress/build/grader output streams to stderr.
// Known limitation (documented, not enforced): the build step has network access and no
// syscall sandbox — patches are human-reviewed PRs; see submissions/SPEC.md trust model.
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, existsSync, appendFileSync, mkdirSync, rmSync, writeFileSync, mkdtempSync } from 'node:fs';
import { resolve, dirname, join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import {
  BASE_COMMIT, BB_REPO, Reject,
  loadSubmission, checkPatchPaths, readBests, checkClaims,
  addScratchWorktree, removeScratchWorktree, applyCheck,
} from './intake.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).filter((s) => s.startsWith('--')).map((s) => {
  const i = s.indexOf('='); return i === -1 ? [s.slice(2), '1'] : [s.slice(2, i), s.slice(i + 1)];
}));
const positional = process.argv.slice(2).filter((s) => !s.startsWith('--'));

const DRY = 'dry-run' in args;
const RUNS = args.runs ? parseInt(args.runs) : 5;
const RUN_TIMEOUT_S = args['run-timeout'] ? parseInt(args['run-timeout']) : 600; // per graded run
const BUILD_TIMEOUT_S = 3600;
const PRESET = process.env.BB_BUILD_PRESET || (process.platform === 'darwin' ? 'homebrew' : 'default');
const BREW_PREFIX = process.env.BREW_PREFIX || '/opt/homebrew';
const TIME_MARGIN_FLOOR_S = 0.5;
const MEM_MARGIN_MIB = 75;
const DRIFT_WARN = 0.10;

const log = (...a) => console.error('  [promote]', ...a);

// Streamed subprocess in its own process group; on timeout the WHOLE group is killed
// (bb children included). Output is teed to stderr live (anti-stall) and captured.
function sh(cmd, argv, { cwd, env, timeoutS, label } = {}) {
  return new Promise((res) => {
    log(`$ ${cmd} ${argv.join(' ')}${cwd ? `  (cwd ${cwd})` : ''}`);
    const child = spawn(cmd, argv, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let timedOut = false;
    const tee = (chunk) => { const s = chunk.toString(); out += s; process.stderr.write(s); };
    child.stdout.on('data', tee);
    child.stderr.on('data', tee);
    const timer = timeoutS ? setTimeout(() => {
      timedOut = true;
      log(`TIMEOUT after ${timeoutS}s — killing process group of ${label || cmd}`);
      try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } }
    }, timeoutS * 1000) : null;
    child.on('error', (e) => { if (timer) clearTimeout(timer); res({ status: -1, out: out + String(e), timedOut }); });
    child.on('close', (code) => { if (timer) clearTimeout(timer); res({ status: code, out, timedOut }); });
  });
}

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const sampleSigma = (xs) => {
  if (xs.length < 2) return 0;
  const mu = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, x) => a + (x - mu) ** 2, 0) / (xs.length - 1));
};

function runGrade(stack, bbPath, { boardsDir, jsonPath, runs }) {
  return sh(process.execPath, [
    resolve(__dirname, 'grade.mjs'),
    `--stack=${stack}`, ...(bbPath ? [`--bb=${bbPath}`] : []), `--runs=${runs}`,
    `--json=${jsonPath}`, ...(boardsDir ? [`--boards=${boardsDir}`] : []),
  ], { env: process.env, timeoutS: RUN_TIMEOUT_S * runs + 300, label: 'grade.mjs' });
}

// ---- mode: --regrade-champion (baseline drift watch; see SPEC.md) ----
function trailingBaselineMedian(n = 5) {
  const p = resolve(__dirname, 'boards', 'time.tsv');
  if (!existsSync(p)) return null;
  const lines = readFileSync(p, 'utf8').trim().split('\n');
  const head = lines[0].split('\t');
  const vals = lines.slice(1)
    .map((l) => Object.fromEntries(l.split('\t').map((v, i) => [head[i], v])))
    .filter((r) => r.stack === 'baseline' && r.valid === '1')
    .map((r) => parseFloat(r.median_prove_s))
    .filter(Number.isFinite)
    .slice(-n);
  return vals.length ? median(vals) : null;
}

async function regradeChampion() {
  const trailing = trailingBaselineMedian();
  if (trailing == null) return { verdict: { status: 'error', reason: 'no valid baseline rows in boards/time.tsv to compare against' }, code: 2 };
  if (DRY) return { verdict: { status: 'dry-run', mode: 'regrade-champion', trailingMedianS: trailing, note: `would re-grade baseline with --runs=${RUNS} and warn if median deviates >${DRIFT_WARN * 100}%` }, code: 0 };
  const jsonPath = join(mkdtempSync(join(tmpdir(), 'zkarena-regrade-')), 'grade.json');
  const g = await runGrade('baseline', null, { jsonPath, runs: RUNS }); // canonical boards on purpose: baseline reference rows
  if (g.status !== 0 || !existsSync(jsonPath)) return { verdict: { status: 'failed', reason: 'grade', detail: g.timedOut ? 'timeout' : `grade.mjs exit ${g.status}` }, code: 1 };
  const res = JSON.parse(readFileSync(jsonPath, 'utf8'));
  const drift = Math.abs(res.medianS / trailing - 1);
  const exceeded = drift > DRIFT_WARN;
  if (exceeded) log(`WARNING: baseline drifted ${(drift * 100).toFixed(1)}% from trailing median ${trailing}s — machine calibration moved; re-examine bests/margins before promoting`);
  spawnSync(process.execPath, [resolve(__dirname, 'board.mjs'), '--md'], { encoding: 'utf8' });
  return {
    verdict: { status: 'regraded', stack: 'baseline', medianS: res.medianS, peakMiB: res.peakMiB, trailingMedianS: trailing, driftPct: +(drift * 100).toFixed(1), driftExceeded: exceeded },
    code: exceeded ? 1 : 0,
  };
}

// ---- mode: promote a submission ----
async function promote(dir) {
  // 1. intake (cheap checks here; apply-check happens in OUR worktree below — one checkout, not two)
  const { sub, patchPath, patchText } = loadSubmission(dir);
  log(`submission "${sub.name}" by @${sub.author} (model: ${sub.model})`);
  const { touched } = checkPatchPaths(patchText);
  const bests = readBests(); // read BEFORE grading — these are the numbers to beat
  checkClaims(sub, bests);
  log(`intake checks pass (${touched.length} files, claims ${sub.claimedTimeS}s/${sub.claimedPeakMiB}MiB vs bests ${bests.time?.value ?? '—'}s/${bests.memory?.value ?? '—'}MiB)`);

  let wt = null;
  const scratch = mkdtempSync(join(tmpdir(), 'zkarena-promote-'));
  try {
    // 2. scratch worktree + apply
    wt = addScratchWorktree('promote');
    applyCheck(wt, patchPath);
    const ap = spawnSync('git', ['-C', wt, 'apply', '--whitespace=nowarn', patchPath], { encoding: 'utf8' });
    if (ap.status !== 0) throw new Reject(`git apply failed after --check passed: ${(ap.stderr || '').slice(-400)}`);
    log('patch applied to pinned base');

    // 3. configure + build (streamed; fail-closed)
    const cpp = join(wt, 'barretenberg', 'cpp');
    const buildEnv = { ...process.env, BREW_PREFIX };
    const extraCmake = (process.env.BB_CMAKE_ARGS || '').split(' ').filter(Boolean); // e.g. -DBB_LITE=ON on CI
    const conf = await sh('cmake', ['--preset', PRESET, ...extraCmake], { cwd: cpp, env: buildEnv, timeoutS: 900, label: 'cmake configure' });
    if (conf.status !== 0) return { verdict: { status: 'failed', reason: 'build', stage: 'configure', detail: conf.out.slice(-800) }, code: 1 };
    if (DRY) {
      log('dry-run: stopping after build-config check (no build, no grade, boards untouched)');
      return { verdict: { status: 'dry-run', name: sub.name, intake: 'ok', appliesClean: true, configured: true, preset: PRESET, baseCommit: BASE_COMMIT, note: 'stopped after cmake configure; full path continues: build -> grade --runs=5 -> acceptance rule' }, code: 0 };
    }
    const build = await sh('cmake', ['--build', '--preset', PRESET, '--target', 'bb'], { cwd: cpp, env: buildEnv, timeoutS: BUILD_TIMEOUT_S, label: 'cmake build' });
    if (build.status !== 0) return { verdict: { status: 'failed', reason: 'build', stage: 'compile', detail: build.out.slice(-800) }, code: 1 };
    const bbPath = join(cpp, 'build', 'bin', 'bb');
    if (!existsSync(bbPath)) return { verdict: { status: 'failed', reason: 'build', stage: 'compile', detail: 'build succeeded but bin/bb missing' }, code: 1 };

    // 4. grade with isolated boards dir (canonical boards gain rows ONLY on acceptance)
    const boardsDir = join(scratch, 'boards');
    const jsonPath = join(scratch, 'grade.json');
    const g = await runGrade(sub.name, bbPath, { boardsDir, jsonPath, runs: RUNS });
    if (g.status !== 0 || !existsSync(jsonPath)) {
      return { verdict: { status: 'failed', reason: 'grade', detail: g.timedOut ? `timeout (${RUN_TIMEOUT_S}s/run budget exceeded; process group killed)` : `grade.mjs exit ${g.status}`, tail: g.out.slice(-800) }, code: 1 };
    }
    const res = JSON.parse(readFileSync(jsonPath, 'utf8'));

    // 5. acceptance rule (see submissions/SPEC.md): margin = max(0.5s, 2*sigma) | 75 MiB
    const sigma = sampleSigma(res.runs.map((r) => r.proveS));
    const timeMargin = Math.max(TIME_MARGIN_FLOOR_S, 2 * sigma);
    const bestT = bests.time?.value ?? Infinity;
    const bestM = bests.memory?.value ?? Infinity;
    const timeWin = res.timeBoardValid && res.medianS != null && res.medianS < bestT - timeMargin;
    const memWin = res.memBoardValid && res.peakMiB != null && res.peakMiB < bestM - MEM_MARGIN_MIB;
    const official = { timeS: res.medianS, peakMiB: res.peakMiB, timeBoardValid: res.timeBoardValid, memBoardValid: res.memBoardValid, gates: res.gates };
    const margins = { timeS: +timeMargin.toFixed(3), memMiB: MEM_MARGIN_MIB, sigmaS: +sigma.toFixed(3) };
    log(`official ${res.medianS}s/${res.peakMiB}MiB  sigma=${sigma.toFixed(3)}s  need < ${isFinite(bestT) ? (bestT - timeMargin).toFixed(2) : 'any'}s or < ${isFinite(bestM) ? (bestM - MEM_MARGIN_MIB).toFixed(0) : 'any'}MiB  -> timeWin=${timeWin} memWin=${memWin}`);

    // --grade-only: emit measurements + transcript and stop — acceptance and the bot
    // commit belong to a separate decider (ci/decide.mjs combines multiple environments).
    if ('grade-only' in args) {
      if (args['grade-out']) writeFileSync(resolve(args['grade-out']), JSON.stringify({ ...res, sigma: +sigma.toFixed(3) }, null, 2) + '\n');
      if (args['transcript-out']) writeFileSync(resolve(args['transcript-out']), g.out);
      return { verdict: { status: 'graded', name: sub.name, official, sigma: +sigma.toFixed(3), margins, baseCommit: BASE_COMMIT, machine: res.machine ?? null }, code: 0 };
    }

    if (!res.gates.complete || !res.gates.soundness || !res.gates.freshOutput || !res.gates.singleThread || !res.gates.disk) {
      return { verdict: { status: 'rejected', reason: 'gates', official, detail: res.error || 'one or more validity gates failed — see transcript on stderr' }, code: 1 };
    }
    if (!timeWin && !memWin) {
      return { verdict: { status: 'rejected', reason: 'noise-margin', official, bests: { timeS: isFinite(bestT) ? bestT : null, peakMiB: isFinite(bestM) ? bestM : null }, margins }, code: 1 };
    }

    // 6. ACCEPT — monotone audit trail, one bot commit
    const ts = new Date().toISOString();
    const tsSafe = ts.replace(/[:.]/g, '-');
    const transcriptRel = join('submissions', 'transcripts', `${sub.name}-${tsSafe}.log`);
    mkdirSync(resolve(__dirname, 'submissions', 'transcripts'), { recursive: true });
    writeFileSync(resolve(__dirname, transcriptRel), g.out);

    for (const f of ['time.tsv', 'memory.tsv']) { // copy the grader's own rows into the canonical boards
      const src = readFileSync(join(boardsDir, f), 'utf8').trim().split('\n');
      const dst = resolve(__dirname, 'boards', f);
      if (!existsSync(dst)) appendFileSync(dst, src[0] + '\n');
      appendFileSync(dst, src.slice(1).join('\n') + '\n');
    }

    const logRow = {
      ts, name: sub.name, author: sub.author, model: sub.model,
      claimed: { timeS: sub.claimedTimeS, peakMiB: sub.claimedPeakMiB },
      official: { timeS: res.medianS, peakMiB: res.peakMiB, timeWin, memWin },
      sigma: +sigma.toFixed(3), baseCommit: BASE_COMMIT, machine: res.machine ?? null, gradeTranscriptPath: transcriptRel,
    };
    appendFileSync(resolve(__dirname, 'submissions', 'log.jsonl'), JSON.stringify(logRow) + '\n');
    spawnSync(process.execPath, [resolve(__dirname, 'board.mjs'), '--md'], { encoding: 'utf8' });

    const toAdd = ['boards/time.tsv', 'boards/memory.tsv', 'LEADERBOARD.md', 'submissions/log.jsonl', transcriptRel];
    const subRel = relative(__dirname, resolve(dir));
    if (!subRel.startsWith('..') && !isAbsolute(subRel)) toAdd.push(subRel); // include the submission dir when it lives in this repo
    spawnSync('git', ['-C', __dirname, 'add', ...toAdd], { encoding: 'utf8' });
    const commit = spawnSync('git', ['-C', __dirname, 'commit',
      '-m', `Accept submission ${sub.name}: ${res.medianS}s / ${res.peakMiB}MiB`,
      '-m', `Co-authored-by: ${sub.author} <${sub.author}@users.noreply.github.com>`,
    ], { encoding: 'utf8' });
    if (commit.status !== 0) log(`WARNING: git commit failed (working tree state?): ${(commit.stderr || commit.stdout || '').slice(-300)}`);
    else log(commit.stdout.trim().split('\n')[0]);

    return { verdict: { status: 'accepted', ...logRow, margins, committed: commit.status === 0 }, code: 0 };
  } finally {
    removeScratchWorktree(wt);
    rmSync(scratch, { recursive: true, force: true });
  }
}

// ---- entry ----
let result;
try {
  if ('regrade-champion' in args) result = await regradeChampion();
  else if (positional.length === 1) result = await promote(positional[0]);
  else result = { verdict: { status: 'error', reason: 'usage: node promote.mjs <submission-dir> [--dry-run] [--runs=N] | node promote.mjs --regrade-champion [--dry-run]' }, code: 2 };
} catch (e) {
  result = e instanceof Reject
    ? { verdict: { status: 'rejected', reason: e.reason }, code: 1 }
    : { verdict: { status: 'error', reason: String(e?.stack || e) }, code: 2 };
}
console.log(JSON.stringify(result.verdict, null, 2));
process.exit(result.code);
