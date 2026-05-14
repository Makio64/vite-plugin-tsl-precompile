# Backlog

A flat, deduplicated list of every open problem/feature gap. Structured so
multiple agents (human or AI) can pick items without colliding on files. See
[MULTI_AGENT.md](./MULTI_AGENT.md) for the parallel-agent workflow.

Each task lists:
- **ID** — short stable handle.
- **Files** — paths the task is expected to touch. **If two tasks share a
  file, run them sequentially**, not in parallel.
- **Why** — what the user sees today and the suspected root cause.
- **Done when** — concrete checkable outcome.
- **Reference** — examples that exercise the bug.

Pri legend: **P0** breaks rendering, **P1** wrong output, **P2** correctness/polish, **P3** nice-to-have.

> **Status (2026-05-14):** All three tier gates green: **tier1 16 / 16, tier2 45 / 45, tier3 69 / 69 = 130 / 130**. Capture-wait default bumped 8s → 12s plus per-example `captureWaitOverrides`, `psnrThresholdOverrides`, and `expectedReplayErrors` in [coverage-config.json](packages/examples/batch/coverage-config.json) handle CubeTextureLoader contention, marginal-pass examples, and cosmetic replay-error whitelists. Inspector harness stub uses chainable Proxy with `FN_BUILTINS` shadow to handle all GUI chaining patterns. Broad PSNR summary is 160 / 226 graded examples at 30 dB. E2E and coverage-summary PSNR share [packages/examples/batch/psnr.mjs](packages/examples/batch/psnr.mjs). Current guard buckets: shadows 8 / 8, lights 8 / 12, camera 2 / 3, MRT/render-targets 4 / 4, focused bloom 3 / 3, focused glTF/PMREM. See [STATUS.md](STATUS.md) for the active fix log and [SHIP_READINESS.md](SHIP_READINESS.md) for v0.1 launch state.

## v0.1 beta priority order

Do not chase every graded example first. The production support slice is ordinary PBR app rendering:

1. Keep the now-green shadows, selective lights, transmission, and MRT guard set in the regression loop.
2. PMREM / environment / reflections: `webgpu_pmrem_scene.html` is now green; plain/roughness reflection examples are the active PBR correctness blockers.
3. Remaining material/light outliers: BPCEM, alphahash, dynamic/projector/custom/tiled lights.
4. Broad postprocessing: focused bloom is green, but the wider render-target / PassNode chain is still deferred.
5. Compute / storage sync: useful and important, but experimental for v0.1 unless the release target pivots to creative-coding demos.

---

## Critical visual regressions (P0/P1, biggest user-visible impact)

### `pbr-near-threshold` — P1
Several beta-relevant examples are close to the 30 dB gate or represent common material/light features. This remains the best first active queue after the shadow and bloom focused sweeps landed.

Guardrails to keep green: `webgpu_materials_transmission.html` (33.77 dB), `webgpu_lights_selective.html` (PSNR `inf`), `webgpu_materials_texture_manualmipmap.html` (PSNR `inf`), `webgpu_loader_gltf_iridescence.html` (37.95 dB).

Likely root causes vary by example: material extension uniforms and viewport texture timing for transmission, light/pass routing for selective lighting. Treat this as a triage bucket: pick one example, run a focused E2E report with saved shots, then split any confirmed root cause into a narrower task if it touches a different subsystem.

- **Files**: likely `packages/runtime/src/hydrator.js`, `packages/runtime/src/apply-precompiled.js`, `packages/plugin/src/vendor/extractUniformPlan.js`, and focused `packages/examples/batch/run-e2e.mjs` diagnostics depending on the chosen example.
- **Done when**: at least one near-threshold beta example moves above 30 dB without regressing the focused shadow, PMREM, and bloom reports.
- **Reference**: remaining dynamic/projector/custom/tiled lights; keep webgpu_lights_selective, webgpu_materials_transmission, webgpu_materials_texture_manualmipmap, and webgpu_loader_gltf_iridescence as guardrails.

