# Status — vite-plugin-tsl-precompile

Current audit of what works, what's blocked, and what remains before this plugin is truly usable by three.js developers. Companion to [ROADMAP.md](./ROADMAP.md), [ARCHITECTURE.md](./ARCHITECTURE.md), and [CONTRIBUTING.md](./CONTRIBUTING.md).

Last updated: 2026-05-03

---

## Round 4 results (2026-05-03)

Six parallel agents + several follow-up commits pushed visual correctness forward on multiple fronts. Headline: **27/29 tier-1 examples render without errors** (same count as before Round 4 but different mix), **199/199 unit tests pass**.

**Gained** (was broken/error → now renders):
- `webgpu_compute_birds`: capture-side throw fixed (`object.computeBoundingSphere` skip on throwaway mesh) → replay renders sky background. Birds themselves still missing (instance buffer not propagating).
- `webgpu_backdrop_water`: replay was empty → now produces non-empty frame.
- `webgpu_compute_particles_rain`: replayBright 0.029 → 0.358 (12× improvement, particles visible).
- `webgpu_shadow_contact`: was empty → renders geometry with hard shadows.
- `webgpu_shadowmap_vsm`: PSNR 25.24 dB with visible torus + columns + spotlight cone shadow on floor.
- `webgpu_compute_texture_3d`: cloud volumetric now visibly renders (via storage-texture cache invalidation; PSNR still low due to background sky color).

**Regressed** (Round 4 introduced trade-offs):
- `webgpu_compute_reduce`: 32.59 → 12.25 dB. **Lost the only PSNR-≥30 dB pass.**
- `webgpu_caustics`: 0.76 → 0.006 brightness, 15.27 → 8.75 dB.
- `webgpu_camera_array`: 1.0 → 0.013 brightness.
- `webgpu_clipping`: brightness 0.47 → 0.009.
- `webgpu_animation_retargeting_readyplayer`: new "binding dimension mismatch" error.
- `webgpu_compute_texture_3d`: flaky "Texture already initialized" exception on some runs.
- `webgpu_shadowmap_opacity`: 18.27 → 10.8 dB (capture-side WGSL gained shadow code; replay-side bind-group cache holds wrong sample type — `texture_depth_2d` declared, `BGRA8Unorm` bound).

**Net assessment**: Round 4 added real infrastructure — shadow-scene render pass, storage-texture rebinder, MRT isolation + serialization, texture identity cataloguing. Several examples that were "renders empty" now render correctly. But the new code paths run too eagerly on scenes that don't need them, clobbering state. **Round 5 should surgically gate**: Round 4-S's shadow-scene render on actual `castShadow` lights, Round 4-H's storage-texture rebinder on examples with storage textures, fix the `Texture already initialized` race.

**Round 4 commits on main (oldest → newest)**: e12b32e c78d51e 82588df 56f379f 27354bd 8e371f1 fc82f2d aa7abb4 43129c0 751eaad 29c92c4 c7b0d89 294f90f fbdaa81 8229d63 1b6873a 35e8971.

---

## Feature coverage (capture vs replay)

