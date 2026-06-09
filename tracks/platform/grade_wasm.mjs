// Grade a proving stack against the pinned problem under the fixed config.
// Appends to two SEPARATE boards: boards/time.tsv and boards/memory.tsv.
//
// Usage:
//   node grade.mjs --stack=baseline               # grade a registered stack
//   node grade.mjs --stack=mybuild --spec=/abs/path/to/bbjs/dest/node/index.js
//   node grade.mjs --stack=baseline --runs=3
import { spawn } from 'node:child_process';
import { readFileSync, existsSync, appendFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).map((s) => {
  const i = s.indexOf('='); return i === -1 ? [s.replace(/^--/, ''), '1'] : [s.slice(2, i), s.slice(i + 1)];
}));
const runs = args.runs ? parseInt(args.runs) : 3;
const stackName = args.stack || 'baseline';

const registry = JSON.parse(readFileSync(resolve(__dirname, 'stacks', 'registry.json'), 'utf8'));
let spec = args.spec;
if (!spec) {
  const entry = registry.stacks[stackName];
  if (!entry) throw new Error(`unknown stack "${stackName}" — add it to stacks/registry.json or pass --spec=<path>`);
  spec = entry.spec;
}

const manifest = JSON.parse(readFileSync(resolve(__dirname, 'manifest.json'), 'utf8'));

function runOnce() {
  return new Promise((res) => {
    const child = spawn('node', [resolve(__dirname, 'lib', 'run_task.mjs'), `--stack=${spec}`, `--stackName=${stackName}`], { cwd: __dirname, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (code) => {
      const line = out.split('\n').find((l) => l.startsWith('TASK_RESULT '));
      if (line) { try { return res(JSON.parse(line.slice('TASK_RESULT '.length))); } catch {} }
      res({ ok: false, err: `no result (exit ${code}) ${err.slice(-200)}` });
    });
  });
}
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

console.log(`\n=== prover-arena :: grading stack "${stackName}" on task "${manifest.name}" (2^${Math.log2(manifest.paddedSize)}) ===`);
console.log(`spec=${spec}  fixed: threads=${manifest.fixedConfig.threads} srs=${manifest.fixedConfig.srsSize} flavor=${manifest.fixedConfig.flavor}  runs=${runs}\n`);

const times = [];
let peak = 0, verified = null, ok = true, lastErr = null, oom = false;
for (let r = 0; r < runs; r++) {
  const res = await runOnce();
  if (!res.ok) { ok = false; lastErr = res.err; oom = !!res.oom; break; }
  times.push(res.proveMs);
  if ((res.wasmPeakMiB || 0) > peak) peak = res.wasmPeakMiB;
  verified = res.verified;
  console.log(`  run ${r + 1}/${runs}: prove ${(res.proveMs / 1000).toFixed(1)}s  peak ${res.wasmPeakMiB.toFixed(0)}MiB  verified=${res.verified}`);
}

const medMs = times.length ? median(times) : null;
const withinCeiling = peak > 0 && peak <= manifest.validity.ceilingMiB;
const valid = ok && verified === true && withinCeiling;
const timeS = medMs != null ? +(medMs / 1000).toFixed(2) : null;

console.log(`\n  median prove: ${timeS != null ? timeS + 's' : 'n/a'}   peak memory: ${peak.toFixed(0)} MiB`);
console.log(`  valid: ${valid ? 'YES' : 'NO'}${ok ? '' : ' (' + (oom ? 'OOM' : 'error') + ': ' + String(lastErr).slice(0, 80) + ')'}\n`);

const iso = args.now || new Date().toISOString();
function append(file, header, row) {
  const p = resolve(__dirname, 'boards', file);
  if (!existsSync(p)) appendFileSync(p, header.join('\t') + '\n');
  appendFileSync(p, row.join('\t') + '\n');
}
append('time.tsv', ['iso', 'stack', 'task', 'median_prove_s', 'verified', 'valid', 'note'],
  [iso, stackName, manifest.name, timeS ?? '', verified ? 1 : 0, valid ? 1 : 0, ok ? '' : (oom ? 'OOM' : 'ERR')]);
append('memory.tsv', ['iso', 'stack', 'task', 'peak_wasm_MiB', 'verified', 'valid', 'note'],
  [iso, stackName, manifest.name, peak.toFixed(0), verified ? 1 : 0, valid ? 1 : 0, ok ? '' : (oom ? 'OOM' : 'ERR')]);
console.log(`  appended to boards/time.tsv and boards/memory.tsv  —  run \`node board.mjs\` to rank.\n`);
