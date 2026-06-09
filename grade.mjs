// zk-prover-arena — grade a candidate PROVER (native bb build) on the pinned task.
//
// ALGORITHM TRACK. The circuit, witness, proof system, and config are frozen.
// The ONLY variable is the prover implementation: a barretenberg `bb` binary,
// typically rebuilt from modified C++ (MSM, FFT/NTT, polynomial memory, ...).
//
// Metrics (separate boards, both lower-is-better):
//   time   = median wall-clock seconds of `bb prove`, SINGLE-THREADED
//   memory = peak resident set size (MiB) of the prove process
//
// Why native + single-threaded: it isolates the *algorithm* from the platform.
// WASM wall-clock mixes prover work with codegen/SIMD/runtime effects, and
// multithreading measures the scheduler. Peak RSS is set by the prover's actual
// allocations (polynomial count x field size + SRS + scratch) — the same
// quantity that decides how large a circuit fits in any environment, including
// the browser's 4 GB wasm32 ceiling.
//
// SOUNDNESS GATE (the trust boundary, like a fixed reference evaluator):
//   1. The verification key is computed ONCE by the PINNED BASELINE bb from the
//      pinned circuit (problem/baseline_vk/vk, committed). This freezes the
//      proof system: a candidate must produce proofs for *that* VK.
//   2. The candidate's proof is verified by the PINNED BASELINE `bb verify`
//      against that VK. The candidate binary is never trusted to judge itself.
//   Protocol-level changes (new proof system / proof format) are out of scope
//   for machine grading — see README.
//
// Usage:
//   node grade.mjs --stack=baseline
//   node grade.mjs --stack=my-fft-fix --bb=/abs/path/to/modified/bb
//   node grade.mjs --stack=baseline --runs=5
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync, appendFileSync, mkdirSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).map((s) => {
  const i = s.indexOf('='); return i === -1 ? [s.replace(/^--/, ''), '1'] : [s.slice(2, i), s.slice(i + 1)];
}));

const runs = args.runs ? parseInt(args.runs) : 3;
const stackName = args.stack || 'baseline';
const manifest = JSON.parse(readFileSync(resolve(__dirname, 'problem', 'manifest.json'), 'utf8'));
const BASELINE_BB = process.env.BASELINE_BB || resolve(homedir(), '.bb', 'bb');

// Resolve the candidate bb binary: --bb path, or stacks/registry.json entry.
let candidateBB = args.bb;
if (!candidateBB) {
  const reg = JSON.parse(readFileSync(resolve(__dirname, 'stacks', 'registry.json'), 'utf8'));
  const entry = reg.stacks[stackName];
  if (!entry) throw new Error(`unknown stack "${stackName}" — add it to stacks/registry.json or pass --bb=<path>`);
  candidateBB = entry.bb === 'BASELINE' ? BASELINE_BB : entry.bb;
}
if (!existsSync(candidateBB)) throw new Error(`bb binary not found: ${candidateBB}`);
if (!existsSync(BASELINE_BB)) throw new Error(`baseline bb not found at ${BASELINE_BB} (set BASELINE_BB env var)`);

const CIRCUIT = resolve(__dirname, manifest.circuit);
const WITNESS = resolve(__dirname, manifest.witness);
const VK_DIR = resolve(__dirname, 'problem', 'baseline_vk');
const VK = resolve(VK_DIR, 'vk');
const ENV1 = { ...process.env, HARDWARE_CONCURRENCY: String(manifest.fixedConfig.threads) };

// ---- Ensure the pinned baseline VK exists (computed once by the BASELINE bb) ----
if (!existsSync(VK)) {
  console.log('  [setup] computing pinned baseline VK (one-time, baseline bb)...');
  mkdirSync(VK_DIR, { recursive: true });
  const r = spawnSync(BASELINE_BB, ['write_vk', '-b', CIRCUIT, '-o', VK_DIR], { env: ENV1, encoding: 'utf8' });
  if (r.status !== 0 || !existsSync(VK)) throw new Error(`baseline write_vk failed: ${(r.stderr || '').slice(-300)}`);
  console.log('  [setup] baseline VK written to problem/baseline_vk/vk');
}

