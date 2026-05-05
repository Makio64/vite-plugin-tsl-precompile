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

> **Status (2026-05-05):** Unit tests/load-smoke are still assumed from the previous green baseline; no full suite was rerun after the latest focused visual work. The last broad PSNR summary was 30 / 194 graded examples at 30 dB, but focused runs now have `webgpu_loader_gltf.html`, `webgpu_loader_gltf_sheen.html`, `webgpu_pmrem_cubemap.html`, and `webgpu_portal.html` at PSNR `inf`. Bloom is the current unfinished thread. See [STATUS.md](STATUS.md) and [CONTINUATION_PLAN.md](CONTINUATION_PLAN.md) for the focused report list.

## v0.1 beta priority order

Do not chase all 194 graded examples first. The production support slice is ordinary PBR app rendering:

1. Shadows: first visual correctness cluster; users notice missing or wrong shadows immediately.
2. PMREM / environment / reflections: PBR can look plausibly rendered while the lighting is wrong.
3. Transmission / viewport / reflector textures: glass, refraction, and mirrors are real material features.
4. Compute / storage sync: useful and important, but experimental for v0.1 unless the release target pivots to creative-coding demos.
5. MRT and broad postprocessing: deferred until the render-target / PassNode chain is truly wired.

---

## Critical visual regressions (P0/P1, biggest user-visible impact)

### `shadows-no-render` — P0
**Shadows are still the first beta blocker.** One shadow example now matches, but the category is only 1 / 8 and two examples still produce no replay frame.

Current root-cause state:

1. **Capture-side shadow flags are now propagated.** [packages/runtime/src/precompile-marker.js](packages/runtime/src/precompile-marker.js) explicitly copies `receiveShadow` / `castShadow` onto the throwaway mesh, so WGSL can include shadow-sampling paths.

2. **Runtime shadow/depth binding remains the blocker.** The rebinder now refuses to put color shadow targets into `texture_depth_2d` slots, but the shadow pass still must reliably populate a live `shadow.map.depthTexture` and avoid running on scenes that do not need shadows.

Implementation direction:
- Gate the replay shadow-scene render on actual shadow-casting lights and shadow-receiving materials.
- Invalidate/rebuild bind groups when the fallback depth texture is replaced by the live shadow texture.
- Keep the auxiliary shadow-depth path as the production direction; harness-side shadow scene rendering is useful for diagnosis but should not become the app contract.

- **Files**: `packages/runtime/src/hydrator.js`, `packages/runtime/src/aux-marker.js`, `packages/runtime/src/aux-loader.js`, `packages/examples/batch/run-e2e.mjs`.
- **Done when**: `webgpu_shadowmap.html` and `webgpu_shadowmap_pointlight.html` replay, and the shadow category rises above the 30 dB gate on representative examples.
- **Reference**: webgpu_shadowmap, webgpu_shadowmap_opacity, webgpu_shadowmap_vsm, webgpu_shadowmap_progressive, webgpu_shadow_contact (5 examples; 2 more — `_csm`, `_array` — also need it but `ShadowBaseNode` stub fix in 751eaad already unblocks the load).

### `postprocess-bloom-texture-handoff` — P1
The portal `pass(scene, camera)` path now works in the focused run, but bloom still proves that the render-target texture chain is incomplete. Replay runs a real addon `BloomNode` and the internal high-pass/blur/composite passes report no WebGPU/runtime errors, but the final composite is too dim or effectively black.

Latest useful signals:
- `visual-bloom-diagnostic-15.json`: `webgpu_postprocessing_bloom.html` status pass, PSNR `15.44`, replay brightness `0.1186` vs capture `0.7503`, bloom diagnostics `collected=1`, `prepared=1`, `fullRendered=15`, `highPass=15`, `blur=150`, `composite=15`, `renderFailed=0`.
- `visual-bloom-after-internal-aux.json`: `webgpu_postprocessing_bloom.html` PSNR `15.44`, `webgpu_postprocessing_bloom_emissive.html` PSNR `20.84`, `webgpu_postprocessing_bloom_selective.html` PSNR about `13.36`.