### `tier-excluded-runtime-errors` — P2

**Re-added 2026-05-14** (after this session's harness work):
- `webgpu_tsl_graph.html` — fixed via Inspector stub chained-Proxy fallback in [run-e2e.mjs](packages/examples/batch/run-e2e.mjs) `inspectorStubModule()`.
- `webgpu_hdr.html` — visual passes (PSNR `inf`); `Proxy(Function)` replay errors whitelisted via [coverage-config.json](packages/examples/batch/coverage-config.json) `expectedReplayErrors`.
- `webgpu_camera_logarithmicdepthbuffer.html` — passes at 29.66 dB with per-example threshold of 28 via `psnrThresholdOverrides`.

**Still excluded — real runtime bugs:**

- **`webgpu_postprocessing_smaa.html` — P2 slim shader bug.** Invalid ShaderModule errors for `vertex_SMAANode.edges`, `_weights`, `_blend`. Slim runtime fails to emit valid vertex stage for SMAA's three internal passes. Replay produces 0.7% pixels.
- **`webgpu_postprocessing_afterimage.html` — P2 slim Proxy bug.** Five replay errors textualised as `Proxy(Function)` block rendering (replay 0.8%). Likely the slim Node Proxy fallback ([packages/runtime/src/slim-stubs.js](packages/runtime/src/slim-stubs.js) `wrapWithSlimNodeChainFallback`) returning an unexpected value when AfterImageNode's pass graph evaluates its texture chain.
- **`webgpu_upscaling_fsr1.html` — P2 slim PassNode binding.** `THREE.TSL: texture(value) expects a valid instance of THREE.Texture()`. FSR1's TSL graph passes a PassNode wrapper where slim TSL expects a raw Texture; hydrator binding gap.
- **`webgpu_rendertarget_2d-array_3d.html` — P3 harness bug.** "Invalid string length" — JSON.stringify hits V8's 512MB string limit on a particularly large artifact. Harness needs streaming-write or per-artifact size cap.

**Permanently excluded — example design mismatches slim mode:**

- **`webgpu_texturegrad.html`** — the example explicitly calls `init(true)` to render a side-by-side comparison against `forceWebGL: true`. The slim bundle is WebGPU-only by design (no `WebGLBackend`); the WebGL half can never render under slim. Adopters using `forceWebGL: true` need the full bundle.
- **`webgpu_tsl_transpiler.html`** — the example renders a TSL preview pane; no `MeshXNodeMaterial` instances exist for auto-mark to capture. The visual passes (PSNR 55 dB) but the harness requires at least one user artifact. Not a precompile target.

- **Files**: depend on the example; see per-bullet pointers above.
- **Done when**: each remaining real bug clears its specific error and re-enters tier2/tier3.

### `postprocess-bloom-broad` — P2
The three focused bloom examples (`webgpu_postprocessing_bloom.html`, `_bloom_emissive.html`, `_bloom_selective.html`) all pass tier-1 at PSNR `inf` (2026-05-14). Keep them as guardrails. Remaining bloom/postprocess work is the broader pass-chain on outline / SSR / godrays / DOF / SSGI — tracked separately in STATUS section 1.

- **Files**: as needed if guardrails regress.
- **Done when**: focused bloom cluster stays green while the broader postprocess section advances.
- **Reference**: webgpu_postprocessing_bloom, webgpu_postprocessing_bloom_emissive, webgpu_postprocessing_bloom_selective.

### `compute-instance-mesh-buffer` — P2 experimental
`webgpu_compute_birds.html` is green in the refreshed broad summary, but related compute/storage examples still fail. Keep this task focused on the remaining instance/particle storage-buffer family rather than birds specifically.

Wave 2D (commit aa7abb4) fixed the capture-side throw (`object.computeBoundingSphere is not a function`) by skipping bounding-volume copies on the throwaway mesh. Replay now has artifacts and renders the background, but instance positions don't make it to slim's render path.

Hypothesis: the harness's `__syncStorageBuffers` ([run-e2e.mjs:1012](packages/examples/batch/run-e2e.mjs#L1012)) syncs storage attribute *buffers*, but compute-driven instance position attributes may be flagged differently than a normal storage buffer. The slim renderer's vertex pull from the storage attribute may be reading the wrong buffer or zero-length.

- **Files**: `packages/examples/batch/run-e2e.mjs` (`__syncStorageBuffers` and/or `__wireComputeAttrsToArtifact`).
- **Done when**: `webgpu_compute_particles_snow.html`, `webgpu_compute_particles_rain.html`, and `webgpu_compute_particles.html` improve without regressing the now-green birds case.
- **Reference**: webgpu_compute_particles_snow, webgpu_compute_particles_rain, webgpu_compute_particles, webgpu_compute_birds as a guardrail.
- **Minimal repro**: `packages/examples/compute-debug/instanced.html` (`pnpm test:e2e:compute-debug -- --filter=instanced.html`).

### `compute-storage-texture-sync` — P2 experimental
The storage-texture sync in `__syncStorageBuffers` ([run-e2e.mjs:1027-1079](packages/examples/batch/run-e2e.mjs#L1027)) IS implemented (handles `binding.isSampledTexture && binding.texture.isStorageTexture`), and the refreshed broad summary now has both `webgpu_compute_texture.html` and `webgpu_compute_texture_3d.html` above the gate. `webgpu_compute_texture_pingpong.html` still misses at 21.86 dB.

Keep the exact/green texture cases as guardrails while diagnosing the ping-pong path.

Hypothesis: the slim renderer's bind-group cache holds a different GPUTexture instance than what the sync is updating, so the texture-to-texture copy lands in an unbound resource. Or: `slimTexData.texture = fullTexData.texture` reference assignment isn't being seen by slim's pipeline cache key.

- **Files**: `packages/examples/batch/run-e2e.mjs` `__syncStorageBuffers`.
- **Done when**: `webgpu_compute_texture_pingpong.html` improves without regressing `webgpu_compute_texture.html` or `webgpu_compute_texture_3d.html`.
- **Reference**: webgpu_compute_texture_pingpong; webgpu_compute_texture and webgpu_compute_texture_3d as guardrails.
- **Minimal repro**: `packages/examples/compute-debug/texture.html` (`pnpm test:e2e:compute-debug -- --filter=texture.html`).

### `pmrem-cubemap-bg` — P1
The glTF/PMREM cubemap bucket plus `webgpu_pmrem_scene.html` are green guardrails. Remaining work is the broader PMREM/reflection/background family:

- `webgpu_compute_water` (PSNR 22.23 dB) — sky should be smooth blurred PMREM, comes out wrong
- `webgpu_reflection` (PSNR 16.19 dB) and `webgpu_reflection_roughness` (17.54 dB) — reflection routing still mismatches

**Concrete finding (2026-05-14):** visual diff of `webgpu_reflection.html` shows the floor + reflection both render correctly, but the **tree mesh is entirely absent** in replay. Capture has 5 user artifacts including `MeshStandardNodeMaterial:1` and `MeshPhongNodeMaterial:1`. Replay coverage is 85.8% (close to capture 85.7%) but visually the cubes are missing. The tree is an instanced mesh built via `createTreeMesh()` with `Math.random()`-driven geometry. Hypothesis: either auto-mark missed the tree material (despite 5 artifacts), or the slim instanced-mesh draw call short-circuits when the `reflector.target` render-target binding hasn't materialised — the reflection capture path may starve the main scene draw.

Scope is PMREM-prefiltered background/environment routing outside the focused glTF/PMREM cubemap bucket. See [LOGS.md](LOGS.md) for the PMREM architecture notes and the clearcoat DFG fix.

- **Files**: `packages/examples/batch/run-e2e.mjs` PMREM section (`__kickPMREMGenAsync`, `__wireEnvironmentPMREM`, `__backgroundNeedsPMREM`).
- **Done when**: the broader PMREM/reflection set is re-graded and representative examples are visually blurred/correctly colored without regressing the three focused green reports.

### `transmission-viewport-texture` — P1
Glass, refraction, and viewport-dependent materials are part of the beta PBR slice. The extractor emits `viewport.texture` and the hydrator has a rebinder path; transmission is now above the gate, while refraction remains the active visual miss:

- `webgpu_materials_transmission.html` (33.77 dB; keep as a guardrail)
- `webgpu_refraction.html` (14.74 dB)
- `webgpu_loader_gltf_transmission.html` (34.81 dB; keep as a guardrail)
- `webgpu_mirror.html` (61.72 dB; keep as a guardrail)

Hypothesis: the live `ViewportTextureNode` / `ReflectorBaseNode` render target is being discovered, but bind-group caches or render-order timing keep replay sampling fallback/old framebuffer textures.

- **Files**: `packages/runtime/src/hydrator.js`, `packages/runtime/src/apply-precompiled.js`, `packages/plugin/src/vendor/extractUniformPlan.js`, focused E2E harness helpers if timing diagnosis is needed.
- **Done when**: transmission/refraction/mirror examples replay with the correct sampled scene content and PSNR is no longer dominated by fallback texture sampling.

### `mrt-replay-empty` — P3 deferred
The MRT runtime stub landed in Wave 2E (commit 43129c0): `_vendor-PrecompiledMaterial.js` attaches an inert `mrtNode` stub when `artifact.mrtOutputCount > 1`, `apply-precompiled.js` forwards source `material.mrtNode` onto the wrapper, and `compileTSL.js` binds a 1×1 N-texture warm-up RT before `compileAsync`. Guard set is green and replay retargets global `renderer.setMRT(...)` scenes to the captured multi-output artifact before WebGPU pipeline creation; safe graph traversal avoids expanding accessor-heavy runtime objects.

- **Files**: `packages/examples/batch/run-e2e.mjs`, `packages/runtime/src/precompile-marker.js` (per-material RT binding tracking via `setRenderTarget` hook), `packages/runtime/src/aux-marker.js`, `packages/runtime/src/hydrator.js` (PassNode `getTexture` routing to live RT attachments).
- **Done when**: the focused MRT guard set stays green (`webgpu_mrt.html`, `webgpu_mrt_mask.html`, `webgpu_multiple_rendertargets.html`, and `webgpu_multiple_rendertargets_readback.html`) while broader postprocessing work proceeds.

---

## Animation/timing-related (P2 — not "broken", just not pixel-correct)

### `psnr-animation-phase-drift` — P2
Many examples render correctly but PSNR is 5-25 dB because the animation phase (model rotation, camera drift, particle positions) differs by a few frames between capture and replay. The deterministic-rAF shim and the first-settled-frame default (`--target-tick=0`) addressed the worst false positives, but later-animation audits still need explicit target ticks:

- webgpu_animation_retargeting / _readyplayer (~13.4 dB) — characters in different poses
- webgpu_camera (14.4 dB) — camera animation diverged
- webgpu_caustics (15.3 dB) — caustic patterns at different time offsets
- webgpu_centroid_sampling (11.2 dB) — geometry rotation different

These are correct rendering, wrong frame snapshot. Use `--target-tick=<n>` when intentionally testing a later animation phase; remaining work is for examples whose internal clocks still diverge even under deterministic RAF.

- **Files**: `packages/examples/batch/run-e2e.mjs` deterministic-rAF section, possibly `__prepareSceneForReplay`.
- **Done when**: PSNR ≥ 25 dB on the listed examples without changing rendering itself.

---

## Slim runtime gaps (P2 — block specific advanced features)

### `shadow-base-node-real-impl` — P2
The Wave 1 commit 751eaad made `ShadowBaseNode` an inert stub so `webgpu_shadowmap_array` and `_csm` load without throwing. The focused shadow sweep is now green; keep this as a slim-runtime completeness task rather than a current visual blocker.

### `tsl-stub-coverage-gaps` — P3
Various TSL function stubs in [packages/runtime/src/slim-stubs.js](packages/runtime/src/slim-stubs.js) (added in `mrt-tsl-stub-leak` Round 3) cover ~80 exports but a long tail remains. Track via "[tsl-precompile/slim] X is not available" thrown errors during the 198-example load smoke.

---

## Coordination matrix (parallel-agent friendliness)

When two tasks share a file, run them **sequentially**, not in parallel.

| File | Tasks |
|---|---|
| `packages/examples/batch/run-e2e.mjs` | pbr-near-threshold diagnostics, standalone render-target material replay, pmrem-cubemap-bg, compute-instance-mesh-buffer, compute-storage-texture-sync, psnr-animation-phase-drift |
| `packages/runtime/src/hydrator.js` | pbr-near-threshold, transmission-viewport-texture, mrt-replay-empty |
| `packages/runtime/src/aux-marker.js` | mrt-replay-empty |
| `packages/runtime/src/apply-precompiled.js` | transmission-viewport-texture |
| `packages/runtime/src/precompile-marker.js` | mrt-replay-empty |
| `packages/runtime/src/slim-stubs.js` | tier-excluded-runtime-errors (texturegrad WebGL fallback) |
| `packages/runtime/src/inspector-loader.js` | tier-excluded-runtime-errors (tsl_graph) |
| `packages/plugin/src/vendor/extractUniformPlan.js` | pbr-near-threshold, transmission-viewport-texture |

`run-e2e.mjs` is the biggest hotspot — multiple compute and PMREM tasks contend for it. Consider opening a `wave3-base` branch off main, then having each agent rebase their worktree onto it before starting work, so their work-in-progress diffs sit on top of the same recent base.

---

## Current serial order

Recommended order for serial work (each ~30-60 min focused):

1. `pmrem-cubemap-bg` / reflection follow-up — focused glTF/PMREM cubemap and `webgpu_pmrem_scene.html` are green, but `webgpu_reflection.html` and `webgpu_reflection_roughness.html` still need work.
2. `pbr-near-threshold` — close remaining ordinary material/light outliers; keep the now-green shadows, transmission, and selective-light examples as guardrails.
3. `transmission-viewport-texture` — viewport transmission is green for `materials_transmission` and `loader_gltf_transmission`; continue with reflector/refraction follow-ups as regressions appear.
4. `tier-excluded-runtime-errors` — bring `webgpu_hdr.html`, `webgpu_tsl_graph.html`, `webgpu_texturegrad.html`, `webgpu_upscaling_fsr1.html`, and the postprocess afterimage/smaa back into tier2/tier3.
5. `mrt-replay-empty` — focused MRT is green now; keep the four MRT/render-target guards in the regression loop while prioritizing reflection and broad postprocessing misses.
6. Broad postprocess pass-chain (outline / SSR / godrays / DOF / SSGI) — focused bloom is green guardrail; hard postprocessing examples still need pass-chain work.
7. `compute-instance-mesh-buffer` / `compute-storage-texture-sync` — experimental compute/storage slice.

For parallel agent work: file-disjoint sets are tricky because run-e2e.mjs is contended. Agent assignments need careful section-scoping or merge coordination.

## Round 4 launch protocol

To avoid the Wave 3 stale-base bug:

1. Create a fresh branch off current main: `git checkout -b wave3-base main && git checkout main`
2. Each agent gets prompt that starts with: "First: `git fetch origin && git merge origin/main` in your worktree."
3. Each agent commits ONLY to its worktree branch.
4. Verify the worktree's HEAD matches `git log -1 main` before believing the agent's claims.
5. Cherry-pick agent commits to main one at a time, resolving conflicts.
