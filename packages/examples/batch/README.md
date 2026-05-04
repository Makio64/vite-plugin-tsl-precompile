# batch (example harness)

Runs the plugin and slim runtime against the 206 `webgpu_*.html` examples from a local three.js repo. Phase 6/7 gate.

## Target

Keep the extractor/codegen and slim-bundle load-smoke harnesses green enough to catch crashes, then use E2E PSNR for visual correctness. Current pass counts move quickly; use [STATUS.md](../../STATUS.md) for the latest curated snapshot and `packages/examples/batch/results/coverage-summary.md` for a generated visual table.

For the E2E harness, start with focused filters. It automates the real loop for stock examples: clean stock full-three reference, capture pass for auto-marked NodeMaterial artifacts, then slim replay with captured user and aux artifacts. A pass means replay reached a non-empty frame without unexpected browser errors and meets the PSNR pixel-diff threshold (30 dB by default). Use `--no-pixel-gate` for diagnostics when the goal is to inspect load/runtime failures separately from visual correctness. Many examples are expected to fail today; v0.1 beta should prioritize the PBR slice first: shadows, PMREM/environment/reflections, then transmission/viewport/reflector texture paths. Compute/storage remains experimental, while MRT and broad postprocessing are deferred.

The parallel E2E runner prints concise per-example progress by default and writes full details to `packages/examples/batch/results/e2e-report.json`. Pass `--verbose` or set `TSLP_E2E_VERBOSE=1` to forward page warnings/logs and worker boilerplate while debugging harness internals.

The E2E server automatically falls forward to the next free port when the requested port is occupied. Use `--port=<n>` to choose the first port and `--port-retries=<n>` to cap the retry window.

Animated examples compare the first fully loaded settled frame by default (`--target-tick=0`) so async asset timing does not masquerade as a shader regression. Use `--target-tick=<n>` when intentionally auditing a later animation phase.

Historical error buckets from the monolithic slim fork:

| Bucket | Cases | Plan-time disposition |
|---|---|---|
| "no node builder" | 70 | Should mostly dissolve — AOT runs the real builder, no stub holes. |
| `outputNode.context` | 12 | Needs `.precompile()` on outputNode passes (Phase 3 bloom demo). |
| `minFilter` | 10 | Seed material texture slots post-swap. |
| compute-node | 10 | Wrap computeAsync proxies in PrecompiledComputeNode. |
| `id` undefined | 8 | Hydrator weak-map keys. |
| `update` undefined | 5 | Per-frame update hooks. |

## Auto-mark mode

Source examples aren't written with `.precompile()` calls. The harness injects `material.precompile(exampleName + ':<materialId>')` on every material it discovers — proves the extractor's coverage on the broad TSL surface.

## Commands

```sh
pnpm test:batch
pnpm test:slim
pnpm test:e2e -- --filter=webgpu_lights_custom
node packages/examples/batch/run.mjs --three-repo=/path/to/three.js --filter=webgpu_backdrop
node packages/examples/batch/run-slim.mjs --three-repo=/path/to/three.js --filter=webgpu_backdrop
node packages/examples/batch/run-e2e.mjs --three-repo=/path/to/three.js --filter=webgpu_lights_custom
```

By default the scripts look for a sibling `../three.js` checkout from the repo root.
