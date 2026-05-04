# Logs

Append-only journal of focused investigations and fixes. One entry per session/issue, newest first. For broader status snapshots see [STATUS.md](./STATUS.md).

---

## 2026-05-04 — `webgpu_clearcoat` black spheres fixed: DFG LUT module identity + deterministic E2E frame

**Symptom.** `webgpu_clearcoat.html` capture/replay regressed to black spheres even though clearcoat highlights remained visible. The capture PNG was also misleading because the E2E visual baseline was using the instrumented capture path rather than a clean stock full-three reference.

**Root cause.** PMREM was present and correctly sized, but `builtin.dfgLUT` sampled black in the slim renderer. The runtime LUT was built with `DataTexture` from the public `three` barrel while the slim renderer uses `three/src/**` classes, creating a module/class identity mismatch for WebGPU texture upload/binding. `MeshPhysicalMaterial` artifacts were also being stamped as `mesh-standard` because physical materials inherit standard flags.

**Fix.** `packages/runtime/src/dfg-lut.js` now imports `DataTexture` and constants from `three/src/**`; runtime smoke coverage asserts the LUT is a source-module `DataTexture`. `classifyMaterialShape()` and the harness material-name helper now check physical materials before standard materials. The E2E harness runs a clean stock reference, a capture pass for artifacts, and a slim replay pass for comparison; animated examples default to `--target-tick=0` (first fully loaded settled frame), with `--target-tick=<n>` available for later animation-phase audits.

**Verification.** Focused clearcoat run: `webgpu_clearcoat.html PASS | artifacts 5+7 | capture 97.2% | replay 97.2% | psnr 31.17/30 dB ok`. Runtime tests passed (`56/56`), plugin unit tests passed (`98/98` in the invoked unit run), and the slim bundle rebuilt successfully.

## 2026-05-04 — `webgpu_instancing_morph` replay black: shadow-depth GPU-sharing fixed; instance/morph hydration deferred

**Symptom.** [packages/examples/batch/results/shots/webgpu_instancing_morph.html.replay.png](packages/examples/batch/results/shots/webgpu_instancing_morph.html.replay.png) was fully black except for the HTML title overlay; capture is the expected ~1024 horse instances on a green plane. Pre-existing brightFrac was 0; PSNR 0.

**Diagnostic.** Re-ran with `TSLP_DEBUG_TORNADO=1` to surface WebGPU validation warnings. The originating error before the cascade:

```
None of the supported sample types (Float|UnfilterableFloat) of
[Texture (unlabeled 1x1 px, TextureFormat::BGRA8Unorm)] match the
expected sample types (Depth).
- While validating entries[2] against { binding: 2, visibility: ShaderStage::Fragment,
  texture: {sampleType: TextureSampleType::Depth, viewDimension: TextureViewDimension::e2D, multisampled: 0} }.
- While validating [BindGroupDescriptor "bindGroup_object"] against [BindGroupLayout (unlabeled)]
- While calling [Device].CreateBindGroup([BindGroupDescriptor "bindGroup_object"]).
```

Each frame produced new `Invalid BindGroup "bindGroup_object"` errors that cascaded into `Invalid CommandBuffer` rejections — pipeline never created → canvas stayed at clear color.

