# Performance lab

Six small applications compare the same authored Three.js scene with runtime TSL
compilation and compiler-free precompiled replay:

- **The baseline:** one lit torus knot.
- **Reflection studio:** a room-generated PMREM atlas, metal and clearcoat.
- **Lava forge:** layered MaterialX noise, animated displacement, three shader variants.
- **Neon reactor:** a scene pass and multi-pass bloom.
- **Outpost racer:** a moving racer, buildings and track markers.
- **Material configurator:** a textured glTF shoe, environment lighting, fabric,
  clearcoat and iridescence variants.

The isolated release benchmark compares exact r186 and pinned r187dev roots and
preserved slim bundles. It stores captures, builds, screenshots and reports outside
the repository. A JSON matrix names each candidate explicitly:

```json
[
  { "id": "native186", "mode": "native", "threeRoot": "/absolute/three-r186" },
  { "id": "native187", "mode": "native", "threeRoot": "/absolute/three-r187dev" },
  { "id": "webgpu186", "mode": "source", "threeRoot": "/absolute/three-r186", "webgpuOnly": true },
  { "id": "webgpu187", "mode": "source", "threeRoot": "/absolute/three-r187dev", "webgpuOnly": true }
]
```

```sh
node packages/examples/performance/compare-releases.mjs --matrix=/tmp/matrix.json --out=/tmp/release-benchmark --rounds=5
# Capture and build once, then isolate the actual timed run from build CPU work:
node packages/examples/performance/compare-releases.mjs --matrix=/tmp/matrix.json --out=/tmp/release-benchmark --capture-only
node packages/examples/performance/compare-releases.mjs --matrix=/tmp/matrix.json --out=/tmp/release-benchmark --skip-capture --build-only
node packages/examples/performance/compare-releases.mjs --matrix=/tmp/matrix.json --out=/tmp/release-benchmark --skip-build
```

The default preparation workload has six distinct PBR graphs shared by twelve
objects and a uniform-driven compute kernel with exact Float32 readback checked
against a CPU oracle. `--workloads=materials` measures the same graphics without
compute, allowing a preserved bundle with an unsupported compute lifecycle to
remain a graphics baseline; it does not validate that bundle's compute path.
Set `"compileComputeAsync": true` on each compared preparation candidate to
await Three's real `compileComputeAsync()` before dispatch. This control requires
an asynchronous compute pipeline API call and rejects synchronous creation;
`computeAsync()` by itself only makes initialization/dispatch asynchronous.
`--workloads=pmrem-scene,pmrem-equirect,pmrem-cube` uses matching
fixed source textures and PBR lighting. Confirmation requires at least five
interleaved rounds. `--smoke --rounds=1` is explicitly diagnostic.

Cold runs use fresh browsers and profiles, disabled HTTP caching, and precompressed
Brotli assets. Warm frame and `compileAsync` cache-hit measurements reuse the same
page/device. Reports retain requested and unique shader counts/bytes by Three's
native stage labels, exact ordered bind-group identity duplication, layout/API
CPU submission, asynchronous pipeline completion intervals, queue submission CPU,
renderer initialization, compiler/replay binding and hydration phases. Submission
CPU, summed asynchronous latencies, overlapping async wall intervals and GPU pass
timestamps are distinct measurements. Shader module API time excludes asynchronous
driver work; GPU queue completion does not prove display presentation. Driver caches
remain uncontrolled. All candidates must match browser, adapter, device features,
viewport, draw counts, first images (50 dB) and compute output.
Material/compute and PMREM captures use separate artifact directories so an
unrelated PMREM shader family cannot inflate the material application's payload.
Each source candidate is compared with its own release's native image. r187's
minimum cube PMREM size is 256, so its PMREM timing measures different native
output/work from r186's size-64 scene atlas.

A candidate's `"compilationHints": true` enables only the isolated `main` entry
point hint trial. It preserves descriptors and leaves layout unspecified; hints
may be ignored by implementations and are never enabled in product code by this
benchmark. Only Three's native vertex/fragment/compute program labels receive
the known `main` hint; utility shaders and their other entry points remain untouched.
Preserved bundles keep their original verified source stamps rather
than being relabeled as current builds.

The 2026-10-13 preparation snapshot used an Apple M3 Max, Chrome 155.0.8059.40,
five interleaved fresh-browser rounds, and 30 warmup plus 30 timestamped frames
per run. Times below are medians; sizes cover all emitted JavaScript in decimal
kB. The default compute dispatch path was used in this snapshot.

