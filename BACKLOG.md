# Backlog

A flat, deduplicated list of every open problem/feature gap. Structured so
multiple agents (human or AI) can pick items without colliding on files. See
[MULTI_AGENT.md](./MULTI_AGENT.md) for the parallel-agent workflow.

Each task lists:
- **ID** — short stable handle (`bg-blur`, `lights`, etc.).
- **Files** — paths the task is expected to touch. **If two tasks share a
  file, run them sequentially**, not in parallel.
- **Why** — what the user sees today and the suspected root cause.
- **Done when** — concrete checkable outcome.
- **Reference** — examples that exercise the bug.

Pri legend: **P0** breaks rendering, **P1** wrong output, **P2** correctness/polish, **P3** nice-to-have.

> Round 1 of parallel agent work landed 11 tasks (9 fully, 2 partial). See
> [CONTINUATION_PLAN.md](./CONTINUATION_PLAN.md) for the per-agent reports.
> Items marked **CARVE-OUT** below are follow-ups surfaced when an agent
> stopped at the file boundary of a related fix.

---

## Lighting & PBR

### `lights-extra-types` — P2
The `lights-direct` round handled `light.position`/`color`/`viewPosition`/
`targetPosition`/`cutoffDistance`/`decayExponent`/`coneCos`/`penumbraCos`
for the common point/spot/directional set. RectAreaLight, IES spotlight, and
projector-light each have their own UniformNodes (irradiance LUTs, IES
profile, projector matrix) that aren't yet covered.

- **Files**: `packages/plugin/src/vendor/extractUniformPlan.js`, `packages/plugin/src/emit-updater.js`, `packages/runtime/src/hydrator.js`
- **Done when**: `webgpu_lights_rectarealight`, `webgpu_lights_ies_spotlight`, `webgpu_lights_projector` no longer go pure black on PBR meshes.
- **Reference**: `webgpu_lights_rectarealight`, `webgpu_lights_ies_spotlight`, `webgpu_lights_projector`.

---

## Backgrounds

### `bg-node-render-pipeline` — P2 — CARVE-OUT from `bg-node-hash`
Even when `loadAux('background', <stub-hash>)` correctly returns the captured
background-aux artifact (verified for `webgpu_compute_particles_snow` after
the `bg-node-hash` fix landed), the bg mesh still renders solid white.
Something downstream of the artifact load doesn't actually consume the
captured WGSL — likely the bg PrecompiledMaterial's bind-group/UBO sizing,
the `Background.js` rewrite, or the harness's bg material swap.

- **Files**: `packages/runtime/src/hydrator.js`, `packages/plugin/src/three-rewrite.js`, `packages/examples/batch/run-e2e.mjs`
- **Done when**: `webgpu_compute_particles_snow` and `examples/background` show the captured TSL gradient instead of solid white.
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

### `tone-mapping` — P1 — PARTIAL, follow-ups below
Round-1 `tone-mapping` agent added `toneMappingExposure` to the
`render-output` aux config hash so different exposures don't collide.
Replay frames still look brighter than capture because two follow-up bugs
remain (carve-outs below).

- **Files (already done in `aux-marker.js`)**: hash now includes exposure.
- **Reference**: `webgpu_compute_water`, `webgpu_compute_cloth`, `webgpu_compute_particles_fluid`.

### `hash-graph-vs-config` — P1 — CARVE-OUT from `tone-mapping`
The slim's render-output rewrite (`packages/plugin/src/three-rewrite.js`
line ~382, `buildPrecompiledExpr('render-output', rhs, …)`) emits
`loadAux('render-output', hashNodeGraphSync(this._nodes.getOutputNode(t.texture), …))`.
But `aux-marker.js` registers under `hashPlainConfigSync({...})`. The
hashes never match; replay always falls through `aux-loader.js`'s
shape-fallback (returns first registered artifact for the shape, with a
warning). Works for single-example bundles but fragile.

- **Files**: `packages/plugin/src/three-rewrite.js`
- **Why**: Switch the renderer's render-output rewrite from
  `hashNodeGraphSync(outputNode)` to `hashPlainConfigSync({toneMapping,
  toneMappingExposure, outputColorSpace})` so the slim runtime exact-matches
  the aux registry.
- **Done when**: replay's render-output `loadAux` reports an exact-hash hit
  (no shape-fallback warning) on `webgpu_compute_water` etc.
- **Reference**: `webgpu_compute_water`, `webgpu_compute_cloth`, `webgpu_compute_particles_fluid`.

### `hydrator-toneMappingExposure` — P1 — CARVE-OUT from `tone-mapping`
The hydrator's `writeUniformGroup` has no `renderer.toneMappingExposure`
case. The captured render-output artifact's exposure uniform is currently
classified as anonymous `uniform.live` and falls back to its `valueSnapshot`
(captured exposure value). Animated exposure changes after capture won't
propagate. Also: when the render-output's `render` group is `shared: true`
but scene materials don't use the exposure slot, the shared UBO may be
allocated with `byteLength=128` (camera matrices only); the exposure write
at offset 128 either gets clipped or lands in a separate UBO.

