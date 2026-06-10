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
function loadRows(file) {
  const p = resolve(__dirname, 'boards', file);
  if (!existsSync(p)) return [];
  const lines = readFileSync(p, 'utf8').trim().split('\n');
  const head = lines[0].split('\t');
  return lines.slice(1).map((l) => Object.fromEntries(l.split('\t').map((v, i) => [head[i], v])));
}
function load(file, primaryKey, secondaryKey) {
  const best = new Map();
  for (const r of loadRows(file)) {
    const valid = r.valid === '1';
    const val = valid ? parseFloat(r[primaryKey]) : Infinity;
    const cur = best.get(r.stack);
    if (!cur || val < cur._v) best.set(r.stack, { ...r, _v: val, _s: parseFloat(r[secondaryKey]), _valid: valid });
  }
  return [...best.values()].sort((a, b) => a._v - b._v);
}

const timeB = load('time.tsv', 'median_prove_s', 'peak_rss_MiB');
const memB = load('memory.tsv', 'peak_rss_MiB', 'median_prove_s');
// x86 board (ratio-scored): rows written by ci/decide.mjs; each grading carries its
// own same-VM baseline because GitHub's x86 fleet mixes CPU models.
const timeX = load('x86/time.tsv', 'ratio', 'median_prove_s');
const memX = load('x86/memory.tsv', 'peak_rss_MiB', 'time_ratio');

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
      machine: e.machine || '—',
      date: (e.iso || '').slice(0, 10),
    };
  });
}

const tRows = table(timeB, 's', 2, 'MiB', 0);   // ranked by time; memory shown alongside
const mRows = table(memB, 'MiB', 0, 's', 2);    // ranked by memory; time shown alongside

// x86 rows: time ranked by ratio-to-same-VM-baseline; memory ranked by absolute peak
// (RSS doesn't suffer the CPU lottery). Machine matters per row here — it names the
// CPU model the VM actually landed on.
function tableX86Time(entries) {
  let rank = 1;
  return entries.map((e) => ({
    rank: e._valid ? rank++ : '—',
    stack: e.stack,
    vsBase: e._valid ? (e.stack === 'baseline' ? 'baseline' : fmtDelta(e._v, 1)) : 'INVALID',
    time: isFinite(e._s) ? e._s.toFixed(2) + ' s' : '—',
    baseTime: e.baseline_median_s ? (+e.baseline_median_s).toFixed(2) + ' s' : '—',
    rss: e.peak_rss_MiB ? e.peak_rss_MiB + ' MiB' : '—',
    machine: e.machine || '—',
    date: (e.iso || '').slice(0, 10),
  }));
}
function tableX86Mem(entries) {
  let rank = 1;
  return entries.map((e) => ({
    rank: e._valid ? rank++ : '—',
    stack: e.stack,
    rss: e._valid ? e._v.toFixed(0) + ' MiB' : 'INVALID',
    baseRss: e.baseline_peak_MiB ? e.baseline_peak_MiB + ' MiB' : '—',
    timeVsBase: e.stack === 'baseline' ? 'baseline' : (isFinite(e._s) ? fmtDelta(e._s, 1) : '—'),
    machine: e.machine || '—',
    date: (e.iso || '').slice(0, 10),
  }));
}
const txRows = tableX86Time(timeX);
const mxRows = tableX86Mem(memX);

// ---- terminal ----
const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);
function printT(title, rows, pHead, sHead) {
  console.log(`\n  ${title}\n`);
  if (!rows.length) { console.log('    (no runs yet)'); return; }
  console.log('  ' + [pad('#', 3), pad('prover', 22), padL(pHead, 12), padL('vs base', 10), padL(sHead, 12), padL('vs base', 10), pad('machine', 20), pad('date', 10)].join(' '));
  console.log('  ' + '-'.repeat(107));
  for (const r of rows) console.log('  ' + [pad(r.rank, 3), pad(r.stack.slice(0, 22), 22), padL(r.primary, 12), padL(r.pVs, 10), padL(r.secondary, 12), padL(r.sVs, 10), pad(r.machine.slice(0, 20), 20), pad(r.date, 10)].join(' '));
}
console.log('\n  ====== ZK PROVER ARENA — task hard2pow21 (2^21), frozen config, swap the prover ======');
printT('TIME BOARD — arm64 (ranked by median prove seconds; memory shown for context)', tRows, 'prove', 'peak RSS');
printT('MEMORY BOARD — arm64 (ranked by peak RSS; time shown for context)', mRows, 'peak RSS', 'prove');
if (txRows.length || mxRows.length) {
  console.log('\n  X86 BOARD (ratio vs same-VM baseline; mixed EPYC/Xeon fleet — see machine column)\n');
  for (const r of txRows) console.log('  ' + [pad(r.rank, 3), pad(r.stack.slice(0, 22), 22), padL(r.vsBase, 10), padL(r.time, 10), padL('base ' + r.baseTime, 14), padL(r.rss, 10), pad(r.machine.slice(0, 20), 20), pad(r.date, 10)].join(' '));
}
console.log('\n  Lower is better everywhere. "-x%" = better than baseline, "+x%" = worse (the cost of the tradeoff).');
console.log('  Circuit, witness, proof system, and config are constants. The only variable is the prover.\n');

