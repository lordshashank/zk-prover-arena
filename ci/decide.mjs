// zk-prover-arena — decide: combine per-environment grading results into one
// acceptance decision and one bot commit (the dual-board half of promote.mjs).
//
// The submission graded on each environment by `promote.mjs --grade-only`:
//   arm64 (canonical): absolute seconds — homogeneous Cobalt fleet
//   x86   (Aztec's perf ISA): mixed EPYC/Xeon fleet, so the candidate is scored as a
//         RATIO to a baseline graded in the same job on the same VM (time only;
//         peak RSS is hardware-insensitive and stays absolute)
//
// Acceptance: win ANY board beyond its noise margin —
//   arm64 time : median < bestTime − max(0.5 s, 2σ)
//   arm64 mem  : peak   < bestPeak − 75 MiB
//   x86 time   : ratio  < bestRatio − max(0.015, 2σ_ratio)   σ_ratio via quadrature
//   x86 mem    : peak   < bestPeak − 75 MiB
// x86 validity: gates pass AND (time row: peak ≤ 4096 MiB; mem row: ratio ≤ 2.0 —
// the same cross-budget semantics as arm64, expressed relative to the same-VM baseline).
//
// A missing/failed environment contributes no win but doesn't block the other.
// On accept: boards rows (both envs; x86 gets baseline+candidate rows — the same-VM
// pair), transcripts, append-only log.jsonl, LEADERBOARD.md, one bot commit.
//
// Usage:
//   node ci/decide.mjs --sub=submissions/incoming/<name> \
//     [--arm64=grade.json --arm64-transcript=t.log] \
//     [--x86-base=base.json --x86-cand=cand.json --x86-transcript=t.log]
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync, appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname, join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASE_COMMIT, loadSubmission, readBests } from '../intake.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const args = Object.fromEntries(process.argv.slice(2).map((s) => {
  const i = s.indexOf('='); return i === -1 ? [s.replace(/^--/, ''), '1'] : [s.slice(2, i), s.slice(i + 1)];
}));
const log = (...a) => console.error('  [decide]', ...a);

const TIME_MARGIN_FLOOR_S = 0.5;
const MEM_MARGIN_MIB = 75;
const X86_RATIO_FLOOR = 0.015;
const X86_TIME_RATIO_BUDGET = 2.0;
const TIME_BOARD_MEM_BUDGET_MIB = 4096;

const loadJson = (p) => { try { return p && existsSync(resolve(p)) ? JSON.parse(readFileSync(resolve(p), 'utf8')) : null; } catch { return null; } };
const sampleSigma = (xs) => {
  if (!xs || xs.length < 2) return 0;
  const mu = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, x) => a + (x - mu) ** 2, 0) / (xs.length - 1));
};
const gatesPass = (j) => j && j.gates && j.gates.complete && j.gates.soundness && j.gates.freshOutput && j.gates.singleThread && j.gates.disk;

function readBestsX86() {
  const bestOf = (file, key) => {
    const p = resolve(ROOT, 'boards', 'x86', file);
    if (!existsSync(p)) return null;
    const lines = readFileSync(p, 'utf8').trim().split('\n');
    const head = lines[0].split('\t');
    let best = null;
    for (const l of lines.slice(1)) {
      const r = Object.fromEntries(l.split('\t').map((v, i) => [head[i], v]));
      if (r.valid !== '1' || r.stack === 'baseline') continue; // baseline rows are same-VM anchors, not contenders
      const v = parseFloat(r[key]);
      if (Number.isFinite(v) && (best == null || v < best.value)) best = { value: v, stack: r.stack };
    }
    return best;
  };
  return { ratio: bestOf('time.tsv', 'ratio'), peak: bestOf('memory.tsv', 'peak_rss_MiB') };
}

function appendRow(file, header, row) {
  const p = resolve(ROOT, 'boards', file);
  mkdirSync(dirname(p), { recursive: true });
  if (!existsSync(p)) appendFileSync(p, header.join('\t') + '\n');
  appendFileSync(p, row.join('\t') + '\n');
}

// ---- load inputs ----
const { sub, dir: subDir } = loadSubmission(args.sub || (() => { throw new Error('--sub required'); })());
const arm = loadJson(args.arm64);
const x86b = loadJson(args['x86-base']);
const x86c = loadJson(args['x86-cand']);
log(`submission "${sub.name}": arm64=${arm ? 'present' : 'MISSING'} x86=${x86b && x86c ? 'present' : 'MISSING'}`);

