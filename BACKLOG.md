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

> **Status (2026-05-12):** The refreshed broad PSNR summary is 153 / 225 graded examples at 30 dB, with 72 visual regressions remaining. E2E and coverage-summary PSNR now share [packages/examples/batch/psnr.mjs](packages/examples/batch/psnr.mjs), so `webgpu_shadowmap_array.html` is counted consistently at 34.20 dB. The generated shadow bucket is currently 7 / 8 because `webgpu_shadowmap_opacity.html` is below the gate at 10.80 dB.

## v0.1 beta priority order

Do not chase every graded example first. The production support slice is ordinary PBR app rendering:

1. Restore the broad shadow bucket to green, then keep the active beta queue on near-threshold PBR/material and lighting regressions.
2. PMREM / environment / reflections: PBR can look plausibly rendered while the lighting is wrong.
3. Transmission / viewport / reflector textures: glass, refraction, and mirrors are real material features.
4. Compute / storage sync: useful and important, but experimental for v0.1 unless the release target pivots to creative-coding demos.
5. MRT and broad postprocessing: focused bloom is green, but the wider render-target / PassNode chain is still deferred.

---

## Critical visual regressions (P0/P1, biggest user-visible impact)

### `shadowmap-opacity-broad-regression` — P1
The shared-PSNR broad summary now reports `webgpu_shadowmap_opacity.html` at 10.80 dB, while the previous focused shadow sweep had all eight shadow examples passing. First distinguish stale saved shots/report drift from a real runtime regression before touching the shadow rebinder.

- **Files**: likely `packages/examples/batch/run-e2e.mjs`, `packages/runtime/src/hydrator.js`, and `packages/runtime/src/aux-loader.js` if diagnosis confirms a runtime issue; otherwise refreshed `packages/examples/batch/results/shots/*shadowmap_opacity*` and `packages/examples/batch/results/coverage-summary.md`.
- **Done when**: focused and broad `webgpu_shadowmap_opacity.html` both compare above 30 dB, the generated shadow bucket returns to 8 / 8, and `webgpu_shadowmap_array.html` remains a guardrail above the gate.
- **Reference**: webgpu_shadowmap_opacity, webgpu_shadowmap_array.

### `pbr-near-threshold` — P1
Several beta-relevant examples are close to the 30 dB gate or represent common material/light features. This remains the best first active queue after the shadow and bloom focused sweeps landed.

Current useful signals:
- `webgpu_materials_texture_manualmipmap.html` — resolved by refresh; now PSNR `inf`.
- `webgpu_loader_gltf_iridescence.html` — resolved by refresh; now 37.95 dB.
- `webgpu_materials_transmission.html` — now above the focused gate at 33.77 dB; keep it as a guardrail.
- `webgpu_lights_selective.html` — 26.18 dB in the generated broad summary.

Likely root causes vary by example: material extension uniforms and viewport texture timing for transmission, and light/pass routing for selective lighting. Treat this as a triage bucket: pick one example, run a focused E2E report with saved shots, then split any confirmed root cause into a narrower task if it touches a different subsystem.

- **Files**: likely `packages/runtime/src/hydrator.js`, `packages/runtime/src/apply-precompiled.js`, `packages/plugin/src/vendor/extractUniformPlan.js`, and focused `packages/examples/batch/run-e2e.mjs` diagnostics depending on the chosen example.
- **Done when**: at least one near-threshold beta example moves above 30 dB without regressing the focused shadow, PMREM, and bloom reports.
- **Reference**: webgpu_lights_selective; keep webgpu_materials_transmission, webgpu_materials_texture_manualmipmap, and webgpu_loader_gltf_iridescence as guardrails.

### `toon-outline-pass` — P1 — resolved
`webgpu_materials_toon.html` now passes at PSNR `inf` in `next-toon-outline-pass.json`. The example uses `toonOutlinePass(scene, camera)`, whose `updateBefore()` creates a dynamic outline `NodeMaterial` and calls `renderer.renderObject()` outside the normal scene material marking path.

Useful investigation:
- A focused run in `next-pbr-toon-confirmed-outline-gap.json` reproduces the mismatch with no capture/replay errors.
- Preserving `isMeshToonNodeMaterial` on replay materials made the outline path run, but produced a mostly black replay because the dynamic outline material was not precompiled/hydrated. Do not re-land that flag propagation until the outline material has an aux artifact path.
- The resolved path captures `isMeshToonOutlineMaterial` from capture-side `renderer.renderObject()`, keeps replay `MeshToonNodeMaterial` flags on matching precompiled materials, and swaps the dynamic outline material to a captured `NodeMaterial` artifact before slim render.

- **Files**: `packages/examples/batch/run-e2e.mjs`.
- **Done when**: done for `webgpu_materials_toon.html`; keep `webgpu_postprocessing_outline.html` as a separate postprocessing-outline task.
- **Reference**: webgpu_materials_toon, webgpu_postprocessing_outline.

