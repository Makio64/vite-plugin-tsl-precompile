# examples-pmrem-debug

Tiny WebGPU PMREM / environment-map repro scenes for isolating IBL,
reflection, and transmission replay issues without the larger upstream
examples.

Pages:

- `/equirect.html` — generated equirectangular `CanvasTexture` used as
  `scene.environment` and `scene.background`, covering the source-texture →
  PMREM auxiliary path.
- `/cubemap.html` — generated six-face `CubeTexture`, covering cubemap source
  orientation and PMREM routing.
- `/from-scene.html` — `PMREMGenerator.fromScene()` produces the environment
  texture directly, covering scene-generated CubeUV texture routing.
- `/transmission.html` — same equirect environment plus a
  `MeshPhysicalNodeMaterial` with transmission/thickness, covering the
  glass/refraction-adjacent material path.

Run:

```sh
pnpm dev:pmrem-debug
# or
pnpm --filter examples-pmrem-debug dev
```

Build (run `dev` once first and visit the pages so `.precompile()` captures
package-local artifacts under `./artifacts/`, then):

```sh
pnpm --filter examples-pmrem-debug build
```

Capture and slim-replay E2E:

```sh
pnpm --filter @tsl-precompile/runtime build:slim
pnpm --filter examples-pmrem-debug test:e2e
```

The E2E runner reuses the batch harness and the `e2e-cases.json` matrix. It
saves capture/replay PNGs under `packages/examples/batch/results/shots/` and
writes `packages/examples/batch/results/pmrem-debug-e2e-report.json`.

Use `--no-pixel-gate` when you only want to confirm that capture and replay
produce frames:

```sh
pnpm --filter examples-pmrem-debug test:e2e -- --no-pixel-gate
```