| Candidate | First GPU completion | Render compileAsync | Gzip | Brotli |
| --- | ---: | ---: | ---: | ---: |
| Native r186 | 131.9 ms | 65.8 ms | 246.7 kB | 199.6 kB |
| Native r187dev | 124.1 ms | 56.6 ms | 221.9 kB | 183.4 kB |
| Source r186, both backends | 93.5 ms | 21.5 ms | 239.0 kB | 199.5 kB |
| Source r186, WebGPU only | 93.0 ms | 21.7 ms | 220.1 kB | 184.9 kB |
| Source r187dev, both backends | 90.4 ms | 18.1 ms | 238.1 kB | 199.6 kB |
| Source r187dev, WebGPU only | 87.4 ms | 18.1 ms | 218.5 kB | 184.4 kB |

All native/slim image comparisons were pixel-identical, Float32 compute output
had zero error, and repeated preparation created no new shader modules or
pipelines. The WebGPU-only r187 startup range was 79.3–89.8 ms versus r186's
73.9–94.0 ms, so the small release ranking is specific to this fixture/device.
Render preparation wall time includes graph/hydration, scheduling and driver
completion; it is not a measurement of the GPU shader compiler alone.
A separate five-round hint trial gave render-preparation medians of 20.9 → 21.8 ms
for r186 and 18.2 → 18.1 ms for r187; hints remain a benchmark control.

A second five-round control explicitly compiled compute pipelines asynchronously.
Every native/slim run submitted one async compute pipeline and zero synchronous
compute pipelines, with identical images and exact Float32 output. Slim median
compute preparation was 25.5 ms on r186 and 4.7 ms on r187dev; total compute plus
render preparation was 46.7 and 23.0 ms, respectively. Async submission avoids
blocking pipeline creation but does not guarantee lower elapsed time on every
release/device. These results are reported separately from the default workload.

```sh
pnpm --filter examples-performance compare
```

This builds both production paths, measures them sequentially in real Chrome
WebGPU, compares screenshots at two animation times, and serves the gallery at
<http://127.0.0.1:5190>. Chrome with WebGPU timestamp queries is required. Failed
visual or renderer checks prevent a scene from appearing as verified.

Keep iteration small:

```sh
# After changing one scene: recapture, build and measure only that scene.
pnpm --filter examples-performance compare --capture --scene=lava --rounds=1 --exit

# Re-measure existing builds (three rounds by default).
pnpm --filter examples-performance compare --skip-build --scene=lava --exit

# Check cold startup and first-frame correctness without warmed CPU/GPU loops.
pnpm --filter examples-performance compare --cold-only --skip-build --scene=bloom --rounds=1 --exit

# Open existing measured builds without starting a benchmark.
pnpm --filter examples-performance compare --skip-build --serve-only

# Refresh development captures without building or benchmarking.
pnpm --filter examples-performance compare --capture --capture-only --scene=studio

# Verify captured inputs and all authored markers without opening a browser.
pnpm --filter examples-performance verify
```

Use comma-separated scene IDs to select several. `--exit` closes the server after
measurement. `TSLP_SHOWCASE_PORT` changes the gallery port; capture uses 5191.
The selected examples run independently of the repository's full test tiers.

## Measurement

Each round launches a fresh Chrome process with an empty temporary browser
profile for each build, alternating build order. HTTP caching is disabled, service
workers are blocked, and a CDP audit rejects cached responses. Each
variant receives 120 warm-up frames and 120 measured frames at 960 × 640, DPR 1.
Variant materials are created on first selection. Development capture waits for
each variant to settle before switching, so asynchronous extraction cannot miss
the next variant's real render.

The PMREM examples keep their generated textures under stable names and register
them with `registerLiveTexture`. When the scene retains only the generated atlas,
the product example passes its original image through `pmremSourceTextures` to
`precompileAuxiliary`, preserving the actual source configuration for capture.

- **Shader nodes:** unique objects processed by Three's node builders, including
  auxiliary passes, cumulative through the selected variant. This does not count
  every live JavaScript object or the scene's Object3D hierarchy.