Hypothesis: the full-renderer bloom pass executes, but either the source pass output handed to the full renderer is black/stale, or the final slim postprocess artifact is not rebinding/sampling the intended bloom composite texture (`UnrealBloomPass.h0`).

- **Files**: `packages/examples/batch/run-e2e.mjs`, `packages/runtime/src/aux-marker.js`, `packages/runtime/src/slim-entry.js`, possibly `packages/runtime/src/slim-stubs.js` and `packages/runtime/src/graph-hash.js` if pass-node/runtime exports need more hardening.
- **Done when**: `webgpu_postprocessing_bloom.html`, `webgpu_postprocessing_bloom_emissive.html`, and `webgpu_postprocessing_bloom_selective.html` replay with visible bloom and pass the 30 dB PSNR gate.
- **Reference**: webgpu_postprocessing_bloom, webgpu_postprocessing_bloom_emissive, webgpu_postprocessing_bloom_selective; follow-up for `webgpu_postprocessing.html` missing dots.

### `displacementmap-blank-replay` — P0
`webgpu_materials_displacementmap.html` replay is **completely black** despite 3 user artifacts + 2 aux artifacts captured. Capture shows a fully-rendered ninja head with displacement, normal, AO, and environment maps lit by red/blue point lights. Replay shows just the page header text — the model is not drawing at all.

`replayBright=0.26` (from header text only), `psnr=10.06 dB`. Wave 1C wired the displacement scalars; Wave 1 follow-up (fc82f2d) added emit-updater cases for `material.displacementScale/Bias/bumpScale`. The artifact has these bindings populated. Yet the model renders blank.

Hypothesis: vertex shader displacement creates malformed positions that fail the WebGPU pipeline's depth-test or geometry culls. May need to verify `texture(displacementMap)` UV plumbing through the material UV transform path — `displacementMap` UVs typically use a separate matrix from diffuse `map`.

- **Files**: probably `packages/plugin/src/vendor/extractUniformPlan.js` (UV matrix extraction for non-`map` texture properties), possibly `packages/runtime/src/hydrator.js` (texture matrix wiring).
- **Done when**: replay shows the ninja head model with visible displacement (≥70% of capture PNG size).
- **Reference**: webgpu_materials_displacementmap.

### `compute-instance-mesh-buffer` — P2 experimental
`webgpu_compute_birds.html` replay shows the gradient sky background but **no birds**. Capture shows ~600 small bird sprites scattered. The compute kernel writes bird positions into a storage buffer; an `InstancedMesh` reads positions per instance and draws bird sprites.

Wave 2D (commit aa7abb4) fixed the capture-side throw (`object.computeBoundingSphere is not a function`) by skipping bounding-volume copies on the throwaway mesh. Replay now has artifacts and renders the background, but instance positions don't make it to slim's render path.

Hypothesis: the harness's `__syncStorageBuffers` ([run-e2e.mjs:1012](packages/examples/batch/run-e2e.mjs#L1012)) syncs storage attribute *buffers*, but compute-driven instance position attributes may be flagged differently than a normal storage buffer. The slim renderer's vertex pull from the storage attribute may be reading the wrong buffer or zero-length.

- **Files**: `packages/examples/batch/run-e2e.mjs` (`__syncStorageBuffers` and/or `__wireComputeAttrsToArtifact`).
- **Done when**: webgpu_compute_birds.html.replay.png shows visible bird sprites.
- **Reference**: webgpu_compute_birds, possibly webgpu_compute_particles_snow (replayBright 0.008 — similar instance-buffer issue?).

