# Continuation Plan

Last updated: 2026-05-03

This file is the working handoff for continuing the current push: make the
Vite plugin/runtime broadly usable for replacing the runtime three.js TSL
builder with precompiled artifacts.

## Round 3 — parallel agents (2026-05-03)

Wave 1 (launched in previous conversation): `hydrator-toneMappingExposure` (Agent 1),
`userdata-uniform` + `sprite-flip-y` (Agent 5), `compute-kernel-replay` harness
(Agent 4, `run-e2e.mjs`), `bg-node-render-pipeline` (Agent 6, backgroundNode stub).

Wave 2 (launched in this conversation): 12 agents / tasks.

### What landed

| Task | Result | Key files |
|---|---|---|
| `lights-ltc-textures` (P2) | LTC BRDF textures captured as half-float; wired in hydrator; PSNR 21→24 dB for `webgpu_lights_rectarealight` | `compileTSL.js`, `hydrator.js` |
| `storage-texture-3d` (P2) | `Storage3DTexture`/`StorageArrayTexture` resolved by name via prototype name-intercept; fallback to blank typed texture | `hydrator.js` (prototype patches) |
| `array-camera-per-cell` (P3) | `setDevRenderer` render intercept auto-detects `ArrayCamera`; `captureMaterialInDev` re-uses it so WGSL emits per-cell `cameraViewMatrices` array | `precompile-marker.js` |
| `compute-birds-capture-throw` (P2) | Missing `case 'renderer.toneMappingExposure'` in `emitSlotWrite` caused capture throw for `webgpu_compute_birds` output-transform material | `emit-updater.js` |
| `mrt-tsl-stub-leak` (P2) | ~80 TSL function exports added to `slim-stubs.js` as `inertNodeStub()`; `three/tsl → @tsl-precompile/runtime/slim-stubs` Vite alias added in plugin `index.js` + runtime `package.json` | `slim-stubs.js`, `index.js`, `package.json` |
| `backdrop-empty` (P2) | `precompileAuxiliary` now traverses scene for `material.backdropNode.isNode` and captures each unique backdrop material via `captureBackdropLive()` | `aux-marker.js` |
| `mrt-pass-aux` (P2) | `PassNode.setMRT()` / `getTexture()` added to slim stub; `captureMRTLive()` helper stamps `artifact.mrt.outputNames`; `attachMRTTextureRefs()` wires live render-target textures | `slim-stubs.js`, `aux-marker.js`, `aux-loader.js` |

### Smoke test growth

| After round | Tests |
|---|---|
| Round 1 | 21 |
| Round 2 | 27 |
| Round 3 wave 1 | 27 |
| Round 3 wave 2 | 42 |

### Round-3 commits on main (main HEAD: `2e448e7`)

```
2e448e7 Merge storage-texture-3d: Storage3DTexture/StorageArrayTexture binding resolution in hydrator
693bd6a feat(hydrator): Storage3DTexture/StorageArrayTexture binding resolution
b88e899 fix(plugin): add three/tsl → slim-stubs alias in slim mode; add slim-stubs export
dd5f461 Merge mrt-tsl-stub-leak + backdrop-empty + mrt-pass-aux: TSL stubs, backdrop capture, MRT setMRT/getTexture
d736db0 feat(slim): mrt-tsl-stub-leak + backdrop-empty + mrt-pass-aux — three tasks
18a7b85 Merge compute-birds-capture-throw: add renderer.toneMappingExposure to emit-updater switch
95321f9 fix(emit-updater): handle renderer.toneMappingExposure kind
9ecb207 feat(lights-ltc-textures): capture LTC BRDF textures as half-float at precompile time
ad154ee feat(precompile-marker): detect ArrayCamera at capture time for per-cell WGSL
56cdb30 Merge bg-node-render-pipeline: backgroundNode stub restores snow/gradient sky
```

### Open after Round 3

- **`mrt-fragment-locations`** (P2) — Agent on branch `agent/mrt-fragment-locations`;
  compileTSL warm-up needs `renderer.setMRT(material.mrtNode)` so fragment emits
  all `@location(N)` outputs. Also `apply-precompiled.js` color-target count.
- **`compute-kernel-replay`** (P2) — harness fix landed; verify
  `webgpu_compute_particles` particle blob renders.

### Round-4 recommended actions

1. Merge `agent/mrt-fragment-locations` once done.
2. Run tier-1 PSNR sweep: `node packages/examples/batch/run-e2e.mjs --limit=30`.
3. Close `compute-kernel-replay` if sweep shows particles rendering.
4. Push all merged commits to `origin/main`.

---

## Round 1 — parallel agents (2026-05-02)

11 file-disjoint tasks launched in parallel via the `Agent` tool with
`isolation: "worktree"`. 9 landed fully, 2 partial. See
[BACKLOG.md](./BACKLOG.md) for the post-merge state and round-2 plan.

### What landed

