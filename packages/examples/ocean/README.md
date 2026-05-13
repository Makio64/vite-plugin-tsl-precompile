# ocean (example)

Flagship demo. Mirrors three.js' stock `webgpu_ocean.html` so the canonical hand-test exercises every surface the plugin cares about in one example:

- `WaterMesh` (PlaneGeometry 10 000 × 10 000 + `waternormals.jpg`) → `.precompile('ocean-water')`
- `SkyMesh` (turbidity / rayleigh / clouds / sun) → `.precompile('ocean-sky')`
- `PMREMGenerator.fromScene(sky)` → `scene.environment` (aux PMREM convolution)
- `RenderPipeline` with `scenePass + bloom(...)` (aux post-process)
- `OrbitControls` + Inspector parameter panel for live tweaking

**Purpose:** end-to-end smoke for the dev capture endpoint, runtime marker, auxiliary capture (`background`, `pmrem`, `post`), and the `@tsl-precompile/inspector-panel` mount. Also the spawn target for `packages/examples/batch/run-capture-replay.mjs` and `run-inspector-smoke.mjs`.

## Assets

`public/textures/waternormals.jpg` is a copy of `examples/textures/waternormals.jpg` from three.js r184 — three's npm package doesn't ship its `examples/textures/`, so we vendor it locally.

## Run

```sh
pnpm dev:ocean
# captured artifacts land under packages/examples/ocean/artifacts/
```