// ---- arm64 verdict (absolute, vs canonical boards) ----
let armV = null;
if (arm) {
  const bests = readBests();
  const sigma = arm.sigma ?? sampleSigma(arm.runs?.map((r) => r.proveS));
  const timeMargin = Math.max(TIME_MARGIN_FLOOR_S, 2 * sigma);
  const bestT = bests.time?.value ?? Infinity;
  const bestM = bests.memory?.value ?? Infinity;
  armV = {
    timeS: arm.medianS, peakMiB: arm.peakMiB, sigma: +sigma.toFixed(3), machine: arm.machine ?? null,
    gates: gatesPass(arm), timeBoardValid: !!arm.timeBoardValid, memBoardValid: !!arm.memBoardValid,
    timeWin: !!arm.timeBoardValid && arm.medianS != null && arm.medianS < bestT - timeMargin,
    memWin: !!arm.memBoardValid && arm.peakMiB != null && arm.peakMiB < bestM - MEM_MARGIN_MIB,
    bests: { timeS: isFinite(bestT) ? bestT : null, peakMiB: isFinite(bestM) ? bestM : null },
    margins: { timeS: +timeMargin.toFixed(3), memMiB: MEM_MARGIN_MIB },
  };
  log(`arm64: ${arm.medianS}s/${arm.peakMiB}MiB sigma=${sigma.toFixed(3)} -> timeWin=${armV.timeWin} memWin=${armV.memWin}`);
}

// ---- x86 verdict (ratio vs same-VM baseline, vs x86 boards) ----
let x86V = null;
if (x86b && x86c && x86b.medianS && x86c.medianS != null) {
  const bests = readBestsX86();
  const sb = sampleSigma(x86b.runs?.map((r) => r.proveS));
  const sc = x86c.sigma ?? sampleSigma(x86c.runs?.map((r) => r.proveS));
  const ratio = x86c.medianS / x86b.medianS;
  const sigmaRatio = Math.sqrt(sb * sb + sc * sc) / x86b.medianS;
  const ratioMargin = Math.max(X86_RATIO_FLOOR, 2 * sigmaRatio);
  const candGates = gatesPass(x86c);
  const timeBoardValid = candGates && x86c.peakMiB != null && x86c.peakMiB <= TIME_BOARD_MEM_BUDGET_MIB;
  const memBoardValid = candGates && ratio <= X86_TIME_RATIO_BUDGET;
  const bestR = bests.ratio?.value ?? Infinity;
  const bestM = bests.peak?.value ?? Infinity;
  x86V = {
    ratio: +ratio.toFixed(4), timeS: x86c.medianS, baseTimeS: x86b.medianS,
    peakMiB: x86c.peakMiB, basePeakMiB: x86b.peakMiB, sigmaRatio: +sigmaRatio.toFixed(4),
    machine: x86c.machine ?? null, gates: candGates, baseGates: gatesPass(x86b),
    timeBoardValid, memBoardValid,
    timeWin: timeBoardValid && ratio < bestR - ratioMargin,
    memWin: memBoardValid && x86c.peakMiB != null && x86c.peakMiB < bestM - MEM_MARGIN_MIB,
    bests: { ratio: isFinite(bestR) ? bestR : null, peakMiB: isFinite(bestM) ? bestM : null },
    margins: { ratio: +ratioMargin.toFixed(4), memMiB: MEM_MARGIN_MIB },
  };
  log(`x86: ratio=${ratio.toFixed(4)} (${x86c.medianS}s vs base ${x86b.medianS}s on ${x86c.machine}) peak=${x86c.peakMiB}MiB -> timeWin=${x86V.timeWin} memWin=${x86V.memWin}`);
}

const accepted = !!(armV?.timeWin || armV?.memWin || x86V?.timeWin || x86V?.memWin);
const verdictBase = { name: sub.name, author: sub.author, model: sub.model, arm64: armV, x86: x86V, baseCommit: BASE_COMMIT };
if (!accepted) {
  console.log(JSON.stringify({ status: 'rejected', reason: armV || x86V ? 'no board win beyond noise margin' : 'no environment produced a grading result', ...verdictBase }, null, 2));
  process.exit(1);
}

// ---- accept: rows + transcripts + log + leaderboard + bot commit ----
const ts = new Date().toISOString();
const tsSafe = ts.replace(/[:.]/g, '-');
const transcripts = [];
mkdirSync(resolve(ROOT, 'submissions', 'transcripts'), { recursive: true });
for (const [envName, p] of [['arm64', args['arm64-transcript']], ['x64', args['x86-transcript']]]) {
  if (p && existsSync(resolve(p))) {
    const rel = join('submissions', 'transcripts', `${sub.name}-${tsSafe}-${envName}.log`);
    writeFileSync(resolve(ROOT, rel), readFileSync(resolve(p)));
    transcripts.push(rel);
  }
}