// ---- One graded run: candidate proves (timed+measured), baseline verifies ----
function gradedRun(i) {
  const outDir = resolve(tmpdir(), `zkarena-${process.pid}-${i}`);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  // /usr/bin/time: -l on macOS (max RSS in bytes), -v on Linux (KB).
  const isLinux = process.platform === 'linux';
  const timeFlag = isLinux ? '-v' : '-l';
  const t0 = process.hrtime.bigint();
  // Prove against the PINNED VK (-k): no VK computation inside the timed run,
  // and the candidate is forced to target the frozen proof system.
  const p = spawnSync('/usr/bin/time', [timeFlag, candidateBB, 'prove', '-b', CIRCUIT, '-w', WITNESS, '-k', VK, '-o', outDir],
    { env: ENV1, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const proveS = Number(process.hrtime.bigint() - t0) / 1e9;

  if (p.status !== 0) {
    rmSync(outDir, { recursive: true, force: true });
    return { ok: false, err: `prove exit ${p.status}: ${(p.stderr || '').slice(-300)}` };
  }

  // Parse peak RSS from /usr/bin/time output (stderr).
  let peakMiB = null;
  const mMac = /(\d+)\s+maximum resident set size/.exec(p.stderr || '');
  const mLin = /Maximum resident set size[^:]*:\s*(\d+)/.exec(p.stderr || '');
  if (mMac) peakMiB = parseInt(mMac[1]) / (1024 * 1024);
  else if (mLin) peakMiB = parseInt(mLin[1]) / 1024;

  // Confirm single-thread pinning from bb's own log.
  const threadLine = /num threads:\s*(\d+)/.exec((p.stdout || '') + (p.stderr || ''));
  const threadsUsed = threadLine ? parseInt(threadLine[1]) : null;

  // SOUNDNESS GATE: baseline bb verifies the candidate's proof against the PINNED VK.
  const proofPath = resolve(outDir, 'proof');
  const pubPath = resolve(outDir, 'public_inputs');
  let verified = false;
  if (existsSync(proofPath) && existsSync(pubPath)) {
    const v = spawnSync(BASELINE_BB, ['verify', '-p', proofPath, '-k', VK, '-i', pubPath], { env: ENV1, encoding: 'utf8' });
    verified = v.status === 0;
  }
  rmSync(outDir, { recursive: true, force: true });
  return { ok: true, proveS, peakMiB, verified, threadsUsed };
}

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

console.log(`\n=== zk-prover-arena :: grading "${stackName}" on task "${manifest.name}" (2^${Math.log2(manifest.paddedSize)}) ===`);
console.log(`candidate bb: ${candidateBB}`);
console.log(`fixed: native, threads=${manifest.fixedConfig.threads}, scheme=${manifest.fixedConfig.scheme}; soundness gate: baseline verify vs pinned VK; runs=${runs}\n`);

const times = []; const peaks = [];
let allVerified = true, ok = true, lastErr = null, threadViolation = false;
for (let r = 0; r < runs; r++) {
  const res = gradedRun(r);
  if (!res.ok) { ok = false; lastErr = res.err; break; }
  if (res.threadsUsed != null && res.threadsUsed !== manifest.fixedConfig.threads) threadViolation = true;
  times.push(res.proveS); peaks.push(res.peakMiB);
  if (!res.verified) allVerified = false;
  console.log(`  run ${r + 1}/${runs}: prove ${res.proveS.toFixed(2)}s  peakRSS ${res.peakMiB?.toFixed(0)}MiB  threads=${res.threadsUsed}  verified=${res.verified}`);
}

const medS = times.length ? +median(times).toFixed(2) : null;
const peakMiB = peaks.length ? Math.max(...peaks.filter((x) => x != null)) : null;
const valid = ok && allVerified && !threadViolation && medS != null && peakMiB != null;

console.log(`\n  median prove: ${medS ?? 'n/a'} s    peak RSS: ${peakMiB?.toFixed(0) ?? 'n/a'} MiB`);
console.log(`  gates: soundness(baseline verify)=${allVerified ? 'PASS' : 'FAIL'}  single-thread=${threadViolation ? 'FAIL' : 'PASS'}  complete=${ok ? 'PASS' : 'FAIL'}`);
console.log(`  => ${valid ? 'VALID' : 'INVALID'}${ok ? '' : '  (' + String(lastErr).slice(0, 100) + ')'}\n`);

const iso = args.now || new Date().toISOString();
function append(file, header, row) {
  const p = resolve(__dirname, 'boards', file);
  mkdirSync(dirname(p), { recursive: true });
  if (!existsSync(p)) appendFileSync(p, header.join('\t') + '\n');
  appendFileSync(p, row.join('\t') + '\n');
}
append('time.tsv', ['iso', 'stack', 'task', 'median_prove_s', 'verified', 'valid', 'note'],
  [iso, stackName, manifest.name, medS ?? '', allVerified ? 1 : 0, valid ? 1 : 0, ok ? '' : 'ERR']);
append('memory.tsv', ['iso', 'stack', 'task', 'peak_rss_MiB', 'verified', 'valid', 'note'],
  [iso, stackName, manifest.name, peakMiB != null ? peakMiB.toFixed(0) : '', allVerified ? 1 : 0, valid ? 1 : 0, ok ? '' : 'ERR']);
console.log(`  appended to boards/time.tsv + boards/memory.tsv — run \`node board.mjs\` to rank, \`node board.mjs --md\` to refresh LEADERBOARD.md\n`);
