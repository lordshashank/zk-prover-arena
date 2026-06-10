// zk-prover-arena — intake: validate a submission directory BEFORE any compute is spent.
//
// A submission is a directory with submission.json + a patch file (see submissions/SPEC.md).
// Checks, in order (all mechanical, fail-closed):
//   1. schema        — required fields, types, name/author syntax, notes <= 10KiB
//   2. patch policy  — touched paths parsed from diff headers must live under
//                      barretenberg/cpp/src/barretenberg/** and must not be cmake
//                      presets/toolchains/flags files; no binary diffs; no symlinks
//   3. claimed-score pre-filter — claims strictly worse than the current best on BOTH
//                      boards (valid rows of boards/*.tsv) are rejected: a submission
//                      must claim to improve (or at least match) one board
//   4. apply check   — `git apply --check` in a scratch worktree of the pinned base
//                      commit (BB_REPO env overrides the repo; worktree always removed)
//
// Usage:   node intake.mjs <submission-dir>
// Output:  one JSON verdict on stdout ({status:"ok",...} exit 0 | {status:"rejected",reason} exit 1);
//          progress goes to stderr. promote.mjs imports the helpers below.
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync, statSync, rmSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));

export const BASE_COMMIT = '7e94c2c0e32820e25e20d39a426d546dae56a34f';
export const BB_REPO = process.env.BB_REPO || '/Users/lordforever/dev/redactedchat/bb-next';
export const ALLOWED_PREFIX = 'barretenberg/cpp/src/barretenberg/';

export class Reject extends Error {
  constructor(reason) { super(reason); this.reason = reason; }
}

const log = (...a) => console.error('  [intake]', ...a);

// ---- 1. schema ----
export function loadSubmission(dir) {
  const sdir = resolve(dir);
  if (!existsSync(sdir) || !statSync(sdir).isDirectory()) throw new Reject(`not a directory: ${sdir}`);
  const mPath = join(sdir, 'submission.json');
  if (!existsSync(mPath)) throw new Reject('missing submission.json');
  let sub;
  try { sub = JSON.parse(readFileSync(mPath, 'utf8')); }
  catch (e) { throw new Reject(`submission.json is not valid JSON: ${e.message}`); }

  const isStr = (v) => typeof v === 'string';
  const isNum = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;
  if (!isStr(sub.name) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(sub.name)) throw new Reject('name: required, [A-Za-z0-9][A-Za-z0-9._-]{0,63} (no spaces/tabs)');
  if (sub.name === 'baseline') throw new Reject('name: "baseline" is reserved');
  if (!isStr(sub.author) || !/^[A-Za-z0-9](?:-?[A-Za-z0-9]){0,38}$/.test(sub.author)) throw new Reject('author: required, a GitHub handle');
  if (!isStr(sub.model) || !sub.model.trim() || sub.model.length > 200) throw new Reject('model: required — the AI model used, or "human"');
  if (!isStr(sub.notes) || Buffer.byteLength(sub.notes, 'utf8') > 10 * 1024) throw new Reject('notes: required string, markdown <= 10KiB');
  if (!isNum(sub.claimedTimeS)) throw new Reject('claimedTimeS: required positive number (your local median prove seconds)');
  if (!isNum(sub.claimedPeakMiB)) throw new Reject('claimedPeakMiB: required positive number (your local peak RSS in MiB)');
  if (!isStr(sub.patch) || sub.patch.includes('/') || sub.patch.includes('\\') || sub.patch.includes('..')) throw new Reject('patch: required plain filename inside the submission dir');

  const patchPath = join(sdir, sub.patch);
  if (!existsSync(patchPath)) throw new Reject(`patch file not found: ${sub.patch}`);
  const size = statSync(patchPath).size;
  if (size === 0) throw new Reject('patch file is empty');
  if (size > 10 * 1024 * 1024) throw new Reject('patch file > 10MiB');
  return { sub, dir: sdir, patchPath, patchText: readFileSync(patchPath, 'utf8') };
}

