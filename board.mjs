// Render the two boards (time, memory), ranked, best entry per stack.
// Both metrics are shown on BOTH boards (each with its delta vs baseline) so a
// time-memory tradeoff is visible at a glance — you can see what an entry
// optimized for and what it paid on the other axis.
//   node board.mjs        -> terminal
//   node board.mjs --md   -> also writes LEADERBOARD.md (the live leaderboard)
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const writeMd = process.argv.includes('--md');

// Both TSVs carry both metrics; primaryKey decides ranking, secondaryKey is context.
function load(file, primaryKey, secondaryKey) {
  const p = resolve(__dirname, 'boards', file);
  if (!existsSync(p)) return [];
  const lines = readFileSync(p, 'utf8').trim().split('\n');
  const head = lines[0].split('\t');
  const rows = lines.slice(1).map((l) => Object.fromEntries(l.split('\t').map((v, i) => [head[i], v])));
  const best = new Map();
  for (const r of rows) {
    const valid = r.valid === '1';
    const val = valid ? parseFloat(r[primaryKey]) : Infinity;
    const cur = best.get(r.stack);
    if (!cur || val < cur._v) best.set(r.stack, { ...r, _v: val, _s: parseFloat(r[secondaryKey]), _valid: valid });
  }
  return [...best.values()].sort((a, b) => a._v - b._v);
}

const timeB = load('time.tsv', 'median_prove_s', 'peak_rss_MiB');
const memB = load('memory.tsv', 'peak_rss_MiB', 'median_prove_s');

const fmtDelta = (v, baseV) => {
  if (baseV == null || !isFinite(v)) return '—';
  const pct = (1 - v / baseV) * 100;
  if (Math.abs(pct) < 0.05) return 'baseline';
  return pct > 0 ? `-${pct.toFixed(1)}%` : `+${(-pct).toFixed(1)}%`; // - is better (lower)
};

function table(entries, pUnit, pDigits, sUnit, sDigits) {
  const base = entries.find((e) => e.stack === 'baseline');
  const basePV = base && base._valid ? base._v : null;
  const baseSV = base && base._valid ? base._s : null;
  let rank = 1;
  return entries.map((e) => {
    const valid = e._valid;
    return {
      rank: valid ? rank++ : '—',
      stack: e.stack,
      primary: valid ? e._v.toFixed(pDigits) + ' ' + pUnit : 'INVALID',
      pVs: valid ? (e.stack === 'baseline' ? 'baseline' : fmtDelta(e._v, basePV)) : '—',
      secondary: isFinite(e._s) ? e._s.toFixed(sDigits) + ' ' + sUnit : '—',
      sVs: e.stack === 'baseline' ? 'baseline' : (isFinite(e._s) ? fmtDelta(e._s, baseSV) : '—'),
      date: (e.iso || '').slice(0, 10),
    };
  });
}

const tRows = table(timeB, 's', 2, 'MiB', 0);   // ranked by time; memory shown alongside
const mRows = table(memB, 'MiB', 0, 's', 2);    // ranked by memory; time shown alongside

// ---- terminal ----
const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);
function printT(title, rows, pHead, sHead) {
  console.log(`\n  ${title}\n`);
  if (!rows.length) { console.log('    (no runs yet)'); return; }
  console.log('  ' + [pad('#', 3), pad('prover', 22), padL(pHead, 12), padL('vs base', 10), padL(sHead, 12), padL('vs base', 10), pad('date', 10)].join(' '));
  console.log('  ' + '-'.repeat(86));
  for (const r of rows) console.log('  ' + [pad(r.rank, 3), pad(r.stack.slice(0, 22), 22), padL(r.primary, 12), padL(r.pVs, 10), padL(r.secondary, 12), padL(r.sVs, 10), pad(r.date, 10)].join(' '));
}
console.log('\n  ====== ZK PROVER ARENA — task hard2pow21 (2^21), frozen config, swap the prover ======');
printT('TIME BOARD (ranked by median prove seconds; memory shown for context)', tRows, 'prove', 'peak RSS');
printT('MEMORY BOARD (ranked by peak RSS; time shown for context)', mRows, 'peak RSS', 'prove');
console.log('\n  Lower is better everywhere. "-x%" = better than baseline, "+x%" = worse (the cost of the tradeoff).');
console.log('  Circuit, witness, proof system, and config are constants. The only variable is the prover.\n');

// ---- LEADERBOARD.md ----
if (writeMd) {
  const md = (rows, pHead, sHead) => rows.length
    ? [`| # | prover | ${pHead} | vs baseline | ${sHead} | vs baseline | date |`,
       '|---|--------|------|------|------|------|------|',
       ...rows.map((r) => `| ${r.rank} | ${r.stack} | **${r.primary}** | ${r.pVs} | ${r.secondary} | ${r.sVs} | ${r.date} |`)].join('\n')
    : '_(no runs yet)_';
  const out = `# Leaderboard — zk-prover-arena

**Task:** \`hard2pow21\` — prove the pinned 1,501,711-gate (2^21) circuit.
**Frozen:** circuit, proof system (UltraHonk, poseidon2 oracle, ZK), single-threaded, native.
**Variable:** the prover implementation (\`bb\` binary rebuilt from modified barretenberg C++).
**Gates:** fresh random witness per run (emitted output must match — kills cached proofs); baseline \`bb verify\` against the pinned VK; cross-budgets (time entries: peak RSS <= 4096 MiB; memory entries: time <= 2x baseline — no trading one axis for the other); disk-ops cap (no spill); single-thread confirmed from bb's log.

Each board is ranked by its own metric (**bold**), but shows the other metric too — so what an entry optimized for, and what it paid on the other axis, is visible at a glance. \`-x%\` = better than baseline, \`+x%\` = worse. Ranked by each stack's best valid run. Generated by \`node board.mjs --md\`.

## Time board (ranked by median prove seconds)

${md(tRows, 'prove time', 'peak RSS')}

## Memory board (ranked by peak RSS)

${md(mRows, 'peak RSS', 'prove time')}

_Numbers are comparable only when graded on the same machine — the canonical boards above are produced on the maintainer's grader (Apple M-series arm64, macOS). To get on the board: see "Submitting" in the README._
`;
  writeFileSync(resolve(__dirname, 'LEADERBOARD.md'), out);
  console.log('  wrote LEADERBOARD.md\n');
}
