# batch (example harness)

Runs the plugin and slim runtime against the 206 `webgpu_*.html` examples from a local three.js repo. Phase 6/7 gate.

## Baseline

The monolithic slim-bundle approach in `Makio64/three.js` branch `tsl-precompile` passes **68/199** examples.

## Target

For the extractor/codegen harness, keep at least **≥ 120/199** passing for v1 release. The current checked-in extractor report is **197/198** candidates passing with **8** skipped.

For the slim-bundle load-smoke harness, every candidate should either load cleanly or fail with an expected `tsl-precompile/slim` / `tsl-precompile/aux` loud error. The current checked-in slim report is **198/198** candidates passing with **0** unexpected errors and **8** skipped.

For the E2E harness, start with focused filters. It automates the real loop for stock examples: full-three capture with auto-marked NodeMaterials, then slim replay with captured user and aux artifacts. A pass means replay reached a non-empty frame without unexpected browser errors; it is not yet a pixel-diff gate. Many examples are expected to fail today because serialized bindings/textures/storage paths still need richer runtime hydration.

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
