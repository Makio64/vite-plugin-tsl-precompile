# batch (example harness)

Runs the plugin against the 206 `webgpu_*.html` examples from the three.js repo. Phase 6 gate.

## Baseline

The monolithic slim-bundle approach in `Makio64/three.js` branch `tsl-precompile` passes **68/199** examples.

## Target

**≥ 120/199** for v1 release. Error buckets (from `tsl-precompile-demo/slim-examples/tools/EXPERIMENT_SUMMARY.md`):

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

## Status

TODO (Phase 6). Scaffold only.