// ---- 2. patch policy (parse diff headers; never trust the patch body) ----
export function checkPatchPaths(patchText) {
  if (/^GIT binary patch/m.test(patchText) || /^Binary files .* differ/m.test(patchText)) throw new Reject('binary diffs are not allowed (source-only submissions)');
  if (/^(old|new) mode 120000/m.test(patchText)) throw new Reject('symlink creation/modification is not allowed');

  const touched = new Set();
  for (const line of patchText.split('\n')) {
    if (!line.startsWith('diff --git ')) continue;
    if (line.includes('"')) throw new Reject(`quoted/escaped paths are not allowed: ${line}`);
    const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (!m) throw new Reject(`unparseable diff header: ${line}`);
    touched.add(m[1]); touched.add(m[2]);
  }
  if (touched.size === 0) throw new Reject('patch contains no file diffs');

  for (const p of touched) {
    if (p.split('/').some((seg) => seg === '..' || seg === '')) throw new Reject(`path traversal in patch: ${p}`);
    if (!p.startsWith(ALLOWED_PREFIX)) throw new Reject(`path outside editable tree (${ALLOWED_PREFIX}**): ${p}`);
    if (/(^|\/)CMakePresets\.json$/.test(p)) throw new Reject(`cmake preset files may not be touched: ${p}`);
    if (/(^|\/)cmake\//.test(p)) throw new Reject(`cmake/** (toolchains/flags) may not be touched: ${p}`);
    if (/\.cmake$/.test(p)) throw new Reject(`*.cmake (toolchain/flags modules) may not be touched: ${p}`);
  }
  return { touched: [...touched].sort() };
}

// ---- 3. claimed-score pre-filter ----
export function readBests(boardsDir = resolve(__dirname, 'boards')) {
  const bestOf = (file, key) => {
    const p = resolve(boardsDir, file);
    if (!existsSync(p)) return null;
    const lines = readFileSync(p, 'utf8').trim().split('\n');
    const head = lines[0].split('\t');
    let best = null;
    for (const l of lines.slice(1)) {
      const r = Object.fromEntries(l.split('\t').map((v, i) => [head[i], v]));
      if (r.valid !== '1') continue;
      const v = parseFloat(r[key]);
      if (Number.isFinite(v) && (best == null || v < best.value)) best = { value: v, stack: r.stack, iso: r.iso };
    }
    return best;
  };
  return { time: bestOf('time.tsv', 'median_prove_s'), memory: bestOf('memory.tsv', 'peak_rss_MiB') };
}

export function checkClaims(sub, bests) {
  const bestT = bests.time?.value ?? Infinity;
  const bestM = bests.memory?.value ?? Infinity;
  const claimsTime = sub.claimedTimeS <= bestT;
  const claimsMem = sub.claimedPeakMiB <= bestM;
  if (!claimsTime && !claimsMem) {
    throw new Reject(`claimed-score pre-filter: claimedTimeS=${sub.claimedTimeS} >= best ${bestT}s (${bests.time?.stack}) AND claimedPeakMiB=${sub.claimedPeakMiB} >= best ${bestM}MiB (${bests.memory?.stack}) — must claim to improve at least one board`);
  }
  return { claimsTime, claimsMem };
}

// ---- 4. scratch worktree of the pinned base + git apply --check ----
export function addScratchWorktree(label) {
  if (!existsSync(BB_REPO)) throw new Reject(`BB_REPO not found: ${BB_REPO} (set BB_REPO env)`);
  const probe = spawnSync('git', ['-C', BB_REPO, 'cat-file', '-e', `${BASE_COMMIT}^{commit}`], { encoding: 'utf8' });
  if (probe.status !== 0) throw new Reject(`pinned base ${BASE_COMMIT.slice(0, 10)} not present in ${BB_REPO} — fetch upstream next`);
  const wt = join(tmpdir(), `zkarena-${label}-${process.pid}-${Date.now()}`);
  log(`creating scratch worktree of ${BASE_COMMIT.slice(0, 10)} at ${wt} (large checkout, ~1min)...`);
  const r = spawnSync('git', ['-C', BB_REPO, 'worktree', 'add', '--detach', wt, BASE_COMMIT], { encoding: 'utf8' });
  if (r.status !== 0) { removeScratchWorktree(wt); throw new Error(`git worktree add failed: ${(r.stderr || '').slice(-400)}`); }
  return wt;
}

export function removeScratchWorktree(wt) {
  if (!wt) return;
  spawnSync('git', ['-C', BB_REPO, 'worktree', 'remove', '--force', wt], { encoding: 'utf8' });
  rmSync(wt, { recursive: true, force: true }); // belt and braces
  spawnSync('git', ['-C', BB_REPO, 'worktree', 'prune'], { encoding: 'utf8' });
}

export function applyCheck(worktree, patchPath) {
  const r = spawnSync('git', ['-C', worktree, 'apply', '--check', '--whitespace=nowarn', patchPath], { encoding: 'utf8' });
  if (r.status !== 0) throw new Reject(`patch does not apply cleanly to pinned base ${BASE_COMMIT.slice(0, 10)}: ${(r.stderr || '').slice(-400)}`);
}

// ---- full intake (steps 1-3 cheap, 4 needs a worktree) ----
export function intake(dir, { withApplyCheck = true } = {}) {
  const { sub, patchPath, patchText } = loadSubmission(dir);
  log(`submission "${sub.name}" by @${sub.author} (model: ${sub.model})`);
  const { touched } = checkPatchPaths(patchText);
  log(`patch touches ${touched.length} file(s), all under ${ALLOWED_PREFIX}**`);
  const bests = readBests();
  const claims = checkClaims(sub, bests);
  log(`claims ${sub.claimedTimeS}s / ${sub.claimedPeakMiB}MiB vs bests ${bests.time?.value ?? '—'}s / ${bests.memory?.value ?? '—'}MiB — pre-filter PASS`);
  if (withApplyCheck) {
    let wt = null;
    try {
      wt = addScratchWorktree('intake');
      applyCheck(wt, patchPath);
      log('git apply --check: clean');
    } finally { removeScratchWorktree(wt); }
  }
  return {
    status: 'ok', name: sub.name, author: sub.author, model: sub.model,
    claimed: { timeS: sub.claimedTimeS, peakMiB: sub.claimedPeakMiB }, claims,
    bests: { timeS: bests.time?.value ?? null, peakMiB: bests.memory?.value ?? null },
    patch: { file: sub.patch, files: touched.length, paths: touched },
    baseCommit: BASE_COMMIT, appliesClean: withApplyCheck,
  };
}

// ---- CLI ----
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2];
  if (!dir) { console.log(JSON.stringify({ status: 'rejected', reason: 'usage: node intake.mjs <submission-dir>' })); process.exit(1); }
  try {
    console.log(JSON.stringify(intake(dir), null, 2));
  } catch (e) {
    if (e instanceof Reject) { console.log(JSON.stringify({ status: 'rejected', reason: e.reason }, null, 2)); process.exit(1); }
    console.log(JSON.stringify({ status: 'error', reason: String(e.message || e) }, null, 2)); process.exit(2);
  }
}
