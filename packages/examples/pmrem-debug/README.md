# examples-pmrem-debug

Tiny WebGPU PMREM / environment-map repro scenes for isolating IBL,
reflection, and transmission replay issues without the larger upstream
examples.

Pages:

- `/equirect.html` — generated equirectangular `CanvasTexture` passed through
  `PMREMGenerator`, covering the source-texture → captured source/GGX path.
- `/cubemap.html` — generated six-face `CubeTexture`, covering cubemap source
  orientation and PMREM routing.
- `/from-scene.html` — `PMREMGenerator.fromScene()` produces the environment
  texture directly from four explicitly captured environment materials,
  covering scene-generated CubeUV texture routing without a live compiler.
- `/transmission.html` — same equirect environment plus a
  `MeshPhysicalNodeMaterial` with transmission/thickness, covering the
  glass/refraction-adjacent material path.

Run:

```sh
pnpm dev:pmrem-debug
# or
pnpm --filter examples-pmrem-debug dev
```

The production fixture uses `slim: 'source'` and calls the compiler-free
`PMREMGenerator` explicitly. Capture helpers are development-only, so a
successful build is also the no-full-renderer/compiler closure gate.
Captured source families are keyed by `pmrem-support@1` sampling topology, not
raw texture identity: equirect, cubemap, and from-scene profiles stay separate,
and sample/component type or filterability splits a family only when Three's
WGSL or bind layout changes.
The visible floor/metal/rough materials intentionally reuse one artifact name
across the equirect, cubemap, and transmission routes. This is a regression
guarantee: topology-equivalent captures must merge while the runtime keeps the
PMREM atlas UUID, dimensions, and derived CubeUV scalars as one exact live
relation. The from-scene route owns three explicit marker names because it
first renders four environment materials on the same renderer; in Three r185
that produces a distinct main-material builder layout under the same observable
render selector. The literal marker branch is the safe compiler-free route
choice. Equirectangular and cubemap backgrounds use explicit friendly aux names
so replay never guesses between the two captured background graphs.
The from-scene route passes `pmremSceneSizes: [64]` to
`precompileAuxiliary()`: the resulting CubeUV texture cannot retain the
`fromScene(..., { size: 64 })` request for automatic discovery.

`pnpm recapture:examples --example pmrem-debug` builds and previews all four
source-slim pages before committing the refreshed artifact directory. Each
route must report a real PMREM output and rendered frame, with zero capture
requests, no browser/WebGPU failures, and nonblank decoded pixel evidence.

Recapture package-local material and `internal-pass@1` artifacts with a
WebGPU-enabled Chromium before building. With the dev server running on its
configured port:

```sh
pnpm --filter vite-plugin-tsl-precompile recapture \
  --url http://127.0.0.1:5187 \
  --paths equirect.html,cubemap.html,from-scene.html,transmission.html \
  --timeout 60000
```

Then build:

```sh
pnpm --filter examples-pmrem-debug build
```

Capture and slim-replay E2E:

```sh
pnpm --filter @tsl-precompile/runtime build:slim
pnpm --filter examples-pmrem-debug test:e2e
```

The E2E runner reuses the broad batch harness and the `e2e-cases.json` matrix. It
saves capture/replay PNGs under `packages/examples/batch/results/shots/` and
writes `packages/examples/batch/results/pmrem-debug-e2e-report.json`.
That harness can boot a shared-device full renderer for unrelated legacy
coverage; use this package's source-slim build/preview for the strict no-full
PMREM gate.

Use `--no-pixel-gate` when you only want to confirm that capture and replay
produce frames:

```sh
pnpm --filter examples-pmrem-debug test:e2e -- --no-pixel-gate
```