// ---- LEADERBOARD.md ----
if (writeMd) {
  const md = (rows, pHead, sHead) => rows.length
    ? [`| # | prover | ${pHead} | vs baseline | ${sHead} | vs baseline | machine | date |`,
       '|---|--------|------|------|------|------|------|------|',
       ...rows.map((r) => `| ${r.rank} | ${r.stack} | **${r.primary}** | ${r.pVs} | ${r.secondary} | ${r.sVs} | \`${r.machine}\` | ${r.date} |`)].join('\n')
    : '_(no runs yet)_';
  const mdX86Time = (rows) => rows.length
    ? ['| # | prover | vs same-VM baseline | prove time | baseline (same VM) | peak RSS | machine | date |',
       '|---|--------|------|------|------|------|------|------|',
       ...rows.map((r) => `| ${r.rank} | ${r.stack} | **${r.vsBase}** | ${r.time} | ${r.baseTime} | ${r.rss} | \`${r.machine}\` | ${r.date} |`)].join('\n')
    : '_(no runs yet)_';
  const mdX86Mem = (rows) => rows.length
    ? ['| # | prover | peak RSS | baseline (same VM) | prove time vs baseline | machine | date |',
       '|---|--------|------|------|------|------|------|',
       ...rows.map((r) => `| ${r.rank} | ${r.stack} | **${r.rss}** | ${r.baseRss} | ${r.timeVsBase} | \`${r.machine}\` | ${r.date} |`)].join('\n')
    : '_(no runs yet)_';
  const out = `# Leaderboard — zk-prover-arena

**Task:** \`hard2pow21\` — prove the pinned 1,501,711-gate (2^21) circuit.
**Frozen:** circuit, proof system (UltraHonk, poseidon2 oracle, ZK), single-threaded, native.
**Variable:** the prover implementation (\`bb\` binary rebuilt from modified barretenberg C++).
**Gates:** fresh random witness per run (emitted output must match — kills cached proofs); baseline \`bb verify\` against the pinned VK; cross-budgets (time entries: peak RSS <= 4096 MiB; memory entries: time <= 2x baseline — no trading one axis for the other); disk-ops cap (no spill); single-thread confirmed from bb's log.

Each board is ranked by its own metric (**bold**), but shows the other metric too — so what an entry optimized for, and what it paid on the other axis, is visible at a glance. \`-x%\` = better than baseline, \`+x%\` = worse. Ranked by each stack's best valid run. Every row states the machine it was measured on. Generated by \`node board.mjs --md\`.

# arm64 boards (canonical: \`ubuntu-24.04-arm\`, Azure Cobalt 100 — homogeneous fleet, absolute seconds)

## Time board (ranked by median prove seconds)

${md(tRows, 'prove time', 'peak RSS')}

## Memory board (ranked by peak RSS)

${md(mRows, 'peak RSS', 'prove time')}

# x86-64 boards (\`ubuntu-latest\` — Aztec's perf ISA; upstream x64 asm active)

GitHub's x86 fleet mixes CPU models (AMD EPYC / Intel Xeon — see the machine column), so the **time board is ranked by ratio to a baseline graded in the same job on the same VM**, which cancels the hardware lottery. Peak RSS is hardware-insensitive and ranks on absolute MiB.

## Time board (ranked by ratio vs same-VM baseline)

${mdX86Time(txRows)}

## Memory board (ranked by peak RSS)

${mdX86Mem(mxRows)}

_Boards are produced only by the \`official-grade\` CI workflow on GitHub-hosted runners; every row records its machine. Numbers from different boards/machines are not directly comparable. Local numbers are advisory. To get on a board: see "Submitting" in the README._
`;
  writeFileSync(resolve(__dirname, 'LEADERBOARD.md'), out);
  console.log('  wrote LEADERBOARD.md\n');
}