An example **works** when the slim-runtime replay screenshot matches live three.js within PSNR ≥ 30 dB (the gate from [run-e2e.mjs](packages/examples/batch/run-e2e.mjs#L93)). Smoke-test pass counts (197/198 etc) only prove the example loads — they say nothing about whether the rendered pixels are correct.

**1 / 36 graded examples currently match (3%).** The full per-example table lives at [packages/examples/batch/results/coverage-summary.md](packages/examples/batch/results/coverage-summary.md) — refresh with `pnpm coverage` (or `pnpm coverage:retest` to re-capture fresh shots first via the e2e harness, then re-summarize — slow).

| Category | Match / Total | Best example | Worst example |
|---|---|---|---|
| Materials | **1 / 6** | webgpu_materials_lightmap (35.77 dB) ✅ | webgpu_materials_displacementmap (10.06 dB) |
| Lights | 0 / 3 | webgpu_lights_rectarealight (24.39 dB) | webgpu_lightprobe_cubecamera (17.48 dB) |
| Shadows | 0 / 8 | webgpu_shadowmap_vsm (25.24 dB) | webgpu_shadowmap, webgpu_shadowmap_pointlight (no replay) |
| Sprites | 0 / 1 | — | webgpu_sprites (12.51 dB) |
| Compute | 0 / 10 | webgpu_compute_particles (21.85 dB) | webgpu_compute_particles_snow (0.75 dB) |
| Camera | 0 / 3 | webgpu_camera_array (20.66 dB) | webgpu_camera (14.39 dB) |
| MRT / RenderTargets | 0 / 4 | webgpu_mrt (2.88 dB) | webgpu_mrt_mask (1.22 dB) |
| Particles | 0 / 1 | — | webgpu_particles (16.37 dB) |

The full webgpu_* example set (~206 examples) is **not yet visually graded** — only 36 have paired capture/replay PNGs on disk. To grade more, run `pnpm --filter examples-batch run:e2e` over the unscored set (slow, headless Playwright). Fixing the regressions is tracked in [§What's left to do](#whats-left-to-do-ordered-by-user-impact) — particularly the `depth.texture` and `uniform.live` items, which likely account for most of the Shadows and Lights gap.

---

## Latest fix (2026-05-02)

**Slim runtime now actually renders pixels.** The hydrator's
`createStaticObserver()` was returning `needsRefresh: false` on every
call, so three.js's `Renderer.js` was skipping
`_nodes.updateForRender(renderObject)` and our hydrated `updateNodes`
(per-frame UBO writers for camera/object matrices, time, etc.) never
ran — UBOs stayed zero, every draw collapsed to the origin, and the
slim canvas stayed solid black across the whole example sweep. Fixed
in [packages/runtime/src/hydrator.js](packages/runtime/src/hydrator.js)
by returning `true` whenever `nodeFrame.renderId` changes (mirroring
stock `NodeMaterialObserver.needsRefresh`). After the fix, replay
brightness now matches capture brightness on most examples that were
previously dark — see
[CONTINUATION_PLAN.md](./CONTINUATION_PLAN.md#what-changed-in-the-last-session)
for the before/after table and triage plan for remaining failures.

---

## Phase completion

| Phase | Description | Status | Gate |
|---|---|---|---|
| 1 — Node harness | compileTSL + extractUniformPlan in Node + mock WebGPU | ✅ Done | Artifact byte-matches browser baseline |
| 2 — `.precompile(name)` + dev capture | Marker, dev server, HMR | ✅ Done | Unsupported kinds throw at call site |
| 3 — AOT codegen | `emit-updater.js` covers camera/object/material/time/uniform/scene | ✅ Done (core kinds) | Per-kind fixture pass |
| 4 — Build-time rewrite | Babel transform + virtual modules + `__applyPrecompiled` | ✅ Done | 3-layer hash check fires on corrupt artifact |
| 5 — Coverage matrix | Fixture infrastructure + 121 tests pass across all material classes | ✅ Core done | 100% cells covered or documented-blocked |
| 6 — 206-example batch harness | Extractor/codegen batch over three.js webgpu_*.html examples (load-smoke only — does not check pixel correctness; see [Feature coverage](#feature-coverage-capture-vs-replay)) | ✅ 197/198 | ≥ 120/199 (baseline: 68/199) |
| 7 — Slim runtime bundle | Load-smoke over 198 examples, 0 unexpected errors | ✅ 198/198 | ≤ 300 KB gzip + 0 unexpected errors |
| 8 — Launch | Docs, demos, site, migration guide | 🔶 Infrastructure ready | One external adopter |

---

## Test suite summary (as of last run)

```
packages/plugin        121 / 121 pass   (unit + coverage matrix)
packages/runtime         9 /   9 pass   (hydrator, registry, smoke)
packages/inspector-panel 7 /   7 pass
---
Total                  137 / 137 pass   0 fail
```

Batch harness (`packages/examples/batch/results/report.json`):
- **197 / 198 pass** — the 1 failure is `webgpu_postprocessing_3dlut.html` whose test environment can't reach a `.CUBE` LUT file (404 on asset, not a plugin bug).
- **8 skip** — examples that require non-WebGPU browser features outside the headless harness.

Slim bundle load-smoke (`packages/examples/batch/results/slim-report.json`):
- **198 / 198 pass**, 0 unexpected slim-bundle errors.

---

## What works today

- `material.precompile('name')` in dev mode fires the in-browser extractor, POSTs the artifact + hash to the dev server, writes `artifacts/<name>.<hash>.json`, and fires HMR. Runs fully in the browser — no Node involvement in dev flow.
- Build-mode Babel transform finds every `.precompile('name')` call, resolves the artifact by name from `artifacts/`, verifies hash, rewrites to `__applyPrecompiled(material, import('virtual:tsl-precompile/name'), hash)`.
- Virtual module resolver serves `artifact.json` + generated `updater.js` as a single bundled module.
- AOT updater emits direct `DataView` writes (no switch, no closures) for all camera, object, material, time, scene-fog, and scene-state uniforms. All 12 standard NodeMaterial classes extract + codegen without unknown kinds.
- `PrecompiledMaterial` wraps the artifact and redirects three.js's render pipeline to the baked WGSL + bind layout, bypassing the TSL node builder.
- Slim runtime (`build/three.webgpu.slim.js`) strips the node builder; 198/198 three.js examples load without unexpected errors.
- Five-layer staleness gate: content hash, dev hot re-extract, build-time mismatch error, runtime assertion, `pnpm verify` CI check.
- Inspector panel integration: `attachToInspector(renderer.inspector)` shows captured artifact list, WGSL sizes, and unsupported-kind warnings.
- Aux-pass capture: `precompileAuxiliary(renderer, scene, camera, opts)` captures shadow-depth, render-pipeline, and output-transform passes so the slim runtime has precompiled versions of those internal materials too.
- Auto-mark mode (`autoMark: true` in plugin config): injects `.precompile()` on every material in the scene automatically (used by the batch harness; opt-in for users).
- IBL DFG LUT: precomputed 16×16 RG16F `DataTexture` in `packages/runtime/src/dfg-lut.js` resolves `builtin.dfgLUT` bindings without needing a renderer; cached and shared across all precompiled materials.
- Artifact-level texture resolution: `__applyPrecompiled` catalogues source-material textures by uuid into `_textureRefs` (in-process) or scans `material[map|normalMap|...]` by uuid (JSON-loaded artifacts). PBR materials with `map`/`normalMap`/`roughnessMap`/`envMap` now hydrate end-to-end.

---

## Documented-blocked kinds (Phase 5.5)

These kinds are recognised but intentionally deferred. Generated updaters throw `severity: 'blocked'` errors — they don't silently produce wrong output.

| Kind | Reason | Affects |
|---|---|---|
| `unsupported` | Extractor flagged the binding as unsupported (no texture source identified) | Exotic or custom texture nodes |
| `storage.buffer` | Storage-buffer codegen deferred — hydrator can rehydrate them but `emit-updater.js` has no case to write storage bindings per frame | AOT compute materials (in-process compute still works) |
| `depth.texture` | Hydrator returns a 1×1 `fallbackDepthTexture`; nothing reads `frame.shadowMap` yet | Shadow-receiving materials |
| `scene.overrideMaterial` | Scene-override context is out of scope for v1 | Any material injected via `scene.overrideMaterial` |
| `uniform.live` (unnamed) | Extractor can recover a `property` for `MaterialReferenceNode` (animates live), but unnamed `UniformNode` instances freeze to a snapshot | Light intensity, `ShadowNode`, and custom `onRenderUpdate`-driven uniforms |

**Impact today:** PBR materials (`MeshStandardNodeMaterial`, `MeshPhysicalNodeMaterial`) with assigned textures and IBL `envMap` now hydrate end-to-end — `artifact.texture` and `builtin.dfgLUT` resolve via the runtime hydrator. Shadow-receiving materials still render with a 1×1 depth fallback (visually wrong, doesn't crash). AOT compute materials are blocked at codegen. Animated unnamed uniforms (e.g. light intensity changing over time) freeze to their captured snapshot value.

---

## What's left to do (ordered by user impact)

### 1. Publish to npm  *(prerequisite for any external adoption)*

Both packages are at `0.1.0` with `engines.node`, `publishConfig`, `files`, and `repository.directory` already set. Remaining blockers:

- [ ] **Subpackage README files.** Neither `packages/plugin/` nor `packages/runtime/` has its own `README.md`. npm renders the package's own README on the package page — without one, the published page is empty.
- [ ] **MIGRATION.md.** The root `STATUS.md` and the plugin reference a `MIGRATION.md` for the version-bump-invalidates-artifacts contract; the file does not exist. Either create it or remove the references.
- [ ] Run `pnpm publish --dry-run` on both packages and verify the published file set.
- [ ] Tag and push `v0.1.0`. Update the install line in `README.md` (currently says "once published").

### 2. Phase 5.5 — remaining binding kinds  *(unlocks shadow + compute)*

`builtin.dfgLUT` and `artifact.texture` are wired through the hydrator and have hydrator tests. The remaining gaps:

- [ ] **`depth.texture`**: hydrator currently returns the 1×1 `fallbackDepthTexture` for any `texture_depth_2d` binding. Wire the actual shadow-map `DepthTexture` from `frame.shadowMap` so shadow-receiving materials render correctly.
- [ ] **`storage.buffer`**: hydrator can rehydrate storage bindings (in-process compute works) but `emit-updater.js` has no case to emit per-frame storage writes. AOT compute is blocked until this lands.
- [ ] **Coverage-matrix fixtures for the shipped paths**: `builtin.dfgLUT` and `artifact.texture` have hydrator tests but no positive fixture in `packages/plugin/test/coverage/` that asserts the extractor + emit-updater contract. Add one per kind; add a fixture for `depth.texture` + `storage.buffer` once they land.

### 3. `uniform.live` for unnamed `UniformNode`  *(fixes light intensity + custom `onRenderUpdate`)*

`MaterialReferenceNode`-backed uniforms already animate live: the extractor emits `property` and the hydrator reads `material[property]` per frame. The remaining gap is unnamed `UniformNode` instances (light intensity, `ShadowNode`, `LightNode`, custom `onRenderUpdate`-driven uniforms) — they currently freeze to the snapshot taken at extraction time.

- [ ] Extend `packages/plugin/src/vendor/extractUniformPlan.js` to map known live-node names (light intensity, etc.) to their source property paths so the emit-updater can route them through the same live-property mechanism that already works for `MaterialReferenceNode`.
- [ ] For nodes whose `onRenderUpdate` callback can't be statically resolved, document the limitation explicitly rather than silently freezing.

### 4. Pixel-correct E2E gate  *(proves the output is actually right)*

`run-e2e.mjs` already captures screenshots for both the live and slim renders and computes a channel-mean `pixelMatchScore` against threshold `0.85` — but it **only emits a warning**, never fails on visual mismatch. The latest report shows `pixelMatchScore: 0.3258` with a warning, while the test was marked fail for unrelated replay errors.

- [ ] Replace the channel-mean check with a real per-pixel metric (PSNR, SSIM, or `pixelmatch`).
- [ ] Flip `pixelMatchWarning` from a warning into a hard test failure so a precompiled shader that renders the wrong image actually fails CI.
- [ ] Start with a generous PSNR threshold (≥ 30 dB) to avoid flakiness on minor rounding; tighten later.

### 5. External adoption  *(Phase 8 release gate)*

The ANNOUNCEMENT.md template is written; the ROADMAP Phase 8 gate requires "one external adopter reports success."

- [ ] Share the repo on three.js Discord + GitHub Discussions once npm packages are published.
- [ ] Keep a list of early adopter feedback in CONTRIBUTING.md or a separate ADOPTERS.md.

---

## Known issues

| Issue | Severity | Location | Notes |
|---|---|---|---|
| `switch` cases after `default:` in `emit-updater.js` | Minor style | `emit-updater.js` lines 413 (`emitSlot`) and 506 (`emitConstant`) | JS switch allows this; cases are still reachable. Not a bug, but confusing — move `default` to the end for clarity. |
| `frame.object.viewPosition` / `frame.object.direction` are Object3DNode-specific | Low | `emit-updater.js` | `viewPosition` and `direction` are not standard `Object3D` properties; they're set by three.js's renderer before dispatching. Verify the slim render loop populates `frame.object` before the updater runs. |
| Batch report `webgpu_postprocessing_3dlut.html` failure | Low | `packages/examples/batch/results/report.json` | 404 on `.CUBE` LUT file in the test environment; not a plugin defect. |

---

## How the pieces connect (quick reference)

```
User writes:            water.precompile('ocean-water')

Dev mode:               precompile-marker.js  →  in-browser extractor
                        →  POST /__tsl-precompile/capture
                        →  dev-capture-server.js writes artifacts/ocean-water.<hash>.json

Build mode:             babel-transform.js rewrites the call to:
                            __applyPrecompiled(water, __art_ocean_water, '<hash>')
                        with virtual module import resolved by index.js
                        →  emit-manifest.js serves artifact JSON
                        →  emit-updater.js generates static updater.js (UBO writes)

Runtime (prod):         __applyPrecompiled()
                        →  hash gate (throws if stale)
                        →  wraps material in PrecompiledMaterial
                        →  hydrator.js reconstructs NodeBuilderState from artifact
                        →  slim three.js binds WGSL + layout, calls updater per frame
```

---

## How to contribute to remaining work

See [CONTRIBUTING.md](./CONTRIBUTING.md) for setup and code style. The highest-leverage contributions are:

1. **Pixel-correct E2E gate** — flip the existing `pixelMatchWarning` into a hard failure and swap the channel-mean check for a real per-pixel metric (PSNR / SSIM / `pixelmatch`). The capture infrastructure is already there in `run-e2e.mjs`.
2. **`depth.texture` wiring** — the hydrator already creates the fallback; route `frame.shadowMap` into `resolveTextureBinding` for `texture_depth_2d` bindings. Unlocks shadow-receiving materials.
3. **`uniform.live` property map for unnamed nodes** — extend `extractUniformPlan.js` to emit `property` for known live nodes (light intensity, etc.) so they animate live like `MaterialReferenceNode` already does.
4. **Subpackage READMEs** — write `packages/plugin/README.md` and `packages/runtime/README.md` so npm pages aren't blank when we publish.