**Root cause (Phase 1, fixed).** The ground material `MeshStandardNodeMaterial:2` declares `nodeUniform16: texture_depth_2d` for shadow sampling. The hydrator at [packages/runtime/src/hydrator.js:1813-1817](packages/runtime/src/hydrator.js#L1813-L1817) routes `source.kind === 'depth.texture'` through `fallbackTextureForBinding` → returns `fallbackDepthTexture` (a real `DepthTexture`). The per-frame shadow rebinder at [packages/runtime/src/hydrator.js:1234](packages/runtime/src/hydrator.js#L1234) then swaps in `light.shadow.map.depthTexture` once the harness's offscreen full-three shadow render has populated it (see `[tslp-shadow] populated 1 shadow maps`).

The JS-side wiring is correct. The break is in **WebGPU backend bookkeeping**: full's backend allocates the GPU `depthTexture` resource during the offscreen shadow render, but slim has its own `WebGPUBackend` instance with a separate `WeakMap<Texture, BackendData>`. When slim's first bindgroup creation references the same JS `DepthTexture` object, slim looks it up in *its own* backend, finds no entry, and creates a fresh 1×1 `BGRA8Unorm` GPUTexture as a placeholder — which the WGSL `texture_depth_2d` declaration rejects with the sample-type mismatch above.

This is the same pattern the codebase already handles for compute/storage textures in [packages/examples/batch/run-e2e.mjs:1421-1466](packages/examples/batch/run-e2e.mjs#L1421-L1466) (`slimTexData.texture = fullTexData.texture` pre-seed) and for PMREM textures via `__sharePMREMGPUTexture`. It just hadn't been wired for shadow depth textures.

**Fix (Phase 1).** [packages/examples/batch/run-e2e.mjs:1791-1822](packages/examples/batch/run-e2e.mjs#L1791-L1822) — extended the shadow-population block (right after `src.shadow.map = clone.shadow.map`) to also pre-seed slim's backend data for the depth texture:

```js
const fullData = fullRenderer.backend.get( depthTex );
const slimData = _slimRenderer.backend.get( depthTex );
if ( fullData && fullData.texture && slimData && ! slimData.texture ) {
    slimData.texture = fullData.texture;
    slimData.format = fullData.format;
    slimData.initialized = true;
    slimData.version = depthTex.version;
    slimData.generation = ( slimData.generation || 0 ) + 1;
    if ( ! slimData.bindGroups ) slimData.bindGroups = new Set();
}
```

After fix: WebGPU validation errors gone, pipeline creates cleanly, brightFrac 0 → 0.0117. Visually still mostly black (only the HTML overlay text contributes the 1.17%) — Phase 2 still hasn't been implemented.

**Out-of-scope follow-ups (Phase 2 deferred — not implemented).**

The example also exercises three more paths the slim runtime has no hydration code for. The captured WGSL is correct; the data path at replay time is missing.

1. **Instance matrix UBO** — `UniformBuffer_5` (`array<mat4x4, 1024>`, 65536 bytes) holds the per-instance transforms set by `mesh.setMatrixAt(i, ...)`. Captured snapshot is all zeros (three.js's `BufferNode.value` is an internally-managed array, not the live `mesh.instanceMatrix.array`; the contents only land in it via three.js's normal per-frame node-update path which the slim runtime bypasses for precompiled materials).

2. **Instance color attribute** — `nodeAttribute4` (Float32Array, count=1024, itemSize=3) for `mesh.instanceColor`. The artifact records `count:1024` but with no `userPath`, so [`bindUserNodeAttributesToArtifact`](packages/runtime/src/hydrator.js#L490) can't resolve it (it only walks `material.*Node` slots; instance color hangs off the *mesh*).

3. **Morph weights + morph texture** — `UniformBuffer_4` (15 vec4 weights, set per-frame by `mesh.setMorphAt`) and `nodeUniform2: texture_2d_array<f32>` (the morph displacement texture). Both need per-frame rebinding tied to `mesh.morphTexture.needsUpdate`/version.

**Probe findings (informing Phase 2 design).** Temporarily instrumented [extractUniformPlan.js:1070](packages/plugin/src/vendor/extractUniformPlan.js#L1070) to print `binding.nodeUniform` shape for every UBO ≥ 240 bytes. Surfaced **four** distinct 65536-byte `BufferNode` UBOs in the captured material (`UniformBuffer_0/2/5/8`, all `BufferNode` type, all with empty `nodeUniform.attribute`) plus the morph weights as a `UniformArrayNode`. Implications:

- Name- or size-based detection of "which UBO is the instance matrix" doesn't work — multiple BufferNodes have identical byte length.
- `nodeUniform.attribute` is `undefined` on all of them (not a direct reference to `mesh.instanceMatrix`), so the obvious `binding.nodeUniform.attribute === mesh.instanceMatrix` check fails.
- Distinguishing them requires either (a) passing the live mesh into the extractor and comparing `nodeUniform.value.buffer === mesh.instanceMatrix.array.buffer`, OR (b) walking three.js's `InstanceNode`/`BatchNode` internals to identify the synthesised UBO by its emitter, OR (c) tagging at three.js's `NodeBuilder` injection site rather than the extractor (capture-side annotation).

**Phase 2 fix shape (estimated 2–4 days).** Capture-side: extend [`precompile-marker.js`](packages/runtime/src/precompile-marker.js) to pass `sourceObject` (the live mesh) into the extractor; teach [`extractUniformPlan`](packages/plugin/src/vendor/extractUniformPlan.js) to walk three.js's `InstanceNode`/`BatchNode`/morph-target wiring and tag the corresponding UBO/attribute bindings with new `source.kind`s (`mesh.instanceMatrix`, `mesh.instanceColor`, `mesh.morphInfluences`, `mesh.morphTexture`). Replay-side: in [`hydrator.js:2038`](packages/runtime/src/hydrator.js#L2038)'s per-frame UBO writer, add cases that pull from `frame.object.instanceMatrix.array` etc.; for morph texture, mirror the texture-rebinder pattern at [`hydrator.js:1654`](packages/runtime/src/hydrator.js#L1654).

**Same root cause as.** [STATUS.md:14](STATUS.md#L14) (`webgpu_compute_birds`: "Birds themselves still missing — instance buffer not propagating") and the alphahash follow-up note in this file's [2026-05-03 entry](#2026-05-03--slim-pmremgenerator-cant-run-blur-passes-webgpu_pmrem_scene-empty-webgpu_materials_alphahash-black). Phase 2 lifts that whole class of `InstancedMesh` examples.

**Impact sweep (Phase 1 only).** The shadow GPU-share fix is general — applies to every example that hits the offscreen shadow-render path. Worth a re-grade across the shadow examples (`webgpu_shadowmap*`, `webgpu_lights_pointlights`, anything with `light.castShadow=true`) before committing to Phase 2 scope.

---

## 2026-05-04 — PMREM management direction audit + foundation for native slim PMREM

**Trigger.** "Our way to manage PMREM still seems not correct" — request for a comparison vs. canonical three.js examples. Audit covered the four dedicated PMREM tests (`webgpu_pmrem_{cubemap,equirectangular,scene,test}` — still flagged as regressions in [coverage-summary.md:201-204](packages/examples/batch/results/coverage-summary.md#L201-L204) at 4.42–17.80 dB) and ~20 IBL-dependent regressions (`clearcoat`, `materials_alphahash`, `lights_physical`, `backdrop_*`, `caustics`, `equirectangular`, `loader_materialx`, `morphtargets_face`, `lightprobe`, `lightprobe_cubecamera`, `materials_envmaps_bpcem`).

**Diagnosis.** The diagnosis behind the existing fix chain (commits `9831a6d`, `c470b09`, `c71f47d`, `e12b32e`, `ce8d9a2`) is correct: PMREMGenerator builds 4 internal `NodeMaterial`s — `PMREM_cubemap`, `PMREM_equirect`, `PMREM_blur`, `PMREM_ggx` ([PMREMGenerator.js:943-1040](node_modules/.pnpm/three@0.184.0/node_modules/three/src/renderers/common/extras/PMREMGenerator.js#L943-L1040)) — that the slim renderer's plugin-rewritten `Nodes.js:getForRender` throws `tslPrecompileSlimOnly` on. The **implementation direction is wrong** for four reasons:

1. **It lives in the test harness, not the runtime.** All ~400 lines of PMREM workaround sit in [run-e2e.mjs](packages/examples/batch/run-e2e.mjs) (`patchPMREMGenerator` :580-609, `__sharePMREMGPUTexture` :617-645, `__generatePMREMAsync`/`__kickPMREMGenAsync`, `__wireBackgroundTextures`, `__wireEnvironmentPMREM`, slim `WebGPURenderer.init` override :1800-1813). Production users get **none** of this — `pmremGen.fromEquirectangular(tex)` still hits the slim throw.
2. **It defeats the slim runtime.** The harness loads `'/build/three.webgpu.js'` and instantiates a full `WebGPURenderer` to do PMREM. Productionising means shipping the full bundle as a "fallback" — nullifies slim's value.
3. **The fix surface keeps growing.** [LOGS.md:7-97](LOGS.md#L7-L97) shows four PMREM-adjacent fixes within ~24 hours (May 3 2026): blur passes, equirect rebind, async-loader crash, colour coercion. Symptomatic of working *around* an architecture rather than *with* it.
4. **Coverage hasn't actually recovered.** `replayBright=0.980` (post-fix) on `webgpu_pmrem_scene` reads as "something draws on screen", not "the right PMREM appears in the right binding" — PSNR 8.74 dB confirms visually wrong.

The capture-time `extractPMREMArtifact` in [aux-capture.js:269-313](packages/plugin/src/aux-capture.js#L269-L313) was openly a stub: *"For the POC we just report the configHash + a placeholder artifact; a real integration would hook into PMREMGenerator's internal material constructions."* Plus there was **no `PMREMGenerator` rewrite handler** in [pickHandler at three-rewrite.js:101-122](packages/plugin/src/three-rewrite.js#L101-L122), and **no PMREM branch in `precompileAuxiliary`** — the file ships unmodified to slim, and dev capture never produces PMREM aux artifacts.

**Direction.** Make PMREM's 4 internal materials regular precompiled artifacts so the slim renderer drives PMREM through its normal precompiled-material path. No dual-renderer, no `__sharePMREMGPUTexture`, no `__kickPMREMGenAsync`. Plan file: [our-way-to-manage-floofy-hammock.md](/Users/davidronai/.claude/plans/our-way-to-manage-floofy-hammock.md).

**Foundation landed in this session (4 files, 12/12 unit tests pass):**

1. **Real `extractPMREMArtifact`** in [aux-capture.js:253-356](packages/plugin/src/aux-capture.js#L253-L356) — drives `compileCubemapShader()` + `compileEquirectangularShader()` for the blit shaders, then `_setSizeFromTexture` + `_allocateTarget` + `_init` to materialise blur/ggx (avoiding actual fromX render passes), places all 4 materials on a throwaway scene, runs `compileTSL`, returns a 4-entry `artifacts` dict keyed by sub-shape (`cubemap`/`equirect`/`blur`/`ggx`). Each artifact gets stamped with `materialShape='pmrem-<sub>'` + a shared `configHash` over `(kind, sourceWidth, sourceHeight, format, type)`. Backward-compat preserved: returns `r.artifact` matching input `kind` for the existing test fixture.

2. **`capturePMREMLive` + `collectPMREMInputs`** in [aux-marker.js](packages/runtime/src/aux-marker.js) — discovers PMREM input textures from `scene.background`, `scene.backgroundNode` (walks for cube/equirect leaves), and per-material `material.envMap`. Excludes `CubeUVReflectionMapping` (306) since that's the PMREM result, not source. For each unique `(kind, w, h, format, type)` signature, captures all 4 internal materials and POSTs each as a separate aux entry (`pmrem-cubemap`, `pmrem-equirect`, `pmrem-blur`, `pmrem-ggx`).

3. **AUX_SHAPES whitelist** in [dev-capture-server.js:122-129](packages/plugin/src/dev-capture-server.js#L122-L129) — accepts the 4 new pmrem sub-shapes plus other shapes the runtime POSTs (`mrt`, `backdrop`, `render-output`, `cube-render-target`).

4. **PMREM internals test** in [aux-capture.test.js](packages/plugin/test/unit/aux-capture.test.js) — asserts all 4 sub-shapes produce non-empty `fragmentShader` and share the parent `configHash`.

**Architectural blocker for completing the fix.** PMREM is not a stateless single-render material. `PMREM_blur` and `PMREM_ggx` mutate uniforms (`mipInt`, `samples`, `dTheta`, `weights`, `envMap`, `latitudinal`, `roughness`) **per render dispatch** via `_uniformsMap.get(material)` — see [`_halfBlur`](node_modules/.pnpm/three@0.184.0/node_modules/three/src/renderers/common/extras/PMREMGenerator.js#L744) and [`_applyPMREM`](node_modules/.pnpm/three@0.184.0/node_modules/three/src/renderers/common/extras/PMREMGenerator.js#L617). Standard `PrecompiledMaterial` hydration wires uniforms once from material/scene/object state — those per-pass mutations never reach the GPU.

**Hook found, bridge unimplemented.** [hydrator.js:1790-1803](packages/runtime/src/hydrator.js#L1790-L1803) already supports per-frame live reads via `slot._liveNode.value` — exactly what PMREM needs. `_liveNode` is non-enumerable (JSON drops it), but for in-process slim runtime use, the bridge can populate it after PMREMGenerator helpers run.

**Remaining work for the rewrite (deferred to a focused session):**

- **`rewritePMREMGenerator(ast, ctx)`** in [three-rewrite.js](packages/plugin/src/three-rewrite.js) — replace `_getMaterial(type)` body to return `new PrecompiledMaterial(loadAux('pmrem-' + type, hash))`. Add the regex entry to `pickHandler`.
- **Runtime PMREM bridge** — after PMREMGenerator's helpers run `_uniformsMap.set(material, materialUniforms)`, walk `material.precompiledArtifact.uniformPlan` and assign each slot's `_liveNode` to the matching entry in `materialUniforms`.
- **Slot↔UniformNode matching** — easiest is to inject `uniform(value, label)` calls into PMREMGenerator's helpers (during the rewrite) so `slot.name` maps cleanly to `materialUniforms` keys. Alternative: match by initial value or by traversal order.
- **Slim-stub adjustments** — PMREMGenerator runs in the slim bundle, so `uniform()` / `texture()` / `uniformArray()` need to return objects with mutable `.value` / `.array` fields the bridge can read. Current `inertNodeStub()` accepts writes but the bridge needs a concrete shape — likely a thin `LiveUniformStub` that exposes `{ value, array }`.
- **Dismantle the harness PMREM gymnastics in [run-e2e.mjs](packages/examples/batch/run-e2e.mjs)** — only after a runtime smoke confirms PMREM runs natively.

**Verification gate for the deferred work:** `pnpm --filter examples-batch run run:e2e -- --filter=webgpu_pmrem_cubemap --save-shots` — PSNR target ≥ 30 dB (vs. current 7.80). Plus a non-harness production smoke: ship the slim runtime to a plain browser app, confirm `pmremGen.fromEquirectangular(tex)` works without `run-e2e.mjs` involved. **That's the test the current approach can never pass.**

**No coverage delta this session** — foundation files are end-to-end inactive in the slim runtime until the rewrite + bridge land. The 4 PMREM examples remain rescued by the harness gymnastics. What changed is now there's a clear, tested artifact-emission path for the next session to consume.

---

## 2026-05-04 — `pass(scene, camera)` post-process replays render black (`webgpu_materials_toon` and ~58 siblings)

**Symptom.** [packages/examples/batch/results/shots/webgpu_materials_toon.html.replay.png](packages/examples/batch/results/shots/webgpu_materials_toon.html.replay.png) is fully black except for the HTML overlay text; capture is the expected 5×5×5 grid of toon spheres with the outline pass. Same shape on [webgpu_postprocessing.html.replay.png](packages/examples/batch/results/shots/webgpu_postprocessing.html.replay.png) — capture shows the dotted halftone, replay is empty. Worker-4's report logged `replayErrors: ["Invalid or unexpected token"]` and `replayBrightFrac: 0`, but a `--filter=webgpu_materials_toon` solo run produces no SyntaxError — that one is multi-worker contamination, not the rendering bug.

**Root cause.** Capture is healthy: 218 `MeshToonNodeMaterial` + 5 `MeshBasicNodeMaterial` artifacts plus 2 aux artifacts (`post-process` outline, `render-output`) all land in the artifact files. The example drives rendering through `renderPipeline.outputNode = toonOutlinePass(scene, camera); renderPipeline.render()` — three.js's [`RenderPipeline.render()`](../three.js/src/renderers/common/RenderPipeline.js#L131) just dispatches a single full-screen `_quadMesh.render(renderer)`. The outline pass internally expects a `pass(scene, camera)` node to dispatch a *separate* scene render to a render-target whose texture it samples. The slim runtime never dispatches that nested scene render: the post-process artifact's `nodeUniform0` binding is captured as `source.kind: 'artifact.texture'`, `mapping: 300` (FramebufferTexture), and [`aux-loader.wireViewportTextureRefs()`](packages/runtime/src/aux-loader.js#L267-L337) wires a 1×1 `FramebufferTexture` stub instead of the real RT — outline pass samples 1×1 fallback → black canvas. The 218 toon material PrecompiledMaterials are correctly hydrated but never get drawn because no scene-render pass fires.

The slim runtime acknowledges the gap explicitly in [packages/runtime/src/aux-marker.js:133-139](packages/runtime/src/aux-marker.js#L133-L139): *"the slim runtime hydrator currently does not route `passNode.getTexture('output' | 'mask' | …)` to live render-target attachments. Even when this aux capture produces a `mrt` artifact, slim replay can't sample the per-attachment textures so MRT post-processing (webgpu_mrt) renders mostly black."* Same root cause for any `pass()`-based post-process chain.

**Scope.** Not toon-specific. `grep -lE "RenderPipeline|PostProcessing|toonOutlinePass" three.js/examples/webgpu_*.html` reports **58 examples** affected, including the entire `webgpu_postprocessing_*` family, `webgpu_mrt*`, `webgpu_ocean`, `webgpu_hdr`, `webgpu_reflection`, `webgpu_lights_tiled`, `webgpu_compute_particles_snow`, etc. Yesterday's [LOGS entry](#2026-05-03--material-colour-coercion-in-slim-replay-webgpu_fog_height-black-columns) flagged toon as out-of-scope for the same reason ("scene is empty (no spheres) before and after. Deeper rendering issue").

**Fix shape (not implemented).** A real fix needs the slim runtime to:
1. Detect when a post-process material's texture binding traces back to a `pass(scene, camera)` source (capture-side: stamp the user-scene + camera identity onto the binding's `source` metadata).
2. On each `RenderPipeline.render()`, dispatch `renderer.render(userScene, userCamera, renderTarget)` for each captured pass, in dependency order.
3. Bind each RT's `.texture` into the post-process artifact's `_textureRefs` Map keyed by the captured `textureUuid` so the hydrator resolves it.

Touchpoints: capture-side annotation in [packages/runtime/src/aux-marker.js](packages/runtime/src/aux-marker.js) `capturePostProcessingLive` and friends; replay-side dispatch in [packages/examples/batch/run-e2e.mjs](packages/examples/batch/run-e2e.mjs) `slimWebgpuReplayModule()` (or a new RenderPipeline patch in [packages/runtime/src/slim-stubs.js](packages/runtime/src/slim-stubs.js)). Unlocks the full ~58-example post-processing family at once.

**Deferred.** Toon and the rest stay broken until the PassNode-RT routing lands. The multi-worker `Invalid or unexpected token` SyntaxError is also deferred — the solo run is enough to confirm the rendering bug, and the parallel-only error is likely cross-test browser-process contamination unrelated to toon's data.

---

## 2026-05-03 — Slim PMREMGenerator can't run blur passes (`webgpu_pmrem_scene` empty, `webgpu_materials_alphahash` black)

**Symptom.** [packages/examples/batch/results/shots/webgpu_materials_alphahash.html.replay.png](packages/examples/batch/results/shots/webgpu_materials_alphahash.html.replay.png) was fully black; capture showed 27 alpha-hash dithered spheres correctly. `webgpu_pmrem_scene.html` similarly replayed with no visible scene environment. Both examples set `scene.environment = pmremGenerator.fromScene(new RoomEnvironment(), 0.04).texture` and have **no direct lights** — they rely entirely on IBL, so a broken environment = pure black.

**Root cause.** `PMREMGenerator.fromScene/fromCubemap/fromEquirectangular/fromTexture` internally constructs a `NodeMaterial` for its blur passes ([three/src/renderers/common/extras/PMREMGenerator.js:945](node_modules/.pnpm/three@0.184.0/node_modules/three/src/renderers/common/extras/PMREMGenerator.js#L945)). When that material is rendered, the slim renderer's plugin-rewritten `Nodes.js:getForRender` throws `tslPrecompileSlimOnly` because `material.isPrecompiledMaterial` is false. Result: `fromScene` aborts mid-execution, `scene.environment` ends up as a partially-initialized PMREM render-target texture with empty GPU data, and the captured `MeshStandardNodeMaterial` artifact's `artifact.texture`-kind bindings (with `textureName=PMREM.cubeUv`, `mapping=306`) resolve to the neutral 1×1 fallback. The harness's pre-existing `__generatePMREMAsync` rescue path only handles `fromCubemap`/`fromEquirectangular` source-texture inputs (called from `__kickPMREMGenAsync` against an already-set `scene.environment`), so it can't reach these.

**Fix.** [packages/examples/batch/run-e2e.mjs](packages/examples/batch/run-e2e.mjs) — three coordinated changes:

1. `patchPMREMGenerator` IIFE ([:582-606](packages/examples/batch/run-e2e.mjs#L582-L606)) now routes `PMREMGenerator.{fromScene,fromCubemap,fromEquirectangular,fromTexture}` to the full compute renderer when one is available. Both renderers share the same WebGPU device (per `__getComputeRenderer` line 1481), so the prefiltered GPUTexture produced by the full-renderer-backed PMREM run is immediately usable from the slim backend.
2. `__sharePMREMGPUTexture` helper ([:612-643](packages/examples/batch/run-e2e.mjs#L612-L643)) — extracted from the existing inline GPU-share block in `__generatePMREMAsync` so the new sync path can reuse it. Copies the full backend's `WeakMap<Texture, BackendData>` entry into the slim backend, then seeds `slimRenderer._textures.get(pmrem)` with `initialized=true / version / generation / bindGroups=Set()` so `updateTexture` returns early without trying to re-upload from (empty) CPU data.
3. Slim `WebGPURenderer.init` override ([:1796-1808](packages/examples/batch/run-e2e.mjs#L1796-L1808)) eagerly awaits `__getComputeRenderer(this)` after `super.init()`. Examples typically `await renderer.init()` before constructing `PMREMGenerator`, so chaining the full-renderer init here means the patched PMREMGenerator methods see `__computeRenderer` populated when fired synchronously by user code.

The original async `__generatePMREMAsync` path was simplified to call the new helper instead of carrying its own copy of the GPU-share logic.

**Verification.** `node packages/examples/batch/run-e2e.mjs --filter=webgpu_pmrem_scene --no-pixel-gate --save-shots --port=8743`:
- Before fix: `replayBright≈0` (empty canvas).
- After fix: `replayBright=0.980` — [replay PNG](packages/examples/batch/results/shots/webgpu_pmrem_scene.html.replay.png) now shows the snowy three.js demo scene environment behind the spheres, matching the capture's PMREM-IBL background. Diagnostic page-log confirmed `[tslp-pmrem] fromScene useFull=true fullRenderer=true` and `target.texture isTexture=true`.

**Out-of-scope follow-ups for `webgpu_materials_alphahash` specifically.** Replay still empty because the example also uses `RenderPipeline + ssaaPass(scene, camera) + InstancedMesh`, none of which currently route correctly through the slim runtime — separate from PMREM. The replay surfaces a `THREE.TSL: Cannot read properties of null (reading 'If')` error from the post-process path. The example's IBL is no longer the blocker (PMREM wiring confirmed working) but the rendering pipeline as a whole still doesn't drive pixels for this example. Tracked separately.

**Impact sweep.** General fix — applies to every example using any `pmremGen.fromX(...)` call at replay time. Likely also unblocks (full or partial) `webgpu_morphtargets_face`, `webgpu_instance_path`, `webgpu_materials_texture_html`, `webgpu_postprocessing_*` examples that all use `fromScene(new RoomEnvironment())` for IBL. Cubemap-input PMREM cases that were previously rescued asynchronously by `__generatePMREMAsync` now also have a synchronous fast path via the same patch — earlier hydration, fewer first-frame fallbacks. Worth a tier-1 sweep to re-grade.

---

## 2026-05-03 — 2D-equirect background never rebinds after async TextureLoader resolves (`webgpu_equirectangular` black sky)

**Symptom.** [packages/examples/batch/results/shots/webgpu_equirectangular.html.replay.png](packages/examples/batch/results/shots/webgpu_equirectangular.html.replay.png) was fully black except for the static HTML overlay. Capture showed the wooden cabin panorama correctly. The same regression visibly affected `webgpu_pmrem_equirectangular.html` (spheres flat-grey, no env reflections, no sky). The earlier cubemap fix `c470b09` ("re-hydrate background material when async cubemap resolves") restored `webgpu_lightprobe.html` (10.66 dB → ∞) but didn't help the 2D equirectangular path even though it goes through the same `__wireBackgroundTextures` code.

**Root cause.** The async-resolution rebuild path in [packages/examples/batch/run-e2e.mjs](packages/examples/batch/run-e2e.mjs) `__wireBackgroundTextures` disposes `sceneData.backgroundMesh.material`, clears `_nodes.nodeBuilderCache`, and clears `renderer._quadCache` — but it leaves `sceneData.backgroundCacheKey` intact. Three.js's `Background.update()` recomputes the cache key from the (stable, stub-driven) input, sees a match, and reuses the already-disposed material instance instead of rebuilding. For cubemaps this was masked because the render-tail PMREM-completion block ([run-e2e.mjs](packages/examples/batch/run-e2e.mjs#L1830-L1845), gated on `__backgroundNeedsPMREM && _bgSource.isCubeTexture`) ran a *second* `_quadCache.clear()` and re-wired the artifact, which apparently produced enough churn to force a fresh `RenderObject`. 2D-equirect backgrounds (`UVMapping === 300`, not PMREM-needing) skip that second block entirely, so the sky quad kept sampling the 1×1 `FramebufferTexture(1,1)` fallback that [`wireViewportTextureRefs`](packages/runtime/src/aux-loader.js#L267-L337) seeds for any `mapping === 300` slot.

**Fix.** [packages/examples/batch/run-e2e.mjs:1132](packages/examples/batch/run-e2e.mjs#L1132) — after the dispose/cache-clear sequence, also null out `sceneData.backgroundCacheKey` so `Background.update()`'s own key-change branch fires on the next frame and constructs a fresh `PrecompiledMaterial` against the now-correctly-wired `_textureRefs`. One added line, mirrored on the cubemap path (which also benefits from the explicit signal even if its existing tail-block masked the issue).

**Verification.** `pnpm --filter examples-batch run run:e2e -- --filter=webgpu_equirectangular --save-shots` → `replayBright=0.9951` (from ~0.0), PSNR 15.09 dB. Replay PNG now shows the panorama (snowy mountain through cabin window) matching the capture. The 15 dB ceiling and the harness-reported `capture produced no user-material artifacts` failure mode are unrelated to this bug — the example only has a background quad (no user-defined materials), and the residual delta is animation-phase / camera-orientation, not a missing background.

**Impact sweep.** Likely also restores `webgpu_pmrem_equirectangular.html` and any other example that sets `scene.backgroundNode = texture(equirectTex, equirectUV(), 0)` without ever assigning `scene.background` — the precondition for the harness's `__capturedBackgroundSource` recovery path. Cubemap regressions guarded by re-running `webgpu_lightprobe.html` (PSNR must stay at ∞).

---

## 2026-05-03 — Async-loader texture upload crash on first frame (`webgpu_materials` white teapots)

**Symptom.** [packages/examples/batch/results/shots/webgpu_materials.html.replay.png](packages/examples/batch/results/shots/webgpu_materials.html.replay.png) rendered all textured teapots as **solid white** while procedural-color teapots (`positionLocal`, `normalView`, `cameraProjectionMatrix.mul(...)`) rendered correctly. Coverage flagged this as `❌ regression` at PSNR 13.50 dB. Replay log carried `TypeError: Cannot read properties of null (reading 'complete') at $y.updateTexture` repeatedly.

**Root cause.** A diagnostic probe in the filename-derivation branch of `lookupLiveTextureByIdentity` confirmed the harness's TextureLoader patch was correctly registering live textures by filename and the resolver was hitting them — so this was *not* a missing-texture problem. The actual crash was in [packages/runtime/src/hydrator.js#L1338](packages/runtime/src/hydrator.js#L1338) `resolveTextureBinding`'s identity-relink branch: it unconditionally set `byIdent.needsUpdate = true` to apply the captured `flipY`. For TSL-only textures (e.g. `material.colorNode = texture(uvTexture)` where `uvTexture = textureLoader.load(...)` is still async-loading at first render), that bumps `texture.version` to 1 *before* `texture.image` arrives. Three.js's bundled WebGPU `updateTexture` guard only handles `image === undefined`; on `image === null` (Texture's default before the loader callback fires) it falls into `!1===i.complete` and crashes on `null.complete`. The whole material's draw was skipped → 1×1 white fallback up the chain.

**Fix.** [packages/runtime/src/hydrator.js:1338-1346](packages/runtime/src/hydrator.js#L1338-L1346) — only invalidate the texture when `flipY` actually changes **and** the image has already loaded:

```js
if ( typeof source.flipY === 'boolean' && byIdent.flipY !== source.flipY ) {
    byIdent.flipY = source.flipY;
    if ( byIdent.image ) byIdent.needsUpdate = true;
}
```

Three.js's stock TextureLoader `onLoad` already does `tex.image = img; tex.needsUpdate = true;` once the image arrives, so the version bump happens naturally with a non-null image. No need for the runtime to force it before the loader fires.

**Verification.** `node packages/examples/batch/run-e2e.mjs --filter=webgpu_materials.html --no-pixel-gate --save-shots` → status `✓`, no replay errors, PSNR 15.39 dB (remaining delta is animation-phase divergence — capture screenshots after `8000 ms` of `setAnimationLoop`, replay after `5000 ms` — the camera orbits at `Math.cos(0.0001 * Date.now()) * 1000`). Replay PNG now shows the UV grid texture, alpha cutouts, and triplanar mapping on every textured teapot.

Runtime smoke 50/50 pass; slim build clean.

**Impact sweep.** Same `null.complete` crash class previously listed in carry-overs for `webgpu_clearcoat.html` (texture `complete` crash on `artifact.texture` fallback) — the fix covers any example whose TSL-only texture loads async and whose binding hits the identity-fallback before the image arrives. Worth re-grading the Materials category (`webgpu_materials_texture_html` 5.37 dB worst, `webgpu_materials_envmaps`, `webgpu_materials_lightmap`, etc.) in the next coverage sweep.

---

## 2026-05-03 — Material colour-coercion in slim replay (`webgpu_fog_height` black columns)

**Symptom.** `webgpu_fog_height.html.replay.png` rendered every cube black; capture showed dusty red `0xcd959a`. The fog/background was correct in both. The brightness gate passed (`0.9997`) and PSNR reported `inf` against a stale on-disk capture, so the gate fleet missed it.

**Root cause.** The slim e2e replay's NodeMaterial constructor proxy in [packages/examples/batch/run-e2e.mjs:446-457](packages/examples/batch/run-e2e.mjs#L446-L457) did raw assignment for params (`mat[key] = params[key]`). For `new MeshPhongNodeMaterial({ color: 0xcd959a })`, the artifact-seeded `mat.color = new Color(...)` was overwritten with the raw number `13473690`. The hydrator's `writeColor` then read `value.r/g/b` on a Number → `undefined → 0` → uniform `(0, 0, 0)` → black diffuse. Production (Babel-transformed) path is unaffected — real three.js coerces the hex into a `Color` instance before `__applyPrecompiled` ever sees it.

**Fix.** Added an `__assignParam(mat, key, value)` helper that mirrors three.js `Material.setValues()` coercion:
- `current.isColor` → `current.set(value)` (hex / string / `Color` all handled by `Color.prototype.set`).
- `current.isVector2/3/4` matching `value` → `current.copy(value)`.
- Otherwise direct assignment.

Routed both the constructor proxy template and `__copyMaterialProps` through the helper. Single file changed: [packages/examples/batch/run-e2e.mjs](packages/examples/batch/run-e2e.mjs).

**Verification.** `node packages/examples/batch/run-e2e.mjs --filter=webgpu_fog_height --save-shots` → `psnr=infdB`; `webgpu_fog_height.html.replay.png` is now MD5-identical to capture (cubes dusty red).

**Impact sweep.** 17 `webgpu_*.html` examples pass `{ color: 0x… }` to a NodeMaterial constructor and were potentially affected. Spot-checked 5:

- `webgpu_fog_height` — fully fixed.
- `webgpu_lights_phong` — pre-fix near-empty/black; post-fix three teapots properly visible. Remaining 17.96 dB gap is a separate selective-light/specular bug.
- `webgpu_lensflares` — pre-fix dim cube silhouettes; post-fix cubes properly tan/orange. Remaining gap is the missing lens-flare sun glow (separate post-processing bug).
- `webgpu_clipping`, `webgpu_backdrop` — byte-identical before/after. Coercion fix is a no-op here; bottlenecked by other bugs. No regression.
- `webgpu_materials_toon` — scene is empty (no spheres) before and after. Deeper rendering issue, out of scope.

**Detection gap.** `baseBrightFrac` is dominated by background pixels for cube-heavy scenes; PSNR was reading off a stale on-disk capture during the failing window. Both gates passed despite a clear visual regression. Worth adding a per-example "expected mean colour at known mesh region" probe.

**Other coercion gaps swept.** None found in `runtime/src/` or `plugin/src/` — `_vendor-PrecompiledMaterial.js#seedMaterialProperties`, `apply-precompiled.js#copyCommonMaterialProperties`, and the hydrator value writers are all correct (or operate on already-coerced inputs). The only constructor proxy of this shape was the e2e harness one we just fixed.

Detailed trace: [packages/examples/batch/results/material-color-coercion-fix-2026-05-03.md](packages/examples/batch/results/material-color-coercion-fix-2026-05-03.md).
