# examples-postprocessing-debug

Tiny WebGPU post-processing repro scenes for isolating `PassNode` /
`RenderPipeline` failures without the larger upstream examples — the
post-processing counterpart of `examples-shadow-debug`.

All four pages share the same minimal scene (floor + cube + emissive sphere,
plain `MeshStandardNodeMaterial` materials marked with `.precompile()`) and
differ only in `postProcessing.outputNode`. They are ordered easiest → most
complex, and each mirrors the matching upstream `webgpu_postprocessing*`
example, so a failing page maps directly to an upstream regression:

| Page | `outputNode` | Mirrors |
| --- | --- | --- |
| `/passthrough.html` | `pass(scene, camera).getTextureNode()` | `webgpu_postprocessing.html` (the PassNode → screen path) |
| `/bloom.html` | `scenePassColor.add( bloom(scenePassColor) )` | `webgpu_postprocessing_bloom.html` |
| `/fxaa.html` | `fxaa( renderOutput( pass(scene, camera) ) )` | `webgpu_postprocessing_fxaa.html` |
| `/gtao.html` | MRT `pass.setMRT(mrt({ output, normal }))` + `ao(depth, normal, camera)` | `webgpu_postprocessing_ao.html` / `GTAONode` docs |

Run:

```sh
pnpm dev:postprocessing-debug
# or
pnpm --filter examples-postprocessing-debug dev
```

Build:

```sh
pnpm --filter examples-postprocessing-debug build
```

Capture and slim-replay E2E:

```sh
pnpm --filter @tsl-precompile/runtime build:slim   # once, so the slim bundle is fresh
pnpm --filter examples-postprocessing-debug test:e2e
```

The E2E runner reuses the batch harness and the `e2e-cases.json` matrix. It
saves capture/replay PNGs under `packages/examples/batch/results/shots/` and
writes `packages/examples/batch/results/postprocessing-debug-e2e-report.json`.

Use `--no-pixel-gate` when you only want to confirm that capture and replay
produce frames:

```sh
pnpm --filter examples-postprocessing-debug test:e2e -- --no-pixel-gate
```
