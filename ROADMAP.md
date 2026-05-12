# Roadmap

Eight phases. Each has a release gate that must pass before moving on.

> For the **structural** work that runs alongside the phase gates — extracting the
> slim-support runtime module, splitting the hydrator, a shared extractor↔codegen↔runtime
> contract, de-duplicating the graph hasher, hardening the three.js fork seam, trustworthy
> coverage measurement — see [ARCHITECTURE_EVOLUTION.md](./ARCHITECTURE_EVOLUTION.md)
> (prioritized P0→P3). Several of those items are prerequisites for closing the Phase 8
> fidelity gate at scale.
> First wedges are now in place for the shared contract, graph hasher,
> kind registry / artifact validator, tier-1 coverage CI gate,
> Three.js compat probe, updater parse guard, and
> `runtime/slim-support`; the next work is to deepen those seams rather than
> add more harness-only fixes.

## Phase 1 — Node harness

- Port `compileTSL.js` + `extractUniformPlan.js` into `packages/plugin/src/vendor/`.
- Mock WebGPU device captures WGSL strings instead of submitting.
- `hash.js` produces a stable sha256 over the normalized TSL graph + three version + plugin version.
- **Gate**: every artifact produced in Node byte-matches the browser-produced baseline on the ocean, bloom, and compute fixtures.

## Phase 2 — `.precompile(name)` + dev capture

- `Material.prototype.precompile(name)` in `packages/runtime/src/precompile-marker.js`. Dev behaviour: extract + POST to dev server. Prod behaviour: transform-rewritten.
- Dev server writes `artifacts/<name>.<hash>.json`, updates `manifest.json`, fires HMR.
- **Gate**: unsupported-kind errors throw synchronously at the call site with the offending node kind.

## Phase 3 — AOT codegen

- `emit-updater.js` emits a static `updater.js` per artifact, covering every `source.kind`.
- `packages/runtime/src/writers.js` — `writeMat4 / writeVec4 / writeF32 / writeColor`.
- **Gate**: per-kind fixture — descriptor JSON → generated JS → byte-match UBO against the current hydrator's output.

## Phase 4 — Build-time rewrite

- `babel-transform.js` rewrites `.precompile('name')` to `__applyPrecompiled(this, import(...), expectedHash)`.
- Virtual module `virtual:tsl-precompile/<name>` resolves to artifact JSON + generated updater.
- **Gate**: three-layer hash check (transform, build-output, runtime) all fire on corrupted artifact; demos pixel-identical dev vs prod.

## Phase 5 — Coverage matrix

- `packages/plugin/test/coverage/` — one fixture per (material class × TSL node kind × pipeline context) cell.
- **Gate**: 100% of cells either covered or documented-blocked. Blocked cells throw clear errors at `.precompile()` time.

## Phase 6 — 206-example batch harness

- Port the `batch-precompile.mjs` harness. Auto-mark mode injects `.precompile()` on every material.
- **Gate**: broad extractor/codegen load-smoke stays above the launch threshold; use [STATUS.md](STATUS.md) for the current curated count.

## Phase 7 — Slim runtime bundle

- Rollup `packages/runtime/build/three.webgpu.slim.js`. Vite alias `three/webgpu` → slim bundle when the plugin is active.
- **Gate**: ≤ 300 KB gzip and 0 unexpected slim-bundle load-smoke errors; use [STATUS.md](STATUS.md) for the current curated count.

## Phase 8 — Launch

- Docs, three preview demos, migration guide, announcement.
- v0.1 beta support slice: `MeshStandardNodeMaterial` / `MeshPhysicalNodeMaterial`, texture maps, env maps / PMREM, direct lights, shadows, material uniforms, and stable artifact invalidation.
- Mark compute/storage as experimental and MRT / broad postprocessing as deferred in release messaging.
- **Gate**: the beta support slice has representative PSNR coverage, npm dry-runs pass for plugin/runtime, and one external adopter reports success.