- **Cold first visit:** navigation through completion of the first GPU frame,
  including JavaScript loading and execution, renderer initialization, assets,
  PMREM and GPU pipeline creation. Browser launch is excluded. JavaScript is
  precompressed with Brotli quality 11 before launching Chrome; the CDP audit
  requires Brotli on every JavaScript response. This uses localhost without
  network throttling, so it does not simulate internet download latency.
  Transferred bytes and cache audit counts are shown.
  The first-visit result measures the initial variant; later variants are selected
  within the same visit.
  The OS/Metal driver cache is uncontrolled; this is browser-cold, not a guarantee
  of a machine that has never compiled these shaders.
  Scene module loading overlaps renderer initialization in both builds. Their
  reported durations are elapsed wall time and must not be added together; scene
  creation still waits for both the module and renderer/capture setup to finish.
- **First render CPU:** synchronous initial render call, including GPU pipeline
  creation triggered lazily by that draw. The final GPU queue wait includes any
  unfinished setup GPU work and driver compilation needed by the draw. No extra
  setup fence serializes work that would naturally overlap. Pipeline counts and
  API call time are reported separately; that API time does not measure
  asynchronous driver compilation. GPU completion is not a display-presentation
  timestamp.
- **Variant first use:** the initial variant uses the first-render measurement;
  subsequent variants include material creation, selection and the first render.
- **Frame CPU:** time spent updating the scene and submitting rendering commands.
- **Frame GPU:** real WebGPU timestamp queries across the frame's render passes.
  Missing GPU samples fail verification; they are never reported as zero.
- **Production JavaScript:** all emitted JavaScript files, summed separately as
  raw bytes and Brotli text mode at quality 11. Excludes HTML, models, textures
  and HTTP headers. Compression finishes before browser measurement and is
  cached by content hash, so it never competes with rendering. The server sends
  these Brotli bytes to clients that accept them and raw bytes otherwise.

The server keeps compressed assets under `dist/comparison/.compression-cache`,
separated by encoder policy and Node version. On restart, it verifies the encoded
checksum and checks that bounded decompression reproduces the current JavaScript
exactly. Changed or damaged entries are recompressed before Chrome opens. Removing
`dist/` clears this cache. It stores neither browser responses nor test results;
fresh-profile and disabled-HTTP-cache first-visit checks still run normally.
The focused cache check is `node --test scripts/performance-compression.test.mjs`
from the repository root.

Numbers are medians across rounds; raw CPU/GPU samples and per-round p95 values
are in `dist/comparison/report.json`. Node counting adds a small amount of work
to compilation. The full build uses plain Three.js with identity marker calls;
it does not load the precompile plugin, runtime or captured artifacts. The slim
build uses source mode. Both execute the same authored scene and asset paths.

Every visit checks the first image before warm-up against a repeat at the same
time, then compares the first full/slim images. This catches missing first-frame
pass inputs that later screenshot draws can hide. The `--cold-only` path writes
`dist/comparison/<scene>/cold-start.json` and skips steady-frame samples and other
variants; it does not mark the gallery's full benchmark as verified. Readiness
times end at GPU queue completion, not compositor presentation.

Full verification also requires equal geometry and draw counts, a bound PMREM atlas for
environment scenes, extra passes for bloom, zero builder calls in slim, visible
animation and variant changes, and PSNR ≥ 50 dB for every full/slim image pair.
Reports carry a hash of both measured builds; serving replaced build files
invalidates their old results. Generated measurements remain under ignored
`dist/`; captured shader artifacts are versioned build inputs.

Precompilation primarily removes runtime shader-graph compilation. It does not
reduce the scene's triangles or pixels. Small timing differences can be noise,
and some workloads can cost more CPU per frame in slim mode. The gallery reports
these outcomes without turning them into a claimed speedup. It also shows the
range of round medians and flags GPU timing when that range exceeds 1.5×.

Compiler-free here means the runtime TSL builder is removed. The browser and
driver still compile WGSL into GPU pipelines, and replay retains live objects,
binding updates and draw submission. Pipeline creation counts describe a different
cost from per-frame pipeline switches, binding commands and draw calls.

CPU profiles diagnose call costs and are collected separately from gallery
measurements. Enabling Chrome's sampling profiler changed the same warmed Game
page from roughly 2.2 ms/frame to 0.48 ms/frame on the local M3 Max, then back to
2.6 ms after profiling stopped. The cause is not yet established. Do not mix
profiled timings with ordinary runs, or treat an isolated helper benchmark as
a demonstrated frame-time improvement.

The Shopify shoe is © 2020 Shopify, Inc., [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
Its original attribution is in `public/shoe/README.md`; textures come from the
Three.js copy of Khronos' Materials Variants Shoe sample. The demo authors extra
material variants on the original textured geometry.
