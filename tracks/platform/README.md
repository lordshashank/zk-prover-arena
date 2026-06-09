# Platform track (parked)

Browser/WASM proving of the same pinned task, scored as `prove_seconds x peak_wasm_MiB`
under the wasm32 4 GB ceiling (`backend: 'Wasm'`, bb.js). This rewards *platform*
engineering — threading/COOP-COEP, memory64, SIMD, SRS/heap orchestration — which is
deliberately excluded from the algorithm boards at the repo root.

Needs the devDependencies installed (`npm i` at repo root): `@aztec/bb.js` + `pako`.

- `grade_wasm.mjs` / `board_wasm.mjs` — the WASM grader and board (strategy-based)
- `lib/` — isolated-process WASM prove runner + peak-heap measurement
- `boards/` — historical WASM results

Status: parked. The algorithm track at the repo root is the active arena; any memory
win there directly lowers the WASM peak too (same allocations).