- **Files**: `packages/runtime/src/hydrator.js`, possibly `packages/plugin/src/vendor/extractUniformPlan.js`
- **Why**: Add `else if (kind === 'renderer.toneMappingExposure')` reading
  `frame.renderer.toneMappingExposure`. Audit the shared-UBO sizing path
  (`findUniformGroupShared` + `cloneBinding`) to make sure the buffer is
  big enough for output-transform slots even when scene materials don't use them.
- **Done when**: animated exposure ramp visible in replay; PSNR for
  `webgpu_compute_water`/`_cloth`/`_particles_fluid` improves vs the
  pre-`hash-graph-vs-config` baseline.
- **Reference**: same as above.

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

### `array-camera-per-cell` — P3 — CARVE-OUT from `array-camera`
`webgpu_camera_array` now renders the 6×6 grid layout, but every cell shows
the parent ArrayCamera's view because `precompile-marker.js`'s synthetic
scene uses a regular `PerspectiveCamera`. The captured WGSL bakes
`render.cameraViewMatrix` (single uniform) instead of
`_cameraViewMatrixArray.element(cameraIndex)`.

- **Files**: `packages/runtime/src/precompile-marker.js`, possibly `packages/plugin/src/vendor/compileTSL.js`
- **Why**: Either capture an ArrayCamera-shaped variant in the synthetic
  scene, or re-drive the camera UBO per subcamera in the slim runtime.
- **Done when**: each cell of `webgpu_camera_array` shows a different camera angle.
- **Reference**: `webgpu_camera_array`.

---

## Multi-Render-Target (MRT)

Investigation done in round 1; the umbrella task split into 4 sub-tasks
plus a harness false-positive. See
`packages/examples/batch/results/shots/webgpu_{mrt,multiple_rendertargets}*.png`
for capture/replay diffs.

### `mrt-fragment-locations` — P2
Materials drawn into a render target with multiple color attachments emit
only `@location(0)` in the captured WGSL. At capture, `compileTSL`'s
warm-up render is unaware of `renderer.setMRT(...)` / `pass.setMRT(...)` /
`material.mrtNode`, so the downstream pipeline is built with N color
targets but the fragment declares one output → WebGPU validation rejects
with "targets[1] writeMask…".

- **Files**: `packages/plugin/src/vendor/compileTSL.js`, `packages/plugin/src/aux-capture.js`, `packages/runtime/src/hydrator.js`, `packages/runtime/src/apply-precompiled.js`
- **Done when**: `webgpu_multiple_rendertargets.html` replay shows the torus side-by-side (color | normal) and no GPU validation error.
- **Reference**: `webgpu_multiple_rendertargets`, `_readback`, `webgpu_mrt`, `webgpu_mrt_mask`.

### `mrt-tsl-stub-leak` — P2
`webgpu_multiple_rendertargets*` import `mrt`, `output`, `normalWorld`,
`screenUV`, `mix`, `texture`, `step` from `three/tsl`. After the slim
swap those resolve to `chainableSlimStub` which throws on `apply()`. The
example continues past the throws (Playwright swallows them); user's
`renderPipeline.outputNode` never gets a real outputNode.

- **Files**: `packages/runtime/src/slim-stubs.js`, `packages/plugin/src/three-rewrite.js`, `packages/runtime/src/aux-loader.js`
- **Done when**: replay logs zero `Proxy(Function)` errors for the MRT examples.
- **Reference**: `webgpu_multiple_rendertargets`, `_readback`.

### `mrt-pass-aux` — P2
`webgpu_mrt.html` and `webgpu_mrt_mask.html` use the post-processing path
(`pass(scene, camera).setMRT(mrt({...}))` + `RenderPipeline.outputNode = …`),
not raw `renderer.setMRT`. Capture has `aux artifacts: post-process +
render-output` but no MRT-shape descriptor. `PassNode` slim stub at
`slim-stubs.js:124` has `_mrt = null` and no `getTexture`/`setMRT` plumbing.

- **Files**: `packages/runtime/src/aux-marker.js`, `packages/runtime/src/aux-loader.js`, `packages/runtime/src/slim-stubs.js`
- **Done when**: `webgpu_mrt.html` shows the four-quadrant final/beauty/normal/emissive image (≥ 25 dB PSNR vs capture).
- **Reference**: `webgpu_mrt`, `webgpu_mrt_mask`.

### `mrt-bright-frac-misleading` — P3 (harness)
All four MRT replays report `replayBrightFrac=1.00` despite producing empty
canvases — `brightFraction` screenshots the whole page so the page bg
bleeds through. Harness false-positives mask MRT and other "no error but
blank" failures across the entire sweep. **Likely affects many other
"passing" examples too** — re-verify after this fix lands.

- **Files**: `packages/examples/batch/run-e2e.mjs` (the `brightFraction` helper at line ~978; clip the screenshot to canvas bounding rect or use `canvas.toDataURL` from page).
- **Done when**: `webgpu_mrt.html` reports `replayBrightFrac < 0.05` until `mrt-pass-aux` is fixed; tier-1 sweep pass count is **trustworthy** (currently mixes blank-canvas false-positives in).
- **Reference**: every MRT example, `bg-pmrem`-affected examples too.

