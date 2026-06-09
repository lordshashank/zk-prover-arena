// Run the PINNED problem on a SPECIFIED stack under the FIXED config.
//
// This is the core of the prover arena. The circuit, witness, and config are
// constants (from problem/manifest.json). The ONLY variable is the proving stack:
// `--stack=<path>` selects which @aztec/bb.js build to load. Default is the
// installed package (the baseline). A candidate stack is the path to an alternate
// bb.js build's node entry (e.g. a rebuilt-from-source @aztec/bb.js after an
// algorithmic change to barretenberg).
//
// Output: one `TASK_RESULT {json}` line with prove time, peak wasm memory, verify.
//
// IMPORTANT: measure.mjs is imported first so it patches WebAssembly.Memory
// before the (swapped) bb.js instantiates the wasm module.
import { PeakSampler } from './measure.mjs';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const args = Object.fromEntries(process.argv.slice(2).map((s) => {
  const i = s.indexOf('=');
  return i === -1 ? [s.replace(/^--/, ''), '1'] : [s.slice(2, i), s.slice(i + 1)];
}));

const manifest = JSON.parse(readFileSync(resolve(ROOT, 'manifest.json'), 'utf8'));
const cfg = manifest.fixedConfig;
const stackSpec = args.stack || '@aztec/bb.js';          // bare specifier or absolute path to a bb.js node entry
const stackName = args.stackName || stackSpec;
const crsPath = args.crsPath || resolve(ROOT, '.crs');

const result = {
  stack: stackName, stackSpec,
  task: manifest.name, padded: manifest.paddedSize,
  config: cfg,
  ok: false, err: null,
  proveMs: null, vkMs: null, verifyMs: null, verified: null, proofLen: null,
  wasmPeakMiB: 0, rssPeakMiB: null,
};

// max of bb's own "(mem: N MiB)" logs == peak wasm heap (linear memory only grows)
const trackMem = (m) => { const x = /\(mem:\s*([\d.]+)\s*MiB\)/.exec(m); if (x) { const v = parseFloat(x[1]); if (v > result.wasmPeakMiB) result.wasmPeakMiB = v; } };

const sampler = new PeakSampler(20);
let api;
try {
  const circuit = JSON.parse(readFileSync(resolve(ROOT, manifest.circuit), 'utf8'));
  const witness = new Uint8Array(readFileSync(resolve(ROOT, manifest.witness)));

  const bb = await import(stackSpec);
  const { Barretenberg, UltraHonkBackend } = bb;
  const { ungzip } = await import('pako');

  // FIXED-CONFIG enforcement -------------------------------------------------
  // SRS sized to the circuit (mandatory for the task to run; part of the rules).
  Barretenberg.prototype.getDefaultSrsSize = function () { return cfg.srsSize; };

  const settings = { ipaAccumulation: false, oracleHashType: 'poseidon2', disableZk: false, optimizedSolidityVerifier: false };

  sampler.start();
  api = await Barretenberg.new({
    threads: cfg.threads,
    backend: cfg.backend,          // 'Wasm' — never native
    crsPath,
    logger: (m) => trackMem(m),
  });

  const backend = new UltraHonkBackend(circuit.bytecode, api);
  const bytecode = backend.acirUncompressedBytecode;

  // Precomputed VK (fixed): isolates the prove kernel — the thing being optimized.
  const tvk = performance.now();
  const vk = await api.circuitComputeVk({ circuit: { name: 'task', bytecode, verificationKey: new Uint8Array(0) }, settings });
  result.vkMs = performance.now() - tvk;

  const wit = ungzip(witness);
  const t0 = performance.now();
  const { proof, publicInputs } = await api.circuitProve({ witness: wit, circuit: { name: 'task', bytecode, verificationKey: vk.bytes }, settings });
  result.proveMs = performance.now() - t0;
  result.proofLen = proof.length * 32;

  // verify (validity gate)
  const flat = new Uint8Array(proof.length * 32);
  proof.forEach((fr, i) => flat.set(fr, i * 32));
  const tv = performance.now();
  result.verified = await backend.verifyProof({ proof: flat, publicInputs: publicInputs.map((p) => '0x' + Buffer.from(p).toString('hex')) });
  result.verifyMs = performance.now() - tv;

  result.ok = true;
} catch (e) {
  result.ok = false;
  result.err = e && e.message ? e.message : String(e);
  if (/memory|allocat|OOM|out of bounds|RuntimeError|Aborted|grow|too many points/i.test(result.err)) result.oom = true;
} finally {
  const m = sampler.stop();
  result.rssPeakMiB = Math.round(m.peak.rss / (1024 * 1024));
  try { if (api) await api.destroy(); } catch {}
}

process.stdout.write('\nTASK_RESULT ' + JSON.stringify(result) + '\n');
process.exit(0);
