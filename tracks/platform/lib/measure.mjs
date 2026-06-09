// Memory + time measurement utilities for the ZK proving benchmark.
//
// We care most about *peak WASM linear memory*, because that is the quantity
// bounded by the wasm32 4 GiB address-space ceiling that makes bb.js OOM at
// 2^20 gates in the browser. We capture it two ways and report both:
//
//   1. `arrayBuffers` from process.memoryUsage() — Node counts WASM linear
//      memory (ArrayBuffer / SharedArrayBuffer backing store) here. Reliable
//      regardless of which thread the wasm Memory lives on (worker_threads
//      share the process, so RSS/arrayBuffers see everything).
//
//   2. A monkey-patch on WebAssembly.Memory that records every Memory instance
//      so we can read `.buffer.byteLength` directly — the exact wasm heap size.
//      Must be imported BEFORE @aztec/bb.js so the patch is in place.
//
// We also track RSS as a whole-process cross-check.

const trackedMemories = new Set();

// --- Patch WebAssembly.Memory to capture instances -------------------------
const RealMemory = WebAssembly.Memory;
function PatchedMemory(...args) {
  const m = new RealMemory(...args);
  try {
    trackedMemories.add(m);
  } catch {}
  return m;
}
PatchedMemory.prototype = RealMemory.prototype;
// Preserve identity for instanceof and static props
Object.setPrototypeOf(PatchedMemory, RealMemory);
try {
  // eslint-disable-next-line no-global-assign
  WebAssembly.Memory = PatchedMemory;
} catch {
  // some runtimes freeze WebAssembly; fall back to arrayBuffers only
}

function wasmHeapBytes() {
  let total = 0;
  for (const m of trackedMemories) {
    try {
      total += m.buffer.byteLength;
    } catch {}
  }
  return total;
}

export function memSnapshot() {
  const mu = process.memoryUsage();
  return {
    rss: mu.rss,
    arrayBuffers: mu.arrayBuffers,
    external: mu.external,
    wasmHeap: wasmHeapBytes(),
  };
}

// High-frequency sampler that records the peak of each metric.
export class PeakSampler {
  constructor(intervalMs = 25) {
    this.intervalMs = intervalMs;
    this.peak = { rss: 0, arrayBuffers: 0, external: 0, wasmHeap: 0 };
    this.baseline = memSnapshot();
    this.timer = null;
    this.samples = 0;
  }
  _tick() {
    const s = memSnapshot();
    this.samples++;
    for (const k of Object.keys(this.peak)) {
      if (s[k] > this.peak[k]) this.peak[k] = s[k];
    }
  }
  start() {
    this._tick();
    this.timer = setInterval(() => this._tick(), this.intervalMs);
    if (this.timer.unref) this.timer.unref();
    return this;
  }
  stop() {
    this._tick();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    return {
      peak: this.peak,
      baseline: this.baseline,
      // peak-over-baseline deltas (what the proof actually added)
      delta: {
        rss: this.peak.rss - this.baseline.rss,
        arrayBuffers: this.peak.arrayBuffers - this.baseline.arrayBuffers,
        external: this.peak.external - this.baseline.external,
        wasmHeap: this.peak.wasmHeap, // wasmHeap baseline is ~0 pre-init
      },
      samples: this.samples,
    };
  }
}

export const MiB = 1024 * 1024;
export const fmtMiB = (b) => (b / MiB).toFixed(1);
export const fmtGiB = (b) => (b / (1024 * MiB)).toFixed(3);