### `shadowmap-array-refresh` — P2 — resolved
The latest shared-PSNR broad summary reports `webgpu_shadowmap_array.html` at 34.20 dB, using the same ignore region in both E2E and coverage-summary paths. The old report/PNG disagreement is resolved. The current generated shadow bucket is still 7 / 8 because `webgpu_shadowmap_opacity.html` is below the gate; track that separately under `shadowmap-opacity-broad-regression`.

- **Files**: `packages/examples/batch/results/shots/*shadowmap_array*`, `packages/examples/batch/results/coverage-summary.md`, and site thumbs/data if refreshing public artifacts.
- **Done when**: done; keep as historical context if future report/PNG disagreement appears.
- **Reference**: webgpu_shadowmap_array.

### `postprocess-bloom-texture-handoff` — P1 — reopened for selective bloom
The portal `pass(scene, camera)` path worked in the 2026-05-11 focused run, but the latest selective-bloom rerun no longer clears the visual gate.

Latest useful signals:
- `visual-bloom-cluster-after-fixes.json` (2026-05-11): `webgpu_postprocessing_bloom.html`, `webgpu_postprocessing_bloom_emissive.html`, and `webgpu_postprocessing_bloom_selective.html` all pass with PSNR `inf`.
- `architecture-capture-graph-helper.json` (2026-05-13): `webgpu_postprocessing_bloom_selective.html` improves after capture graph helper parity but still fails at 19.61 dB with one capture-side shader validation error.
- Selective bloom now captures 51 user artifacts + 14 aux artifacts; MeshBasic MRT artifacts carry `mrtOutputCount: 2` with `output,bloomIntensity`.

The original full-white replay failure is reduced, but selective bloom still needs a narrower PassNode/MRT follow-up before this can be closed again.

- **Files**: `packages/examples/batch/run-e2e.mjs`, `packages/runtime/src/aux-marker.js`, `packages/runtime/src/slim-entry.js`, possibly `packages/runtime/src/slim-stubs.js` and `packages/runtime/src/graph-hash.js` if pass-node/runtime exports need more hardening.
- **Done when**: the three focused bloom examples are above the PSNR gate again, with no capture-side shader validation error.
- **Reference**: webgpu_postprocessing_bloom, webgpu_postprocessing_bloom_emissive, webgpu_postprocessing_bloom_selective; follow-up for `webgpu_postprocessing.html` missing dots.

### `displacementmap-blank-replay` — P0 — resolved in broad summary
`webgpu_materials_displacementmap.html` now passes at 32.69 dB in the refreshed broad summary. Keep this note only as historical context if the regression reappears.

`replayBright=0.26` (from header text only), `psnr=10.06 dB`. Wave 1C wired the displacement scalars; Wave 1 follow-up (fc82f2d) added emit-updater cases for `material.displacementScale/Bias/bumpScale`. The artifact has these bindings populated. Yet the model renders blank.

Hypothesis: vertex shader displacement creates malformed positions that fail the WebGPU pipeline's depth-test or geometry culls. May need to verify `texture(displacementMap)` UV plumbing through the material UV transform path — `displacementMap` UVs typically use a separate matrix from diffuse `map`.

- **Files**: probably `packages/plugin/src/vendor/extractUniformPlan.js` (UV matrix extraction for non-`map` texture properties), possibly `packages/runtime/src/hydrator.js` (texture matrix wiring).
- **Done when**: no active work; reopen only if a fresh focused run drops below the PSNR gate again.
- **Reference**: webgpu_materials_displacementmap.

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
Partially resolved in the 2026-05-05 focused queue. The glTF/PMREM cubemap bucket is now green:

- `webgpu_loader_gltf.html` — PSNR `inf` in `visual-loader-gltf-after-pmrem-flipy.json`.
- `webgpu_loader_gltf_sheen.html` — PSNR `inf` in `visual-loader-gltf-sheen-after-pmrem-flipy.json`.
- `webgpu_pmrem_cubemap.html` — PSNR `inf` in `visual-pmrem-cubemap-after-cube-mapping-normalize.json`.

Remaining work is the broader PMREM/reflection/background family, especially paths not covered by those focused reports:

- `webgpu_compute_water` (PSNR 22.23 dB) — sky should be smooth blurred PMREM, comes out wrong
- `webgpu_pmrem_scene` (PSNR 27.15 dB in `architecture-pmrem-scene-compile-root.json`) — scene-driven PMREM now uses a full-renderer scene clone but still misses the 30 dB gate
- `webgpu_reflection` (PSNR 15.01 dB) — reflection routing still mismatches
The clearcoat DFG regression is fixed, so this task is now specifically about PMREM-prefiltered background/environment routing outside the focused glTF/PMREM cubemap bucket. See [LOGS.md](LOGS.md) for the PMREM architecture notes and the clearcoat DFG fix.

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
The MRT runtime stub landed in Wave 2E (commit 43129c0):
- `_vendor-PrecompiledMaterial.js` attaches an inert `mrtNode` stub when `artifact.mrtOutputCount > 1`
- `apply-precompiled.js` forwards source `material.mrtNode` onto the wrapper
- `compileTSL.js` binds a 1×1 N-texture warm-up RT before `compileAsync`