const HEAD_T = ['iso', 'stack', 'task', 'median_prove_s', 'peak_rss_MiB', 'verified', 'valid', 'note', 'machine'];
const HEAD_M = ['iso', 'stack', 'task', 'peak_rss_MiB', 'median_prove_s', 'verified', 'valid', 'note', 'machine'];
if (arm) {
  appendRow('time.tsv', HEAD_T, [arm.iso, sub.name, arm.task, arm.medianS ?? '', arm.peakMiB ?? '', arm.gates?.soundness ? 1 : 0, arm.timeBoardValid ? 1 : 0, arm.note || '', arm.machine || '']);
  appendRow('memory.tsv', HEAD_M, [arm.iso, sub.name, arm.task, arm.peakMiB ?? '', arm.medianS ?? '', arm.gates?.soundness ? 1 : 0, arm.memBoardValid ? 1 : 0, arm.note || '', arm.machine || '']);
}
const HEAD_XT = ['iso', 'stack', 'task', 'ratio', 'median_prove_s', 'baseline_median_s', 'peak_rss_MiB', 'verified', 'valid', 'note', 'machine'];
const HEAD_XM = ['iso', 'stack', 'task', 'peak_rss_MiB', 'baseline_peak_MiB', 'time_ratio', 'median_prove_s', 'verified', 'valid', 'note', 'machine'];
if (x86V) {
  const bV = x86V.baseGates ? 1 : 0;
  appendRow('x86/time.tsv', HEAD_XT, [x86b.iso, 'baseline', x86b.task, '1.0000', x86b.medianS, x86b.medianS, x86b.peakMiB ?? '', bV, bV, x86b.note || '', x86b.machine || '']);
  appendRow('x86/time.tsv', HEAD_XT, [x86c.iso, sub.name, x86c.task, x86V.ratio, x86c.medianS, x86b.medianS, x86c.peakMiB ?? '', x86c.gates?.soundness ? 1 : 0, x86V.timeBoardValid ? 1 : 0, x86c.note || '', x86c.machine || '']);
  appendRow('x86/memory.tsv', HEAD_XM, [x86b.iso, 'baseline', x86b.task, x86b.peakMiB ?? '', x86b.peakMiB ?? '', '1.0000', x86b.medianS, bV, bV, x86b.note || '', x86b.machine || '']);
  appendRow('x86/memory.tsv', HEAD_XM, [x86c.iso, sub.name, x86c.task, x86c.peakMiB ?? '', x86b.peakMiB ?? '', x86V.ratio, x86c.medianS, x86c.gates?.soundness ? 1 : 0, x86V.memBoardValid ? 1 : 0, x86c.note || '', x86c.machine || '']);
}

const logRow = {
  ts, name: sub.name, author: sub.author, model: sub.model,
  claimed: { timeS: sub.claimedTimeS, peakMiB: sub.claimedPeakMiB },
  arm64: armV, x86: x86V, baseCommit: BASE_COMMIT, transcripts,
};
appendFileSync(resolve(ROOT, 'submissions', 'log.jsonl'), JSON.stringify(logRow) + '\n');
spawnSync(process.execPath, [resolve(ROOT, 'board.mjs'), '--md'], { encoding: 'utf8' });

const toAdd = ['boards', 'LEADERBOARD.md', 'submissions/log.jsonl', ...transcripts];
const subRel = relative(ROOT, resolve(subDir));
if (!subRel.startsWith('..') && !isAbsolute(subRel)) toAdd.push(subRel);
spawnSync('git', ['-C', ROOT, 'add', ...toAdd], { encoding: 'utf8' });
const summary = [
  armV ? `arm64 ${armV.timeS}s/${armV.peakMiB}MiB` : 'arm64 n/a',
  x86V ? `x86 ratio ${x86V.ratio} (${x86V.timeS}s, ${x86V.peakMiB}MiB)` : 'x86 n/a',
].join(', ');
const commit = spawnSync('git', ['-C', ROOT, 'commit',
  '-m', `Accept submission ${sub.name}: ${summary}`,
  '-m', `Co-authored-by: ${sub.author} <${sub.author}@users.noreply.github.com>`,
], { encoding: 'utf8' });
if (commit.status !== 0) log(`WARNING: git commit failed: ${(commit.stderr || commit.stdout || '').slice(-300)}`);
else log(commit.stdout.trim().split('\n')[0]);

console.log(JSON.stringify({ status: 'accepted', ts, ...verdictBase, transcripts, committed: commit.status === 0 }, null, 2));
