# bloom (example)

Post-processing demo: `RenderPipeline.outputNode = fxaa(bloom(pass(scene, camera)))`. Validates that post-FX TSL chains extract cleanly when a child pass material is `.precompile`d.

## Status

Demo scaffold for post-processing coverage. Use it when extending aux capture for `PostProcessing.outputNode` and bloom-style render pipelines.

```sh
pnpm dev:bloom
```