---

## Animation & Determinism

### `inspector-overlay-parity` — P1 — CARVE-OUT from `psnr-pacing`
After deterministic-rAF pacing landed in round 1, PSNR gains were
≤ 3 dB on most animated examples. Diagnosis: the lil-gui inspector
overlay (Scene settings panel + FPS counter) shows in capture but not
in replay (replay loads an inspector stub). This produces large
per-pixel deltas regardless of animation phase. Until parity, PSNR
ceiling is dominated by overlay deltas, not rendering correctness.

Side issue noticed: some replays render at a different canvas size
than capture (e.g. 320×240 capture vs 480×360 replay). Same root area
of investigation.

- **Files**: `packages/examples/batch/run-e2e.mjs` (force-stub the inspector module in BOTH passes and pin canvas size identically)
- **Why**: Make capture and replay visually equivalent before measuring rendering correctness with PSNR.
- **Done when**: tier-1 PSNR pass count climbs from 2/29 to ≥ 8/29 without other code changes.
- **Reference**: `webgpu_camera`, `webgpu_clearcoat`, `webgpu_animation_retargeting*`, every animated example.

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

### `worktree-base-stale` — P2 (multi-agent infra)
The Agent tool's `isolation: "worktree"` may give a worktree based on
an ancient commit. Round 1 saw two cases: agent 8's worktree was on
commit `1af8a1d` (predates aux-loader.js entirely); agent 4's worktree
was on the same stale base. Agents had to fall back to operating on
main, which defeats isolation.

- **Files**: `MULTI_AGENT.md` (document the gotcha + a workaround pattern)
- **Why**: Pin the worktree base to current `HEAD` explicitly when launching, and have agents verify the worktree contains expected files before editing.
- **Done when**: agent-launch instructions include a "verify base commit is current `HEAD`" step.

### `slim-load-smoke-pixel-gate-trustworthy` — P3 — CARVE-OUT from `slim-load-smoke-pixel-gate`
The pixel-gate added in round 1 calls `replayBrightFrac > 0.05` —
which uses the same broken `brightFraction` as the rest of the harness
(see `mrt-bright-frac-misleading`). A blank-canvas curated example would
still pass. Land `mrt-bright-frac-misleading` first, then this becomes
trustworthy automatically.

- **Files**: same as `mrt-bright-frac-misleading`.
- **Done when**: that fix lands.

---

## Coordination matrix

When two tasks share a file, run them **sequentially**, not in parallel.

| File | Tasks |
|---|---|
| `runtime/src/hydrator.js` | `bg-node-render-pipeline`, `userdata-uniform`, `storage-texture-3d`, `sprite-flip-y`, `hydrator-toneMappingExposure`, `lights-extra-types`, `mrt-fragment-locations` |
| `plugin/src/vendor/extractUniformPlan.js` | `userdata-uniform`, `sprite-flip-y`, `lights-extra-types`, `hydrator-toneMappingExposure` (possibly) |
| `plugin/src/emit-updater.js` | `userdata-uniform`, `compute-birds-capture-throw`, `lights-extra-types` |
| `examples/batch/run-e2e.mjs` | `bg-node-render-pipeline`, `compute-kernel-replay`, `mrt-bright-frac-misleading`, `slim-load-smoke-pixel-gate-trustworthy`, `inspector-overlay-parity` |
| `runtime/src/aux-loader.js` | `mrt-tsl-stub-leak`, `mrt-pass-aux`, `backdrop-empty` |
| `runtime/src/aux-marker.js` | `mrt-pass-aux`, `backdrop-empty` |
| `runtime/src/slim-stubs.js` | `mrt-tsl-stub-leak`, `mrt-pass-aux` |
| `plugin/src/three-rewrite.js` | `bg-node-render-pipeline`, `hash-graph-vs-config`, `mrt-tsl-stub-leak` |
| `runtime/src/precompile-marker.js` | `compute-kernel-replay`, `array-camera-per-cell` |
| `runtime/src/writers.js` | `storage-texture-3d` |
| `plugin/src/vendor/compileTSL.js` | `compute-kernel-replay` (possibly), `mrt-fragment-locations`, `array-camera-per-cell` |

### Round-2 parallel-safe set (recommended launch group)

Best zero-conflict trio for round 2:

1. **`inspector-overlay-parity`** (P1) — `run-e2e.mjs` only. Highest leverage: unblocks PSNR measurement for everything else.
2. **`hash-graph-vs-config`** (P1) — `three-rewrite.js` only. Removes a fragile shape-fallback path.
3. **`lights-extra-types`** (P2) — `extractUniformPlan.js` + `emit-updater.js` + `hydrator.js`. Single agent owns the entire lights area; no other agent should touch those files in this round.

Optional 4th if you want to push deeper:
4. **`worktree-base-stale`** — docs only (`MULTI_AGENT.md`); doesn't conflict with anything.

After those merge, round 3 picks up `mrt-bright-frac-misleading`,
`compute-birds-capture-throw`, `userdata-uniform`, `sprite-flip-y`.