### `compute-storage-texture-sync` — P2 experimental
The storage-texture sync in `__syncStorageBuffers` ([run-e2e.mjs:1027-1079](packages/examples/batch/run-e2e.mjs#L1027)) IS implemented (handles `binding.isSampledTexture && binding.texture.isStorageTexture`), but `webgpu_compute_texture` / `_pingpong` / `_3d` still render at very-low brightness (0.007 / 0.011 / 1.0).

For `webgpu_compute_texture_3d` brightness=1.0 but PSNR=4.42 — renders something, but very wrong colors.

Hypothesis: the slim renderer's bind-group cache holds a different GPUTexture instance than what the sync is updating, so the texture-to-texture copy lands in an unbound resource. Or: `slimTexData.texture = fullTexData.texture` reference assignment isn't being seen by slim's pipeline cache key.

- **Files**: `packages/examples/batch/run-e2e.mjs` `__syncStorageBuffers`.
- **Done when**: all three replay PNGs ≥70% of capture size.
- **Reference**: webgpu_compute_texture, webgpu_compute_texture_pingpong, webgpu_compute_texture_3d.

### `pmrem-cubemap-bg` — P1
Partially resolved in the 2026-05-05 focused queue. The glTF/PMREM cubemap bucket is now green:

- `webgpu_loader_gltf.html` — PSNR `inf` in `visual-loader-gltf-after-pmrem-flipy.json`.
- `webgpu_loader_gltf_sheen.html` — PSNR `inf` in `visual-loader-gltf-sheen-after-pmrem-flipy.json`.
- `webgpu_pmrem_cubemap.html` — PSNR `inf` in `visual-pmrem-cubemap-after-cube-mapping-normalize.json`.

Remaining work is the broader PMREM/reflection/background family, especially paths not covered by those focused reports:

- `webgpu_compute_water` (PSNR 12.95 dB) — sky should be smooth blurred PMREM, comes out wrong
- `webgpu_compute_cloth` (PSNR 9.61 dB)
- `webgpu_compute_particles_fluid` (PSNR 4.83 dB)
- `webgpu_lightprobe_cubecamera` (PSNR 17.48 dB) — light probe + PMREM
The clearcoat DFG regression is fixed, so this task is now specifically about PMREM-prefiltered background/environment routing outside the focused glTF/PMREM cubemap bucket. See [LOGS.md](LOGS.md) for the PMREM architecture notes and the clearcoat DFG fix.

- **Files**: `packages/examples/batch/run-e2e.mjs` PMREM section (`__kickPMREMGenAsync`, `__wireEnvironmentPMREM`, `__backgroundNeedsPMREM`).
- **Done when**: the broader PMREM/reflection set is re-graded and representative examples are visually blurred/correctly colored without regressing the three focused green reports.

### `transmission-viewport-texture` — P1
Glass, refraction, and viewport-dependent materials are part of the beta PBR slice. The extractor emits `viewport.texture` and the hydrator has a rebinder path, but the visual examples are still far below the production bar:

- `webgpu_materials_transmission.html` (5.91 dB)
- `webgpu_loader_gltf_transmission.html` (4.92 dB)
- `webgpu_refraction.html` (5.62 dB)
- `webgpu_mirror.html` (10.69 dB; reflector path)

Hypothesis: the live `ViewportTextureNode` / `ReflectorBaseNode` render target is being discovered, but bind-group caches or render-order timing keep replay sampling fallback/old framebuffer textures.

- **Files**: `packages/runtime/src/hydrator.js`, `packages/runtime/src/apply-precompiled.js`, `packages/plugin/src/vendor/extractUniformPlan.js`, focused E2E harness helpers if timing diagnosis is needed.
- **Done when**: transmission/refraction/mirror examples replay with the correct sampled scene content and PSNR is no longer dominated by fallback texture sampling.

### `mrt-replay-empty` — P3 deferred
The MRT runtime stub landed in Wave 2E (commit 43129c0):
- `_vendor-PrecompiledMaterial.js` attaches an inert `mrtNode` stub when `artifact.mrtOutputCount > 1`
- `apply-precompiled.js` forwards source `material.mrtNode` onto the wrapper
- `compileTSL.js` binds a 1×1 N-texture warm-up RT before `compileAsync`

But the four MRT examples are still broken at replay:
- `webgpu_mrt` (PSNR 2.88 dB) — PassNode-based MRT, replay mostly empty
- `webgpu_mrt_mask` (PSNR 1.22 dB) — capture still throws (`mat.mrtNode = mrt({mask:...})` count=1, post-process pipeline doesn't get MRT context)
- `webgpu_multiple_rendertargets` (PSNR 1.24 dB) — torus material has 2-`@location` fragment but PostProcessing material gets MRT propagation incorrectly
- `webgpu_multiple_rendertargets_readback` (PSNR 1.34 dB) — user calls `setRenderTarget` inside `render()`, after precompile() runs

Wave 2E agent's report identifies the precise gaps. Implementation pending.

- **Files**: `packages/runtime/src/precompile-marker.js` (per-material RT binding tracking via `setRenderTarget` hook), `packages/runtime/src/aux-marker.js`, `packages/runtime/src/hydrator.js` (PassNode `getTexture` routing to live RT attachments).
- **Done when**: `webgpu_multiple_rendertargets.html.replay.png` shows side-by-side color | normal output. All four MRT examples ≥70% replay PNG.

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
The Wave 1 commit 751eaad made `ShadowBaseNode` an inert stub so `webgpu_shadowmap_array` and `_csm` LOAD without throwing. But they don't actually render shadows (same root cause as `shadows-no-render`). Once that lands, this is automatically lifted.

### `tsl-stub-coverage-gaps` — P3
Various TSL function stubs in [packages/runtime/src/slim-stubs.js](packages/runtime/src/slim-stubs.js) (added in `mrt-tsl-stub-leak` Round 3) cover ~80 exports but a long tail remains. Track via "[tsl-precompile/slim] X is not available" thrown errors during the 198-example load smoke.

---

## Coordination matrix (parallel-agent friendliness)

When two tasks share a file, run them **sequentially**, not in parallel.

| File | Tasks |
|---|---|
| `packages/examples/batch/run-e2e.mjs` | shadows-no-render, postprocess-bloom-texture-handoff, pmrem-cubemap-bg, compute-instance-mesh-buffer, compute-storage-texture-sync, psnr-animation-phase-drift |
| `packages/runtime/src/hydrator.js` | shadows-no-render, transmission-viewport-texture, mrt-replay-empty |
| `packages/runtime/src/aux-marker.js` | shadows-no-render, postprocess-bloom-texture-handoff, mrt-replay-empty |
| `packages/runtime/src/slim-entry.js` | postprocess-bloom-texture-handoff |
| `packages/runtime/src/graph-hash.js` | postprocess-bloom-texture-handoff |
| `packages/runtime/src/aux-loader.js` | shadows-no-render |
| `packages/runtime/src/apply-precompiled.js` | transmission-viewport-texture |
| `packages/runtime/src/precompile-marker.js` | mrt-replay-empty |
| `packages/plugin/src/vendor/extractUniformPlan.js` | displacementmap-blank-replay, transmission-viewport-texture |

`run-e2e.mjs` is the biggest hotspot — multiple compute and PMREM tasks contend for it. Consider opening a `wave3-base` branch off main, then having each agent rebase their worktree onto it before starting work, so their work-in-progress diffs sit on top of the same recent base.

---

## Current serial order

Recommended order for serial work (each ~30-60 min focused):

1. `postprocess-bloom-texture-handoff` — current paused thread; portal proved pass-node rendering can be made exact, bloom still needs texture handoff/composite wiring.
2. `shadows-no-render` — first beta blocker; make shadow replay/depth binding reliable.
3. `pmrem-cubemap-bg` — focused glTF/PMREM cubemap bucket is green, but broader PMREM/reflection examples need a re-grade.
4. `transmission-viewport-texture` — glass, refraction, and mirrors.
5. `displacementmap-blank-replay` — still a PBR material-map gap.
6. `compute-instance-mesh-buffer` / `compute-storage-texture-sync` — experimental compute/storage slice.
7. `mrt-replay-empty` — deferred with broad postprocessing until render-target / PassNode routing is mature.

For parallel agent work: file-disjoint sets are tricky because run-e2e.mjs is contended. Agent assignments need careful section-scoping or merge coordination.

## Round 4 launch protocol

To avoid the Wave 3 stale-base bug:

1. Create a fresh branch off current main: `git checkout -b wave3-base main && git checkout main`
2. Each agent gets prompt that starts with: "First: `git fetch origin && git merge origin/main` in your worktree."
3. Each agent commits ONLY to its worktree branch.
4. Verify the worktree's HEAD matches `git log -1 main` before believing the agent's claims.
5. Cherry-pick agent commits to main one at a time, resolving conflicts.
