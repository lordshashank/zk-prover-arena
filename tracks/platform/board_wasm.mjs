// Print the two SEPARATE boards (time and memory), each ranked, best per stack.
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

function load(file, valueKey, lowerBetter = true) {
  const p = resolve(__dirname, 'boards', file);
  if (!existsSync(p)) return null;
  const lines = readFileSync(p, 'utf8').trim().split('\n');
  const head = lines[0].split('\t');
  const rows = lines.slice(1).map((l) => Object.fromEntries(l.split('\t').map((v, i) => [head[i], v])));
  const best = new Map();
  for (const r of rows) {
    const valid = r.valid === '1';
    const val = valid ? parseFloat(r[valueKey]) : Infinity;
    const cur = best.get(r.stack);
    if (!cur || val < cur._v) best.set(r.stack, { ...r, _v: val, _valid: valid });
  }
  return [...best.values()].sort((a, b) => a._v - b._v);
}

const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);

function printBoard(title, entries, valueKey, unit) {
  console.log(`\n  ${title}\n`);
  if (!entries || !entries.length) { console.log('    (no runs yet)\n'); return; }
  const base = entries.find((e) => e.stack === 'baseline');
  const baseV = base && base._valid ? base._v : null;
  console.log('  ' + [pad('#', 4), pad('stack', 24), padL(valueKey, 16), padL('vs baseline', 13), pad('valid', 6)].join(' '));
  console.log('  ' + '-'.repeat(66));
  let rank = 1;
  for (const e of entries) {
    const valid = e._valid;
    const vstr = valid ? e._v.toFixed(valueKey.includes('MiB') ? 0 : 2) + ' ' + unit : 'INVALID';
    let vs = '-';
    if (valid && baseV) { const pct = (1 - e._v / baseV) * 100; vs = pct === 0 ? 'baseline' : (pct > 0 ? pct.toFixed(1) + '% better' : Math.abs(pct).toFixed(1) + '% worse'); }
    console.log('  ' + [pad(valid ? rank++ : '—', 4), pad(e.stack.slice(0, 24), 24), padL(vstr, 16), padL(vs, 13), pad(valid ? 'Y' : 'N', 6)].join(' '));
  }
  console.log('');
}

console.log('\n  ====== PROVER ARENA — task: hard2pow21 (2^21), fixed config, swap the stack ======');
printBoard('TIME BOARD  (median prove seconds, lower wins)', load('time.tsv', 'median_prove_s'), 'median_prove_s', 's');
printBoard('MEMORY BOARD  (peak wasm MiB, lower wins)', load('memory.tsv', 'peak_wasm_MiB'), 'peak_wasm_MiB', 'MiB');
console.log('  The circuit, witness, and config are constant. The only variable is the proving stack.\n');