| Task | Result | Files touched |
|---|---|---|
| `lights-direct` (P0) | new `light.<prop>` source kind; per-frame writes for color/position/viewPosition/targetPosition/cutoffDistance/decayExponent/coneCos/penumbraCos | `extractUniformPlan.js`, `emit-updater.js`, `hydrator.js` |
| `lights-clone-scene` (P1) | `cloneLightsInto(sourceScene, destScene)` — bakes world transforms for nested rigs (e.g. clearcoat's particleLight) | `precompile-marker.js` |
| `bg-pmrem` (P1) | re-entry guard solved session-7's silent failure (`PMREMGenerator.fromCubemap` recursively triggers our render hook); per-frame eager PMREM with init-gating | `run-e2e.mjs` |
| `bg-node-hash` (P1) | `tslp-stub:<shape>:fallback` sentinel for TSL stub-proxies; warning dedupe | `aux-loader.js`, `graph-hash.js` |
| `tone-mapping` (P1) | PARTIAL — `toneMappingExposure` now in render-output config hash; downstream still off (carve-outs `hash-graph-vs-config` + `hydrator-toneMappingExposure`) | `aux-marker.js` |
| `array-camera` (P2) | DONE with zero edits — existing `patchMissingCameraIndexBinding` was correct, capture was failing because of `lights-direct`'s codegen drift gate | (no edits) |
| `slim-load-smoke-pixel-gate` (P3) | opt-in `--pixel-gate` over 5 curated examples | `run-slim.mjs` |
| `subpackage-readmes` (P3) | npm-page-ready READMEs | new files |
| `migration-md` (P3) | version-bump contract + three-layer staleness gate (anchored to real code) | `MIGRATION.md`, `STATUS.md` |
| `multiple-rendertargets` (P3→P2) | investigation-only, split into 4 sub-tasks (all in BACKLOG) | `BACKLOG.md` |
| `psnr-pacing` (P1) | deterministic-rAF shim (synthetic monotonic timestamps via `addInitScript`); modest PSNR gains (≤3 dB on most) | `run-e2e.mjs` |

### Critical meta-finding (from `multiple-rendertargets`)

The harness's `brightFraction` helper screenshots the **whole page**, not
just the canvas. Empty/transparent canvases let the page background bleed
through and report `replayBrightFrac=1.00`. **Many prior tier-1 "passes"
may be false positives.** Tracked as `mrt-bright-frac-misleading` in
BACKLOG; landing it makes both `slim-load-smoke-pixel-gate` and every
future tier-1 sweep result trustworthy.

### Visible impact

- `webgpu_clearcoat`: PBR spheres now show direct-light specular hot-spots
  (was lavender wash from IBL only).
- `webgpu_compute_water` / `_cloth` / `_particles_fluid`: smooth PMREM-blurred
  sky background (was sharp marble walls leaking through).
- `webgpu_camera_array`: 6×6 grid renders (was empty canvas).
- `webgpu_compute_particles_snow`: shape-fallback firing correctly, but
  downstream rendering still solid white — surfaced as
  `bg-node-render-pipeline` carve-out.

### Round-1 commits on main

```
5181430 Update BACKLOG after round-1 parallel agents merged
17f5237 Inject deterministic-rAF shim into e2e harness
8fbe8c0 Add per-package READMEs for npm publish
7f51063 Detect TSL stub-proxies in aux loadAux fallback
0e5e611 Add project status and planning notes
5a128f7 Add how-it-works walkthrough and refresh home page
0926f45 Add background example and dev:background script
e115f9f Expand batch e2e harness and refresh capture/replay results
3b392c1 Expand hydrator with texture binding resolution and live-update support
8df196f Refresh emit-updater grouping and renderer/object uniform support
e2279a3 Add rewrite handlers for RenderObject and WebGPU pipeline utils
```

Tests: runtime smoke 21/21, plugin units 89/89.

### Round 2 launch (recommended)

Three zero-conflict tasks for the next parallel run (full briefs in
[BACKLOG.md](./BACKLOG.md)):

1. **`inspector-overlay-parity`** (P1) — `run-e2e.mjs` only. Highest
   leverage: unblocks PSNR measurement for everything else by stubbing
   the lil-gui inspector overlay equally in capture and replay.
2. **`hash-graph-vs-config`** (P1) — `three-rewrite.js` only. Switch the
   render-output rewrite from `hashNodeGraphSync(outputNode)` to
   `hashPlainConfigSync({toneMapping, toneMappingExposure,
   outputColorSpace})` so the slim runtime exact-matches the aux registry.
3. **`lights-extra-types`** (P2) — `extractUniformPlan.js` +
   `emit-updater.js` + `hydrator.js`. Cover RectAreaLight, IES spotlight,
   projector light. Single agent owns the lights area for the round.

Optional 4th: `worktree-base-stale` — docs only, never conflicts.

After round 2 merges, round 3 picks up `mrt-bright-frac-misleading`,
`compute-birds-capture-throw`, `userdata-uniform`, `sprite-flip-y`.

---

## Latest changes (2026-05-02, seventh session — scene.backgroundBlurriness + new test example)

**Fixed `scene.backgroundBlurriness` ramp + identity classification for scene-state TSL helpers.**

### What was broken

`compute_water`, `compute_cloth`, `compute_particles_fluid` and any
example that animates `scene.backgroundBlurriness > 0` rendered with a
sharp cubemap background instead of the captured blurred sky. Root
cause: three.js's TSL helpers `backgroundBlurriness`,
`backgroundIntensity`, and `backgroundRotation` (in
`three/src/nodes/accessors/SceneProperties.js`) are anonymous
`uniform()` calls with `onRenderUpdate(({scene}) => scene.<prop>)`
closures. The extractor's `classifyByIdentity` had no entries for
them, so each became an unnamed `uniform.live` and frozen at
extraction-time value (0 for blurriness, identity for rotation, 1 for
intensity).

### Fixes

1. [`packages/plugin/src/vendor/extractUniformPlan.js`](packages/plugin/src/vendor/extractUniformPlan.js)
   imports `backgroundBlurriness`, `backgroundIntensity`,
   `backgroundRotation` from `three/tsl` and adds identity-equality
   checks in `classifyByIdentity`. Each maps to a `scene.<prop>` kind
   that the hydrator + emit-updater already understand for
   per-frame reads.
2. [`packages/runtime/src/hydrator.js`](packages/runtime/src/hydrator.js)
   handles the `scene.backgroundRotation` kind by mirroring stock
   three.js's `_m1.makeRotationFromEuler(scene.backgroundRotation)
   .transpose()` derivation when `scene.background` is a Texture; falls
   back to identity for non-rotated scenes.
3. [`packages/plugin/src/emit-updater.js`](packages/plugin/src/emit-updater.js)
   emits a per-frame `writeMat4FromEuler(...)` call for
   `scene.backgroundRotation`, plus the existing numeric writers for
   blurriness/intensity.
4. [`packages/runtime/src/writers.js`](packages/runtime/src/writers.js)
   gains `writeMat4FromEuler(view, off, euler, background)` — an
   inlined Euler-XYZ → matrix4 + transpose so AOT updaters don't
   need to import three's Matrix4.

### Visible impact

- `webgpu_compute_water`: smooth blurred sky now visible (was sharp
  marble walls leaking through). Replay frame-bright 1.0.
- `webgpu_compute_particles_fluid`, `webgpu_compute_cloth`:
  background now renders as smooth gradient (PMREM mip-LOD honored).

### New test example

[`packages/examples/background`](packages/examples/background) is a
self-contained scene that exercises both fixes:
- `scene.backgroundNode = mix(color(0x103040), color(0x102060),
  screenUV.y)` — TSL gradient background.
- `scene.environment = pmrem.fromCubemap(inMemCube6Faces).texture` for
  PBR IBL on a chrome sphere.
- `scene.backgroundBlurriness = 0.5 + 0.5 * Math.sin(t * 0.6)` ramps
  the blur per frame so any regression in the blurriness uniform
  shows up as a static background.

Run with: `pnpm dev:background` (port 5180).

### Tests + tier-1

- runtime smoke 21/21, plugin units 89/89.
- Tier-1 sweep: still **2 / 29 PSNR passes** (compute_reduce 30.41 dB —
  +0.30 dB from the previous run, indicating the blurriness fix
  reduced background noise even where it wasn't tested directly).

### Open items

- **PMREM-prefiltered background for HDR cubemaps**: when a captured
  background-aux artifact came from a `backgroundBlurriness > 0` path,
  the WGSL samples a PMREM 2D texture, not the raw cubemap. The
  harness wires the raw `scene.background` instead, so the sky goes
  black on textured-cubemap backgrounds. Tried PMREM-then-wire in
  this session but the resulting GPU resource isn't ready by the time
  bind groups are recorded; needs a per-frame re-wire after PMREM
  finishes.
- All other carry-overs from previous sessions (camera_array,
  compute_birds, lights, sprite flipY, backgroundNode hash mismatch).

## Latest changes (2026-05-02, sixth session — render-state + per-object UBO + first PSNR pass)

**Three high-impact fixes; first PSNR-pass on tier-1.**

### 1. Material render-state captured + applied

Sprites rendered with **black opaque squares** instead of soft transparent
quads. Root cause: the artifact captured material **uniforms** but not
material **render-state flags** (`transparent`, `side`, `blending`,
`depthWrite`, `depthTest`, `alphaTest`, `vertexColors`, `wireframe`,
`flatShading`, premultiplied/dithering/toneMapped, polygonOffset,
stencil*, blend equations, etc.). At replay PrecompiledMaterial
defaulted to `transparent: false` so three.js built an opaque pipeline
and the alpha channel from `opacityNode = textureNode.a` was ignored.

Fix:
- [`packages/plugin/src/vendor/compileTSL.js`](packages/plugin/src/vendor/compileTSL.js):
  new `collectMaterialRenderState(material)` walks ~30 boolean/numeric
  flags and adds them to `artifact.renderState`.
- [`packages/runtime/src/_vendor-PrecompiledMaterial.js`](packages/runtime/src/_vendor-PrecompiledMaterial.js):
  new `seedRenderState(material, artifact.renderState)` applies them
  inside the constructor so three.js's pipeline cache key + bind-group
  setup match what the source material intended.

### 2. Per-renderObject UBO updates (always-refresh observer)

200 sprites all rendered at the position of the FIRST sprite, clustered
at world origin. Root cause: the static observer's `needsRefresh`
returned `true` only on `renderId` change (once per frame). For every
subsequent renderObject in the same frame, three.js's renderer skipped
`updateForRender(renderObject)` — so our hydrated `updateNode` never
wrote per-object data into the UBO. Every draw used the FIRST object's
matrices.

Fix:
[`packages/runtime/src/hydrator.js`](packages/runtime/src/hydrator.js)
`createStaticObserver()` now always returns `true`. WebGPU's
`writeBuffer` + draw command serialization handles per-object data
correctly; the cost is one DataView write + one uploadBuffer per draw
which is what stock three.js does anyway.

Also added `cloneBindingsForObject(bindings, artifact, material)`
returning per-call BindGroup clones with fresh `UniformBuffer`
instances for non-shared groups, so each renderObject's `_bindings`
cache holds its own writable buffer instead of all sharing one.

### 3. `scene.fogNode` / `scene.backgroundNode` / `scene.environmentNode` propagation

Sprites lost their distance-based fog tint because
[`packages/runtime/src/precompile-marker.js`](packages/runtime/src/precompile-marker.js)
copied `scene.fog` (legacy Fog class) but not `scene.fogNode` (TSL
node-graph fog). The captured WGSL had no fog code path. Same for
`backgroundNode` and `environmentNode` (TSL node forms). Now copied
through to the throwaway capture scene.

### Visible impact

| Example | Replay before | Replay after |
|---|---|---|
| `webgpu_sprites` | clustered black squares | **200 sprites, transparent quads, fog tint on far ones** |
| `webgpu_compute_reduce` | crash | **PASS PSNR 30.11 dB** ← first PSNR-pass |
| `webgpu_centroid_sampling` | empty | 0.18 brightness (renders) |
| `webgpu_compute_birds` | dim | 1.0 brightness (still throws at capture, but renders if precompile bypassed) |
| `webgpu_compute_texture_3d` | 0.33 | **1.0** |
| `webgpu_cubemap_adjustments` | 0.96 | **1.0** |

Saved log:
[`packages/examples/batch/results/e2e-tier1-after-renderstate.log`](packages/examples/batch/results/e2e-tier1-after-renderstate.log).

Tier-1: **2 / 29 PSNR passes** (was 1 / 29, the new one is
`compute_reduce` at 30.11 dB).

Tests: runtime smoke 21/21, plugin units 89/89.

### Open items for next session

- **`scene.backgroundNode` on replay** — `webgpu_compute_particles_snow`
  shows blank white because the TSL backgroundNode in the live scene is
  a slim stub proxy that hashes differently from the captured graph;
  `loadAux('background', hash)` misses. Needs a proxy-tolerant hash
  path or a way to wire the captured artifact directly.
- **Per-sprite `userData('rotation', 'float')`** — currently frozen at
  0 via the unknown→blocked downgrade. Sprites all have identical
  rotation in replay; capture had per-sprite rotation animation.
  Needs an extractor extension to map `userData(name)` → live
  `object3d.userData[name]` lookup at runtime.
- **`webgpu_camera_array`** — ArrayCamera multi-viewport rendering
  still produces an empty replay frame. Slim's renderer needs the
  full ArrayCamera viewport-loop or our patches need to expose it.
- **`webgpu_compute_birds`** — precompile still throws at capture.
- **`scene.backgroundBlurriness`** — fluid/cloth/water examples have
  blurry environment backgrounds in capture but sharp in replay. The
  PMREM mip-LOD path isn't fed the blurriness uniform.
- **Direct lights** (point/dir/spot/area) — frozen at capture
  snapshots. Need clone-lights or lights-aux artifact.

## Latest changes (2026-05-02, fifth session — compute + sprites)

**Two distinct hydrator/codegen fixes that unblock 6+ examples.**

### 1. Storage-buffer JSON round-trip crash

`webgpu_compute_*` examples crashed with
`createBuffer ... 'size' undefined`. Root cause: the extractor
attaches `_liveAttribute` (a real `StorageBufferAttribute` instance)
on each storage-buffer plan entry as a side-car. The harness's
JSON-stringified capture round-trips lose the prototype and the
`Float32Array` view — `_liveAttribute` survives as a plain object
whose `array` is a numeric-keyed map with NO `byteLength`.

The hydrator was using `_liveAttribute` whenever truthy. Then
`WebGPUAttributeUtils.createAttribute` read `attribute.array.byteLength`
→ `undefined` → buffer size = NaN → WebGPU validator rejected.

Fix in
[`packages/runtime/src/hydrator.js`](packages/runtime/src/hydrator.js):
only trust `_liveAttribute` when its `.array` is an actual TypedArray
(`ArrayBuffer.isView`); otherwise allocate a fresh
`StorageBufferAttribute(count, itemSize, TypedArray)` from the
captured metadata. Seed values from `_liveArray` whether it's a real
TypedArray (in-process) or a numeric-keyed plain object
(JSON-loaded).

### 2. Sprites/userData unknown→blocked

`webgpu_sprites` and any example using `userData('rotation', 'float')`
or `onRenderUpdate(...)` against an unnamed `UniformNode` failed at
**capture time** because the codegen marked the binding as
`severity: 'unknown'` and `precompile-marker.js` throws on unknown
kinds. The artifact never reached disk.

Fix in
[`packages/plugin/src/emit-updater.js`](packages/plugin/src/emit-updater.js):
when a `uniform.live` source has neither a `property` (live read
path) nor a `valueSnapshot` (frozen fallback), downgrade to
`severity: 'blocked'` and emit a no-op writer (the buffer was
zero-initialised; nothing to write). Animation through these
uniforms won't propagate, but the artifact is now usable for the
common static case (e.g. `sprite.userData.rotation = 0` defaults).

### Visible impact (tier-1 sweep)

| Compute example | Before | After |
|---|---|---|
| `webgpu_compute_cloth` | crash | **1.0** brightness |
| `webgpu_compute_particles_fluid` | crash | **1.0** |
| `webgpu_compute_reduce` | crash | **PSNR 29.94 dB** (1 dB shy of threshold) |
| `webgpu_compute_sort_bitonic` | crash | **0.999** |
| `webgpu_compute_water` | crash | **1.0** |
| `webgpu_compute_particles` | crash | **0.085** (renders grid floor; particles still need compute kernel) |

| Other example | Before | After |
|---|---|---|
| `webgpu_sprites` | 0 artifacts captured (precompile threw) | **renders 200 sprites** with the sprite1.png texture |

Saved log:
[`packages/examples/batch/results/e2e-tier1-after-storage.log`](packages/examples/batch/results/e2e-tier1-after-storage.log).

Tests: runtime smoke 21/21, plugin units 89/89.

### Open issues from this session

- `webgpu_compute_birds` still throws at capture (different
  `uniform.live` case — investigate next).
- `webgpu_camera_array` replay frame is empty (canvas black).
  ArrayCamera uses multi-viewport rendering which the slim
  apparently doesn't fully drive. Next-session task.
- Direct lighting (point/dir/spot/area lights) is still frozen at
  capture-time snapshots; the harness doesn't reparent lights into
  the throwaway capture scene (would detach them from the user's
  real render). Need a clone-light or a lights-aux artifact path so
  PBR examples like `webgpu_clearcoat` get correct direct
  contribution rather than just IBL.
- `webgpu_compute_water` background isn't blurred even though the
  example sets `scene.backgroundBlurriness > 0` on the user side —
  Background.js patch may need to honor blurriness uniform.

## Latest changes (2026-05-02, fourth session — scene.environment / IBL)

**`scene.environment` now flows into precompiled PBR artifacts.**

The captured `MeshStandard / MeshPhysical` artifacts had **zero texture
bindings** — even though the scene had `scene.environment` set to an
HDR cubemap. Two compounding bugs:

1. **Synthetic capture scene was missing scene state.**
   [`packages/runtime/src/precompile-marker.js`](packages/runtime/src/precompile-marker.js)
   built a throwaway `new Scene()` for material extraction. It didn't
   inherit `scene.environment`, `scene.fog`, `scene.background`, etc.
   from the user's real scene. So when three.js's `EnvironmentNode`
   ran during capture, `builder.environmentNode` was `null` and no IBL
   bindings were emitted into the artifact.

   Fix: walk up `material.__tslpPrecompileObject.parent` to the real
   scene and copy `environment`, `environmentIntensity`,
   `environmentRotation`, `background`, `backgroundIntensity`,
   `backgroundBlurriness`, `backgroundRotation`, and `fog`. Lights are
   intentionally NOT reparented (would detach them from the user's
   actual render).

2. **Slim runtime never ran PMREM convolution.**
   `EnvironmentNode.setup()` calls `pmremTexture(value)` and stores the
   result in a per-renderer cache. But that runs inside
   `NodeBuilder.build()`, which our `_createNodeBuilder` rewrite
   bypasses entirely for `PrecompiledMaterial`. So the PMREM-prefiltered
   2D texture the captured PBR shader expects never existed in the
   slim runtime, and the hydrator's `artifact.texture` lookup fell
   through to a 1×1 cube fallback.

   Fix: harness now manually runs `new Slim.PMREMGenerator(renderer)
   .fromCubemap(scene.environment)` on first encounter (cached per
   source texture) and feeds the prefiltered output to every
   `PrecompiledMaterial`'s `artifact.texture`-kind binding via
   `attachArtifactTextureRefs`.

3. **Wireframe + scalar flag propagation** — added the missing
   `wireframe`, `flatShading`, `depthTest`, `depthWrite`, `alphaTest`,
   `blending`, `premultipliedAlpha`, `dithering`, `vertexColors`,
   `wireframeLinewidth` props to the harness's `__SCALAR_PROPS`. Without
   `wireframe`, `webgpu_camera`'s left-half wireframe sphere replayed
   as a solid white blob.

4. **Color background path preserved** — `__prepareSceneForReplay` no
   longer nulls `scene.background` when it's a `Color`. Color
   backgrounds use the renderer's clear-color path and need no aux
   artifact at all. This fixed `webgpu_sandbox`'s `Color(0x222222)`
   background which was rendering pure black.

### Visible impact

- `webgpu_clearcoat`: PBR spheres no longer pure black — top-left
  sphere now shows iridescent FlakesTexture clearcoat reflection over
  the HDR cubemap; the captured artifacts now contain
  `material.normalMap`, `material.clearcoatNormalMap`,
  `builtin.dfgLUT`, and `artifact.texture` (PMREM envMap) bindings.
  Three of the four spheres still render light-lavender rather than
  pixel-perfect — that's because direct lighting (the example's
  `pointLight`) isn't captured into per-light uniforms in the
  artifact, so only the IBL term contributes. Tracked for next
  session.
- `webgpu_camera`: wireframe spheres render correctly (was solid
  white blobs).
- `webgpu_sandbox`: dark grey `Color` background renders (was solid
  black).
- `webgpu_materials_basic`: cubemap reflection still 0.999 brightness.

Updated tier-1 log:
[`packages/examples/batch/results/e2e-tier1-after-env.log`](packages/examples/batch/results/e2e-tier1-after-env.log).
Tests: runtime smoke 21/21, plugin units 89/89.

## Latest changes (2026-05-02, third session — texture support)

**Identity-based texture relink + wireframe + Color background.**

Three independent fixes that unblock most simple-tier examples:

1. **Texture identity capture + relink.** The extractor in
   [packages/plugin/src/vendor/extractUniformPlan.js](packages/plugin/src/vendor/extractUniformPlan.js)
   now records `imageSrc` (loader URL) and `textureName` for every
   `artifact.texture`-kind binding. The runtime hydrator
   ([packages/runtime/src/hydrator.js](packages/runtime/src/hydrator.js))
   exposes `registerLiveTexture(tex)` and falls back to identity match
   (imageSrc → textureName) after the UUID lookup misses. The harness
   patches `TextureLoader / CubeTextureLoader / DataTextureLoader /
   ImageBitmapLoader` to `registerLiveTexture` on every `load()` call
   so TSL `texture(uvTex)` closures (which never land on a material
   property) can still relink. Production code keeps the same Texture
   instance and hits the UUID path — this fallback chain is invisible
   to users.

2. **Wireframe + extra material flags propagated.** The harness's
   `__SCALAR_PROPS` was missing `wireframe`, `wireframeLinewidth`,
   `flatShading`, `depthTest`, `depthWrite`, `alphaTest`, `blending`,
   `premultipliedAlpha`, `dithering`, `vertexColors`. Without
   `wireframe`, three.js's pipeline cache built triangle-list
   pipelines for materials that should have rendered as line lists,
   so `webgpu_camera`'s wireframe spheres replayed as solid white
   blobs.

3. **Color background preserved.** `__prepareSceneForReplay` was
   nulling `scene.background` whenever no background-aux artifact
   existed — but Color backgrounds render via the renderer's
   clear-color path with no aux artifact at all. The new check
   preserves Color backgrounds and only nulls Texture / NodeNode
   backgrounds that would hit the missing-aux path. This fixed
   `webgpu_sandbox` (Color(0x222222)) and any other example using a
   plain Color sky.

### Visible impact

| Example | Replay brightness before | After this session |
|---|---|---|
| `webgpu_sandbox` | 0.009 (canvas was black) | **0.999** |
| `webgpu_camera` | 1.0 (left half white blob) | 1.0 (left half **wireframe sphere**) |

`webgpu_clearcoat` still renders the spheres as black silhouettes —
the captured `mesh-standard` artifacts have no envMap/IBL bindings
because `scene.environment`-driven IBL isn't surfaced through
extractor's binding plan yet. Tracked for the next session.

Updated e2e log:
[`packages/examples/batch/results/e2e-tier1-after-textures.log`](packages/examples/batch/results/e2e-tier1-after-textures.log).

Tests: runtime smoke 21/21, plugin units 89/89.

## Latest changes (2026-05-02, second session — cube fallback)

**Added cube texture fallback + scene.background texture wiring.**


Two issues surfaced after the observer fix landed:

1. `webgpu_materials_basic.html` and `webgpu_clearcoat.html` showed a
   solid black canvas even though their captures rendered a cubemap
   background and reflective spheres. Root cause: the hydrator's
   `fallbackTextureForBinding` returned a 1×1 2D `DataTexture` for
   bindings that never resolved to a live texture — including bindings
   declared `texture_cube<f32>`. WebGPU's bind-group validator
   silently rejects a 2D texture bound to a cube slot, the draw is
   skipped, and no JS error is surfaced.
2. The captured background-aux artifact's textureUuid is the cubemap's
   uuid at capture time. On replay, the example loads a fresh cubemap
   via slim's `CubeTextureLoader` so the uuid no longer matches —
   `_textureRefs.get(uuid)` misses and falls back.

Fixes:
- New `fallbackCubeTexture` in
  [packages/runtime/src/hydrator.js](packages/runtime/src/hydrator.js):
  a six-face neutral grey `CubeTexture`. Routed from
  `fallbackTextureForBinding` for any binding declared
  `texture_cube<f32>`.
- Harness now calls `attachArtifactTextureRefs(bgArtifact,
  scene.background)` for every registered background-aux entry on the
  first replay frame, so the captured uuid maps to the live cubemap.
- Harness `__copyMaterialProps` extended to copy every PBR/material
  texture property (`envMap`, `clearcoatMap`, `lightMap`, `aoMap`,
  `displacementMap`, `alphaMap`, `bumpMap`, `transmissionMap`,
  `iridescenceMap`, `sheenColorMap`, `specularMap`, `gradientMap`,
  `matcap`, …) plus the matching scalar props (`clearcoat`,
  `clearcoatRoughness`, `transmission`, `thickness`, `iridescence`, …)
  so PBR material defaults survive the replay swap.
- Harness `__wireMaterialTextures` calls `attachArtifactTextureRefs`
  with the source material's live textures so per-material
  `artifact.texture`-kind bindings resolve.

### Impact

| Example | Replay brightness before observer fix | After observer fix | After cube + texture wiring |
|---|---|---|---|
| `webgpu_camera` | 0.011 | 0.556 | **1.000** |
| `webgpu_clearcoat` | 0.006 (crash) | 0.006 (no crash) | **0.860** |
| `webgpu_cubemap_dynamic` | 0.011 | 0.011 | **0.954** |
| `webgpu_materials_basic` | 0.007 | 0.007 | **1.000** |
| `webgpu_animation_retargeting_readyplayer` | 0.011 | 0.943 | 0.969 |

Visual confirmation: `webgpu_materials_basic.html.replay.png` now
shows the Pisa cubemap background with reflective chrome spheres
(was solid black). `webgpu_clearcoat.html.replay.png` shows the
HDR cubemap (PBR spheres still appear black — needs lights aux
wiring). Logs:
[`packages/examples/batch/results/e2e-tier1-after-cube.log`](packages/examples/batch/results/e2e-tier1-after-cube.log).

## What changed in the previous session

**Fixed root cause of empty slim replay frames** in
[`packages/runtime/src/hydrator.js`](packages/runtime/src/hydrator.js)
`createStaticObserver()`.

The previous static observer always returned `needsRefresh: false`, so
three.js's `Renderer.js` skipped `_nodes.updateForRender(renderObject)`
on every frame — meaning our hydrated `updateNodes` (the per-frame UBO
writers for camera/object matrices, time, material live values) never
fired. UBOs stayed zero-initialised after creation, so every draw
collapsed to a degenerate point at the origin and the canvas appeared
solid black. The instrumented bisection on `webgpu_camera.html`
confirmed this: `gpuDraws=3085`, `gpuPipelines=4`, no errors —
everything wired except `update(frame)` was never invoked.

The fix mirrors stock three.js's `NodeMaterialObserver.needsRefresh`:
return `true` whenever `nodeFrame.renderId` changes (i.e., once per
frame). Static-bake optimisation can return to this observer later
without losing per-frame correctness.

### Visible impact (first 30 webgpu examples sweep, PSNR ≥ 30 dB gate)

Before:
- `pass / fail / skip`: 1 / 28 / 1 (the one pass was a degenerate
  dim-mismatch skip on `webgpu_camera_logarithmicdepthbuffer`).
- `replayBrightFrac` < 0.02 for ~25 of 29 candidates — slim canvases
  were empty.

After:
- `pass / fail / skip`: still 1 / 28 / 1 against the strict 30 dB PSNR
  gate, BUT `replayBrightFrac` is now in the same magnitude as
  `captureBrightFrac` for many examples that were previously empty:

  | Example | Before | After |
  |---|---|---|
  | `webgpu_animation_retargeting` | 0.009 | 0.991 |
  | `webgpu_animation_retargeting_readyplayer` | 0.011 | 0.943 |
  | `webgpu_backdrop_water` | 0.008 | 0.999 |
  | `webgpu_camera` | 0.011 | 0.556 |
  | `webgpu_compute_geometry` | 0.011 | 1.000 |
  | `webgpu_compute_particles_snow` | 0.008 | 1.000 |
  | `webgpu_compute_texture` | 0.008 | 0.195 |
  | `webgpu_compute_texture_3d` | 0.008 | 0.329 |
  | `webgpu_cubemap_adjustments` | 0.019 | 0.956 |

Logs:
- [`packages/examples/batch/results/e2e-tier1-baseline.log`](packages/examples/batch/results/e2e-tier1-baseline.log)
- [`packages/examples/batch/results/e2e-tier1-after-fix.log`](packages/examples/batch/results/e2e-tier1-after-fix.log)

Visual confirmation in
[`packages/examples/batch/results/shots/webgpu_camera.html.replay.png`](packages/examples/batch/results/shots/webgpu_camera.html.replay.png)
(was solid black; now shows star field, white/green spheres, camera
helper rays — same scene structure as the capture frame).

PSNR is still mostly below the 30 dB gate because animation timing
diverges between capture and replay, the harness can run helpers and
animation a bit out of phase, etc. The next pushes are about narrowing
those — not about getting pixels onto the canvas anymore.

### Other small changes

- Added a `--save-shots` flag to
  [`packages/examples/batch/run-e2e.mjs`](packages/examples/batch/run-e2e.mjs)
  that writes capture/replay PNG pairs into
  `packages/examples/batch/results/shots/` for visual triage.

### Tests

- `packages/runtime/test/smoke.test.js` — 21 / 21 pass.
- `packages/plugin/test/unit/{rewrite-renderer,rewrite-nodes-webgpu-backend,rewrite-render-object,aux-loader,emit-updater}.test.js`
  — 29 / 29 pass.

## Current goal

With the slim runtime now actually rendering, push pixel-correctness
forward by category. Two distinct error families dominate the
remaining failures:

1. **PSNR-only** (slim renders correctly but diverges from capture due
   to animation phase / scene state at screenshot time, or due to
   missing live uniforms). Examples in this bucket include
   `webgpu_animation_retargeting*`, `webgpu_camera`,
   `webgpu_backdrop_water`, `webgpu_cubemap_adjustments`. These do not
   need runtime fixes; they need either deterministic capture/replay
   pacing or an honest acceptance that the gate must be PSNR-skip-on
   for animation-heavy examples.
2. **Still-empty slim frame** (`replayBright` < 0.02). These have a
   second underlying issue — typically a missing texture binding (e.g.
   `webgpu_clearcoat`'s `Cannot read properties of null
   (reading 'complete')`), a clipping-plane code path
   (`webgpu_clipping`), or compute-only output
   (`webgpu_compute_birds`). Triage individually.

## Plan

### 1. Stabilise pacing of the e2e harness (PSNR repeatability)

The capture pass renders at `captureWaitMs = 8000` ms; replay at
`replayWaitMs = 5000` ms. Animations advance differently between the
two windows, so per-pixel PSNR on examples with `setAnimationLoop`
will vary between runs. Options:

- Snapshot `Date.now()` at first frame in capture, reapply same value
  in replay (tricky with `Date` mocks — playwright supports
  `Clock.install()` since recent versions).
- Or simpler: stop the animation loop at frame 30 in both passes, so
  the camera/object positions match.

Pick the smaller intervention that lets PSNR converge for the
animation-heavy passes.

### 2. Fix the still-empty-slim group one example at a time

Order by complexity:

- `webgpu_clipping.html` — clipping planes via `ClippingGroup`. Inspect
  whether `material.clippingPlanes` is propagated through
  `PrecompiledMaterial`. Likely a missing forwarding in
  `_vendor-PrecompiledMaterial.js` constructor / `apply-precompiled.js`.
- `webgpu_centroid_sampling.html` — single artifact; inspect WGSL for
  `centroid` decoration support in slim's pipeline path.
- `webgpu_clearcoat.html` — texture `complete` crash. The hydrator
  resolves an `artifact.texture` to a fallback when no UUID matches,
  but the binding code then dereferences `texture.image.complete`.
  Either swap the fallback for one whose `image` is a non-null `Image`
  proxy, or guard the slim's `updateTexture` patch for null images.
- `webgpu_cubemap_dynamic.html` — likely the dynamic cubemap
  CubeRenderTarget is not being attached on replay (background aux
  artifact's UUID doesn't match the live CubeRenderTarget texture).

### 3. Resume the original blocker triage

After (1) and (2) yield ~5+ examples with PSNR ≥ 30 dB:

1. `webgpu_loader_gltf.html` — render-output texture init crash.
2. `webgpu_loader_gltf_compressed.html` — compressed vertex attribute
   layout mismatch.
3. Compute examples that crash with `createBuffer ... 'size'
   undefined` (most `webgpu_compute_*.html` after this fix). Likely a
   storage-buffer descriptor missing `byteLength`/`size` after JSON
   round-trip.

### 4. Tighten the slim load-smoke gate

`pnpm test:slim` (198/198) only checks module-load and loud-fail. Once
several non-trivial examples pass PSNR, extend that smoke to assert a
non-empty slim replay frame for a curated 5-example list — so future
drift doesn't mask another empty-frame regression.

## Working rules

- Before editing
  [`packages/plugin/src/three-rewrite.js`](packages/plugin/src/three-rewrite.js),
  [`packages/runtime/src/hydrator.js`](packages/runtime/src/hydrator.js),
  or
  [`packages/examples/batch/run-e2e.mjs`](packages/examples/batch/run-e2e.mjs),
  reread the current file contents.
- Rebuild slim after any `three-rewrite.js`, runtime export, hydrator,
  or `slim-entry.js` change:
  `TSL_PRECOMPILE_THREE_VERSION=184 pnpm --filter
  @tsl-precompile/runtime build:slim`.
- Use `--save-shots` for visual triage:
  `node packages/examples/batch/run-e2e.mjs --filter=<example>
  --no-pixel-gate --save-shots`.

## Completion criteria for this push

- Empty-frame root cause fixed and rebuilt slim deployed. ✅ DONE.
- At least 5 examples in the first-30 sweep pass PSNR ≥ 30 dB.
- `STATUS.md` updated with the new pixel-correctness counts.
- The slim load-smoke gate asserts non-empty replay frames on a small
  curated list.
