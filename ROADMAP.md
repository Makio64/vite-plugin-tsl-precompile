# Roadmap

Eight phases. Each has a release gate that must pass before moving on.

> Phases 1–7 are shipped; active work is Phase 8 (launch). For the **structural** work
> that runs alongside the phase gates — slim-support runtime module, hydrator
> decomposition, shared extractor↔codegen↔runtime contract, three.js fork seam,
> trustworthy coverage measurement — see [ARCHITECTURE_EVOLUTION.md](./ARCHITECTURE_EVOLUTION.md)
> (P0→P3). Several items there are prerequisites for closing the Phase 8 fidelity
> gate at scale.

## Phase 1 — Node harness — ✅ shipped

Node-side `compileTSL` + `extractUniformPlan` + stable hash; artifacts byte-match the browser baseline. See [STATUS.md phase table](STATUS.md#phase-completion).

## Phase 2 — `.precompile(name)` + dev capture — ✅ shipped

Marker, dev server, HMR; unsupported-kind errors throw synchronously at the call site.

## Phase 3 — AOT codegen — ✅ shipped (core kinds)

`emit-updater.js` covers camera/object/material/time/uniform/scene with direct `DataView` writes. Per-kind fixtures byte-match.

## Phase 4 — Build-time rewrite — ✅ shipped

Babel transform + virtual modules + `__applyPrecompiled`; three-layer hash check fires on corrupt artifact.

## Phase 5 — Coverage matrix — ✅ core done

- `packages/plugin/test/coverage/` — one fixture per (material class × TSL node kind × pipeline context) cell.
- **Gate**: 100% of cells either covered or documented-blocked. Blocked cells throw clear errors at `.precompile()` time.

## Phase 6 — 206-example batch harness — ✅ shipped

- Auto-mark mode injects `.precompile()` on every material; the batch runners ([packages/examples/batch/run-e2e.mjs](packages/examples/batch/run-e2e.mjs), [run-capture-replay.mjs](packages/examples/batch/run-capture-replay.mjs), [run-coverage-summary.mjs](packages/examples/batch/run-coverage-summary.mjs)) replaced the original `batch-precompile.mjs` sketch.
- **Gate (recurring)**: broad extractor/codegen load-smoke stays above the launch threshold; use [STATUS.md](STATUS.md) for the current curated count.

## Phase 7 — Slim runtime bundle — ✅ shipped

- Rollup output at [packages/runtime/build/three.webgpu.slim.js](packages/runtime/build/three.webgpu.slim.js); Vite alias `three/webgpu` → slim bundle when `tslPrecompile({ slim: true })` is active.
- **Gate (recurring)**: ≤ 300 KB gzip and 0 unexpected slim-bundle load-smoke errors; use [STATUS.md](STATUS.md) for the current curated count.

## Phase 8 — Launch

- Docs, three preview demos, migration guide, announcement.
- v0.1 beta support slice: `MeshStandardNodeMaterial` / `MeshPhysicalNodeMaterial`, texture maps, env maps / PMREM, direct lights, shadows, material uniforms, and stable artifact invalidation.
- Mark compute/storage as experimental and MRT / broad postprocessing as deferred in release messaging.
- **Gate**: the beta support slice has representative PSNR coverage, npm dry-runs pass for plugin/runtime, and one external adopter reports success.
