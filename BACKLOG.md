# Backlog

A flat, deduplicated list of every open problem/feature gap surfaced across the
last seven sessions, structured so multiple agents (human or AI) can pick
items without colliding on files. See [MULTI_AGENT.md](./MULTI_AGENT.md) for
the workflow.

Each task lists:
- **ID** — short stable handle (`bg-blur`, `lights`, etc.).
- **Files** — paths the task is expected to touch. **If two tasks share a
  file, run them sequentially**, not in parallel.
- **Why** — what the user sees today and the suspected root cause.
- **Done when** — concrete checkable outcome.
- **Reference** — examples that exercise the bug.

Pri legend: **P0** breaks rendering, **P1** wrong output, **P2** correctness/polish, **P3** nice-to-have.

---

## Lighting & PBR

### `lights-direct` — P0
Direct lights (point/dir/spot/area) are frozen at capture-time snapshots.
Animated `light.intensity` / `light.position` / etc. don't propagate.

- **Files**: `packages/plugin/src/vendor/extractUniformPlan.js`, `packages/plugin/src/emit-updater.js`, `packages/runtime/src/hydrator.js`
- **Why**: Light uniforms come from `LightNode` instances three.js builds at compile time. The extractor classifies them as anonymous `uniform.live` and freezes the snapshot value.
- **Done when**: `webgpu_clearcoat` PBR spheres are no longer pure black on three of four; light intensity ramp visible.
- **Reference**: `webgpu_clearcoat`, `webgpu_lights_phong`, `webgpu_lights_pointlights`.

### `lights-clone-scene` — P1 (alt path to `lights-direct`)
At capture time, the throwaway scene in `precompile-marker.js` has no lights
(we deliberately don't reparent them; that would detach from the user's
real scene). LightsNode therefore emits a no-light path.

- **Files**: `packages/runtime/src/precompile-marker.js`
- **Why**: Need to clone (not reparent) lights into the throwaway scene so capture sees the right LightsNode shape.
- **Done when**: PBR materials capture per-light uniforms in their plan.
- **Reference**: `webgpu_clearcoat` plus any PBR scene with lights.

---

## Backgrounds

### `bg-pmrem` — P1
HDR cubemap backgrounds with `backgroundBlurriness > 0` capture a PMREM-
prefiltered 2D texture in the WGSL. The harness wires the **raw** cubemap
to the artifact's `_textureRefs`, which produces black sky on replay.
Attempted in session 7 but the GPU resource wasn't ready by bind-group
recording time.

- **Files**: `packages/examples/batch/run-e2e.mjs` (only — this is harness-only)
- **Why**: `__wireBackgroundTextures` needs to detect PMREM-expecting bindings and run `PMREMGenerator.fromCubemap(scene.background)` then re-wire on the next frame.
- **Done when**: `webgpu_compute_water` / `_cloth` / `_particles_fluid` backgrounds match the capture's blurred sky.
- **Reference**: `webgpu_compute_water`, `webgpu_compute_cloth`, `webgpu_compute_particles_fluid`.

### `bg-node-hash` — P1
`scene.backgroundNode = mix(color(...), color(...), screenUV.y)` (or any TSL
graph) is replaced by the slim's TSL stub proxy on replay. The patched
Background.js calls `loadAux('background', hashNodeGraphSync(stubProxy))`
which returns a different hash than the captured graph, so the wrong (or
no) artifact loads.