Current MRT/render-target state:
- `webgpu_mrt` is now green at PSNR `inf`; keep it as a guardrail.
- `webgpu_mrt_mask` is now green at 32.46 dB after the RenderPipeline fullscreen quad bypass; keep it as a guardrail.
- `webgpu_multiple_rendertargets` and `webgpu_multiple_rendertargets_readback` now pass at PSNR `inf` in `architecture-mrt-attachments.json`; replay retargets global `renderer.setMRT(...)` scenes to the captured multi-output artifact before WebGPU pipeline creation.
- `webgpu_rtt.html`, `webgpu_depth_texture.html`, and `webgpu_multisampled_renderbuffers.html` are now green after replay started replacing standalone `QuadMesh` / render-target materials before slim render.
- `webgpu_rendertarget_2d-array_3d.html` now passes focused E2E at 41.96 dB in `architecture-rendertarget-array3d.json`; safe graph traversal avoids expanding accessor-heavy runtime objects.

Wave 2E agent's report identifies the precise gaps. Implementation pending.

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
| `packages/examples/batch/run-e2e.mjs` | shadowmap-opacity-broad-regression, pbr-near-threshold diagnostics, standalone render-target material replay, postprocess-bloom-texture-handoff, pmrem-cubemap-bg, compute-instance-mesh-buffer, compute-storage-texture-sync, psnr-animation-phase-drift |
| `packages/runtime/src/hydrator.js` | shadowmap-opacity-broad-regression if runtime-confirmed, pbr-near-threshold, transmission-viewport-texture, mrt-replay-empty |
| `packages/runtime/src/aux-marker.js` | toon-outline-pass, postprocess-bloom-texture-handoff, mrt-replay-empty |
| `packages/runtime/src/slim-entry.js` | postprocess-bloom-texture-handoff |
| `packages/runtime/src/slim-stubs.js` | toon-outline-pass if a replay-safe `toonOutlinePass` shim is needed |
| `packages/runtime/src/graph-hash.js` | postprocess-bloom-texture-handoff |
| `packages/runtime/src/aux-loader.js` | shadowmap-opacity-broad-regression if runtime-confirmed, shadowmap-array-refresh only if the focused pass stops reproducing |
| `packages/runtime/src/apply-precompiled.js` | transmission-viewport-texture |
| `packages/runtime/src/precompile-marker.js` | mrt-replay-empty |
| `packages/plugin/src/vendor/extractUniformPlan.js` | pbr-near-threshold, transmission-viewport-texture |

`run-e2e.mjs` is the biggest hotspot — multiple compute and PMREM tasks contend for it. Consider opening a `wave3-base` branch off main, then having each agent rebase their worktree onto it before starting work, so their work-in-progress diffs sit on top of the same recent base.

---

## Current serial order

Recommended order for serial work (each ~30-60 min focused):

1. `shadowmap-opacity-broad-regression` — make focused and generated shadow coverage agree again.
2. `pbr-near-threshold` — close the remaining ordinary material/light examples nearest the gate; keep the now-green transmission and selective-light examples as guardrails.
3. `transmission-viewport-texture` — viewport transmission is green for `materials_transmission` and `loader_gltf_transmission`; continue with refraction/reflector follow-ups.
4. `pmrem-cubemap-bg` — focused glTF/PMREM cubemap bucket is green, but `webgpu_pmrem_scene.html` and `webgpu_reflection.html` still need work.
5. `mrt-replay-empty` — focused MRT is green now; keep the four MRT/render-target guards in the regression loop while prioritizing PMREM-scene and broad postprocessing misses.
6. `compute-instance-mesh-buffer` / `compute-storage-texture-sync` — experimental compute/storage slice.

For parallel agent work: file-disjoint sets are tricky because run-e2e.mjs is contended. Agent assignments need careful section-scoping or merge coordination.

## Round 4 launch protocol

To avoid the Wave 3 stale-base bug:

1. Create a fresh branch off current main: `git checkout -b wave3-base main && git checkout main`
2. Each agent gets prompt that starts with: "First: `git fetch origin && git merge origin/main` in your worktree."
3. Each agent commits ONLY to its worktree branch.
4. Verify the worktree's HEAD matches `git log -1 main` before believing the agent's claims.
5. Cherry-pick agent commits to main one at a time, resolving conflicts.