- **Files**: `packages/runtime/src/aux-loader.js`, possibly `packages/runtime/src/graph-hash.js`
- **Why**: `loadAux` already has a shape-fallback (returns the first registered artifact for the shape). Verify it fires, and if it does, ensure the harness registers exactly one background-aux per scene.
- **Done when**: `webgpu_compute_particles_snow` (or our `examples/background` demo's gradient bg) renders the captured backgroundNode artifact instead of clearing white.
- **Reference**: `webgpu_compute_particles_snow`, `examples/background`.

---

## Materials & Shaders

### `userdata-uniform` — P2
`material.rotationNode = userData('rotation', 'float')` (sprites and similar)
freezes to 0 in replay. Currently downgraded from `unknown` to `blocked` so
capture doesn't throw, but the live read path is missing.

- **Files**: `packages/plugin/src/vendor/extractUniformPlan.js`, `packages/plugin/src/emit-updater.js`, `packages/runtime/src/hydrator.js`
- **Why**: `userData(name, type)` reads `frame.object.userData[name]`. Need an `object3d.userData` source kind that the codegen emits as `frame.object.userData.<name>`.
- **Done when**: `webgpu_sprites` shows per-sprite rotation animation matching capture.
- **Reference**: `webgpu_sprites`.

### `tone-mapping` — P1
Replay frames look washed-out / over-bright vs capture. Examples like
`webgpu_compute_water` (ACES, exposure 0.5) and `webgpu_compute_cloth`
(Neutral, exposure 1) bake their tone mapping into the render-output
artifact at capture, but the runtime may not be honoring the
`renderer.toneMapping` / `toneMappingExposure` carried in the
render-output aux config hash.

- **Files**: `packages/runtime/src/aux-marker.js` (the `render-output` aux config hash) + harness check
- **Why**: Capture-time hash includes `{ toneMapping, outputColorSpace }`; if the user's renderer setting at replay differs from capture, the hash misses.
- **Done when**: `webgpu_compute_water`, `_cloth`, `_particles_fluid` PSNR ≥ 25 dB.
- **Reference**: `webgpu_compute_water`, `webgpu_compute_cloth`, `webgpu_compute_particles_fluid`.

### `sprite-flip-y` — P2
Sprite texture appears flipped on Y axis vs capture (user-reported).

- **Files**: `packages/plugin/src/vendor/extractUniformPlan.js` (capture `texture.flipY`) + `packages/runtime/src/hydrator.js` (apply on snapshot/identity rebuild)
- **Why**: `Texture.flipY` defaults to true for HTMLImageElement; loaders set it. The captured artifact may not record flipY, and the replay's fresh texture may have a different flipY.
- **Done when**: Sprite quads show texture in the same orientation as capture.
- **Reference**: `webgpu_sprites`.

---

## Compute & Storage

### `compute-kernel-replay` — P2
`webgpu_compute_particles` particles are invisible in replay (just the grid
floor renders). The compute kernel that initializes particle positions
isn't running in slim, so positions stay at origin / zero.

- **Files**: `packages/examples/batch/run-e2e.mjs` (TSL stub for `instancedArray`/compute), `packages/runtime/src/precompile-marker.js`, possibly `packages/plugin/src/vendor/compileTSL.js`
- **Why**: The harness's TSL stub returns proxies for `instancedArray()`, `Fn(...).compute(count)`. Those proxies don't `isComputeNode === true` so the harness's `computeAsync` filter rejects them.
- **Done when**: `webgpu_compute_particles` particle blob renders.
- **Reference**: `webgpu_compute_particles`, `webgpu_compute_points`, `webgpu_compute_particles_rain`, `webgpu_compute_particles_snow` (partially).

### `storage-texture-3d` — P2
`webgpu_compute_texture_3d` and similar 3D / array storage textures don't
fully render in replay.

- **Files**: `packages/runtime/src/hydrator.js` (storage-texture binding kinds), `packages/runtime/src/writers.js`
- **Why**: Hydrator handles `storage-buffer` but the compute-fed `Storage3DTexture` / `StorageArrayTexture` paths aren't fully wired.
- **Done when**: `webgpu_compute_texture_3d` shows the volumetric output.
- **Reference**: `webgpu_compute_texture_3d`, `webgpu_compute_texture_pingpong`.

### `compute-birds-capture-throw` — P2
Capture throws on `webgpu_compute_birds`'s NodeMaterial — different
`uniform.live` case than the one downgraded in session 5.

- **Files**: `packages/plugin/src/emit-updater.js`
- **Why**: A specific `uniform.live` source pattern still hits `severity: 'unknown'`. Check the throw message to see which kind, then handle it.
- **Done when**: Capture for `webgpu_compute_birds` produces a non-zero artifact.
- **Reference**: `webgpu_compute_birds`.

---

## Cameras & Render Targets

### `array-camera` — P2
`webgpu_camera_array` (4×4 ArrayCamera multi-viewport) renders an empty
canvas in replay despite capturing artifacts. Slim's renderer either
doesn't drive the per-subcamera viewport loop, or our patch breaks it.

- **Files**: `packages/plugin/src/three-rewrite.js` (the WebGPURenderer rewrite), maybe `packages/runtime/src/slim-entry.js`
- **Why**: ArrayCamera renders the same scene N times into N viewports. Each subcamera triggers a render pass. Our patches may collapse or skip these.
- **Done when**: `webgpu_camera_array` shows the 4×4 grid of camera views.
- **Reference**: `webgpu_camera_array`.

### `multiple-rendertargets` — P3
Examples like `webgpu_multiple_rendertargets`, `_readback` not yet
sweep-tested but likely have mrt-specific binding paths.

- **Files**: investigate first.
- **Reference**: `webgpu_multiple_rendertargets*`, `webgpu_mrt*`.

---

## Animation & Determinism

### `psnr-pacing` — P1
PSNR scores stay low for animated examples because capture (8 s wait) and
replay (5 s wait) sample different animation phases. Fix is harness-only.

- **Files**: `packages/examples/batch/run-e2e.mjs`
- **Why**: Use `Page.clock.install()` (Playwright) to fix `Date.now()` and `requestAnimationFrame` so capture and replay run at the same simulated time, OR snap both to a fixed frame after a known number of `setAnimationLoop` ticks.
- **Done when**: PSNR for `webgpu_camera`, `webgpu_clearcoat`, `webgpu_animation_retargeting*` ≥ 25 dB without other code changes.
- **Reference**: every animated example.

---

## Backdrop / Postprocessing

### `backdrop-empty` — P2
`webgpu_backdrop`, `webgpu_backdrop_area` produce empty replay frames
(brightness < 0.02). Likely the post-processing aux pass isn't being
captured / loaded.

- **Files**: `packages/runtime/src/aux-marker.js` (backdrop discovery), `packages/runtime/src/aux-loader.js`
- **Why**: Backdrop renders the scene into a render target then composites it. The `precompileAuxiliary` path may need a backdrop-specific shape.
- **Done when**: `webgpu_backdrop` replay shows the backdrop scene.
- **Reference**: `webgpu_backdrop`, `webgpu_backdrop_area`, `webgpu_backdrop_water`.

---

## Test infrastructure & quality of life

### `harness-fixed-clock` — see `psnr-pacing`

### `slim-load-smoke-pixel-gate` — P3
`pnpm test:slim` (198/198) only verifies module load. Should assert at
least 5 curated examples produce non-empty pixel output.

- **Files**: `packages/examples/batch/run-slim.mjs`
- **Done when**: smoke harness has a `pixel-gate` flag that fails if any of N curated examples come out blank.

### `subpackage-readmes` — P3
`packages/plugin/`, `packages/runtime/` lack README.md. npm renders empty
package pages without one. Blocks publishing.

- **Files**: `packages/plugin/README.md`, `packages/runtime/README.md`
- **Done when**: both files exist with install + usage section.

### `migration-md` — P3
`STATUS.md` references a `MIGRATION.md` that doesn't exist.

- **Files**: `MIGRATION.md` (root), or remove references.

---

## Coordination matrix

When two tasks share a file (or near it), they must run **sequentially**, not
in parallel. This grid tells you which pairs collide:

| File | Tasks |
|---|---|
| `runtime/src/hydrator.js` | `lights-direct`, `userdata-uniform`, `storage-texture-3d`, `sprite-flip-y` |
| `plugin/src/vendor/extractUniformPlan.js` | `lights-direct`, `userdata-uniform`, `sprite-flip-y` |
| `plugin/src/emit-updater.js` | `lights-direct`, `userdata-uniform`, `compute-birds-capture-throw` |
| `examples/batch/run-e2e.mjs` | `bg-pmrem`, `compute-kernel-replay`, `psnr-pacing` |
| `runtime/src/aux-loader.js` | `bg-node-hash`, `backdrop-empty` |
| `runtime/src/precompile-marker.js` | `lights-clone-scene`, `compute-kernel-replay` |
| `runtime/src/writers.js` | `storage-texture-3d` |
| `plugin/src/three-rewrite.js` | `array-camera` |

Tasks with NO shared files can run safely in parallel:
- `bg-pmrem` (harness only) ‖ `lights-clone-scene` (precompile-marker only) ‖ `array-camera` (three-rewrite only)
- `subpackage-readmes` ‖ `migration-md` ‖ anything (docs-only)
- `slim-load-smoke-pixel-gate` (run-slim.mjs only) ‖ anything that doesn't touch `run-slim.mjs`
