# Status — vite-plugin-tsl-precompile

Current audit of what works, what's blocked, and what remains before this plugin is truly usable by three.js developers. Companion to [ROADMAP.md](./ROADMAP.md), [ARCHITECTURE.md](./ARCHITECTURE.md), and [CONTRIBUTING.md](./CONTRIBUTING.md).

Last updated: 2026-05-05

---

## Focused visual queue (2026-05-05)

This was a focused cleanup pass, not a refreshed full 194-example coverage sweep. The aggregate coverage table below still comes from the last broad summary; the focused reports listed here supersede those individual examples only.

**Green in focused runs:**
- `webgpu_loader_gltf.html` — PMREM environment/reflection/background replay now matches capture at PSNR `inf` in `visual-loader-gltf-after-pmrem-flipy.json`.
- `webgpu_loader_gltf_sheen.html` — sheen environment lighting is no longer Y-inverted; PSNR `inf` in `visual-loader-gltf-sheen-after-pmrem-flipy.json`.
- `webgpu_pmrem_cubemap.html` — cubemap PMREM source mapping is normalized before generation; PSNR `inf` in `visual-pmrem-cubemap-after-cube-mapping-normalize.json`.
- `webgpu_portal.html` — pass-scene and main-scene backgrounds are separated by exact aux/background matching; PSNR `inf` in `visual-portal-after-bg-exact.json`.

**Improved but not fully green:**
- `webgpu_lights_spotlight.html` — projected texture/color restored, no replay errors/warnings, PSNR `29.71` in `visual-lights-spotlight-targeted-shadow-fallback.json`. Still just below the 30 dB gate.
- `webgpu_lights_physical.html` — live object matrix updates improved the image, PSNR `25.65` in `visual-lights-physical-after-matrix.json`.
- `webgpu_instancing_morph.html` — instance color path improved, but replay remains visually mismatched; latest focused report PSNR `15.65` in `visual-instancing-morph-after-random-split.json`.

**Paused active thread:**
- Bloom/postprocessing is not fixed yet. The replay now runs a real addon `BloomNode` path without WebGPU/runtime errors, but the bloom contribution is still too dim or black in the final composite. Latest useful report: `visual-bloom-diagnostic-15.json`, PSNR `15.44` for `webgpu_postprocessing_bloom.html` with replay brightness `0.1186` vs capture `0.7503`.

**Implementation highlights:**
- PMREM generation chooses equirect/cube mode from source image shape rather than trusting rewritten `texture.mapping`, uses cloned source textures for temporary mapping changes, and preserves loader `flipY`.
- Equirectangular HDR backgrounds captured as `texture_cube` background artifacts are converted to live `CubeTexture`s through the shared full WebGPU renderer, then shared back into slim.
- Portal replay captures/uses exact per-scene background aux config hashes so a portal-scene background cannot leak into the main scene.

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

An example **works** when the slim-runtime replay screenshot matches a clean stock three.js reference within PSNR ≥ 30 dB (the gate from [run-e2e.mjs](packages/examples/batch/run-e2e.mjs#L93)). Smoke-test pass counts only prove the example loads — they say nothing about whether the rendered pixels are correct.

**30 / 194 graded examples matched in the last broad summary (15%).** The full per-example table lives at [packages/examples/batch/results/coverage-summary.md](packages/examples/batch/results/coverage-summary.md) — refresh from saved shots with `pnpm coverage`, refresh the site data too with `pnpm coverage:site`, or re-capture fresh shots first with `pnpm coverage:retest` / `pnpm test:e2e` (slow). Focused 2026-05-05 fixes above are not yet rolled into this aggregate.

| Category | Match / Total | Best example | Worst example |
|---|---|---|---|
| Materials | **5 / 17** | webgpu_materials_envmaps (inf dB) ✅ | webgpu_materials_texture_html (5.37 dB) |
| Lights | 3 / 11 | webgpu_lights_tiled (inf dB) ✅ | webgpu_lights_projector (11.51 dB) |
| Shadows | 1 / 8 | webgpu_shadowmap_opacity (inf dB) ✅ | webgpu_shadowmap, webgpu_shadowmap_pointlight (no replay) |
| Sprites | 0 / 1 | — | webgpu_sprites (13.37 dB) |
| Compute | 1 / 15 | webgpu_compute_reduce (34.13 dB) ✅ | webgpu_compute_texture_3d (6.22 dB) |
| Camera | 0 / 3 | webgpu_camera_logarithmicdepthbuffer (20.50 dB) | webgpu_camera_array (12.66 dB) |
| MRT / RenderTargets | 0 / 4 | webgpu_mrt_mask (12.85 dB) | webgpu_multiple_rendertargets_readback (1.26 dB) |
| Particles | 1 / 1 | webgpu_particles (36.74 dB) ✅ | — |
| Postprocessing | 3 / 28 | webgpu_postprocessing_bloom (inf dB) ✅ | webgpu_postprocessing_ao (7.70 dB) |

Note: this table is a historical broad summary and has stale individual rows. In particular, the latest focused bloom diagnostics are below the PSNR gate; use the 2026-05-05 focused reports above for bloom status until the full coverage summary is regenerated.

The full webgpu_* example set is now substantially graded, but the headline is still load-smoke-heavy rather than production-ready: 164 graded examples are visual regressions.

## v0.1 beta support slice

Do not optimize for "all 194 examples" first. The credible beta surface for real users is ordinary PBR application rendering:

- `MeshStandardNodeMaterial` / `MeshPhysicalNodeMaterial`
- material texture maps and env maps / PMREM
- direct lights and shadows
- material uniforms and known live light/shadow uniforms
- stable artifact invalidation across dev capture, build rewrite, runtime hash checks, and package contents

Priority order: fix shadows first, then PMREM/environment/reflections, then transmission/viewport/reflector texture paths. Compute/storage follows as experimental WebGPU coverage. MRT and broad postprocessing stay deferred until the render-target / PassNode chain is truly wired.

---

## Recent fixes (2026-05-04)

**E2E output is now quieter and more actionable.** `run-e2e.mjs` prints concise per-example progress with artifacts, capture/replay brightness, PSNR, and the first failure reason. `run-e2e-parallel.mjs` filters worker boilerplate and page warnings by default, then prints an aggregated failure table from the merged JSON report. Pass `--verbose` (or `TSLP_E2E_VERBOSE=1`) to forward page warnings/logs while debugging harness internals.

**The visual gate is real.** The E2E harness computes PSNR between a clean stock three.js reference and slim replay screenshots, fails below 30 dB by default, and keeps `--no-pixel-gate` for diagnostics. Focused `webgpu_clearcoat.html` is back above the gate after the DFG LUT source-module fix; broader coverage should be refreshed from the current E2E sweep before quoting new pass counts.

**CI/release cleanup moved forward.** The drift gate accepts `reflector.texture` as a hydrator-resolved texture binding, unconditional `[tslp-debug]` / `[tslp-probe]` / `[tslp_reflector]` logging is gone from source, package peer ranges and READMEs agree on `three >= 0.184.0`, and the site gallery generator has a `data` script plus `sharp` dependency.

**Shadow depth rebinding is safer.** Non-VSM shadow bindings now require a real `shadow.map.depthTexture` (or an actual depth texture) instead of falling back to `shadow.map.texture`, avoiding BGRA color targets in `texture_depth_2d` shader slots.

## Previous fix (2026-05-02)

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
[LOGS.md](./LOGS.md) for investigation history and [BACKLOG.md](./BACKLOG.md)
for the current triage plan.

---

## Phase completion

| Phase | Description | Status | Gate |
|---|---|---|---|
| 1 — Node harness | compileTSL + extractUniformPlan in Node + mock WebGPU | ✅ Done | Artifact byte-matches browser baseline |
| 2 — `.precompile(name)` + dev capture | Marker, dev server, HMR | ✅ Done | Unsupported kinds throw at call site |
| 3 — AOT codegen | `emit-updater.js` covers camera/object/material/time/uniform/scene | ✅ Done (core kinds) | Per-kind fixture pass |
| 4 — Build-time rewrite | Babel transform + virtual modules + `__applyPrecompiled` | ✅ Done | 3-layer hash check fires on corrupt artifact |
| 5 — Coverage matrix | Fixture infrastructure + 150 plugin tests pass across material classes, binding kinds, drift checks, and depth/artifact texture paths | ✅ Core done | 100% cells covered or documented-blocked |
| 6 — 206-example batch harness | Extractor/codegen batch over three.js webgpu_*.html examples (load-smoke only — does not check pixel correctness; see [Feature coverage](#feature-coverage-capture-vs-replay)) | ✅ Load-smoke green | Keep above launch threshold |
| 7 — Slim runtime bundle | Slim load-smoke over webgpu examples | ✅ No unexpected load-smoke errors | ≤ 300 KB gzip + 0 unexpected errors |
| 8 — Launch | Docs, demos, site, migration guide | 🔶 Infrastructure ready | One external adopter |

---

## Test suite summary (as of last run)

```
packages/plugin        150 / 150 pass   (unit + coverage matrix)
packages/runtime        55 /  55 pass   (hydrator, registry, smoke)
packages/inspector-panel 7 /   7 pass
---
Total                  212 / 212 pass   0 fail
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
- Slim runtime (`build/three.webgpu.slim.js`) strips the node builder; the webgpu example load-smoke currently completes without unexpected errors.
- Five-layer staleness gate: content hash, dev hot re-extract, build-time mismatch error, runtime assertion, `pnpm verify` CI check.
- Inspector panel integration: `attachToInspector(renderer.inspector)` shows captured artifact list, WGSL sizes, and unsupported-kind warnings.
- Aux-pass capture: `precompileAuxiliary(renderer, scene, camera, opts)` captures shadow-depth, render-pipeline, and output-transform passes so the slim runtime has precompiled versions of those internal materials too.
- Auto-mark mode (`autoMark: true` in plugin config): injects `.precompile()` on every material in the scene automatically (used by the batch harness; opt-in for users).
- IBL DFG LUT: precomputed 16×16 RG16F `DataTexture` in `packages/runtime/src/dfg-lut.js` resolves `builtin.dfgLUT` bindings without needing a renderer; cached and shared across all precompiled materials. The LUT is created from `three/src/**` modules so it matches the slim renderer's `DataTexture` class identity.
- Artifact-level texture resolution: `__applyPrecompiled` catalogues source-material textures by uuid into `_textureRefs` (in-process) or scans `material[map|normalMap|...]` by uuid (JSON-loaded artifacts). PBR materials with `map`/`normalMap`/`roughnessMap`/`envMap` now hydrate end-to-end.

---

## Non-UBO binding kinds and deferred kinds (Phase 5.5)

These kinds are recognised by the extractor/codegen contract but are not ordinary UBO-slot writes. Texture-binding kinds appear in `group.textures[]` and are resolved by the hydrator/rebinder path; truly unsupported contexts still surface loudly instead of silently producing wrong output.

| Kind | Reason | Affects |
|---|---|---|
| `unsupported` | Extractor flagged the binding as unsupported (no texture source identified); hydrator substitutes a fallback texture and reports the unsupported source | Exotic or custom texture nodes |
| `storage.buffer` | Storage-buffer AOT/update model remains deferred; in-process compute/storage paths exist, but broad AOT compute coverage is not production-ready | AOT compute materials |
| `depth.texture` | Hydrator starts on `fallbackDepthTexture`, then rebinds per frame to the live shadow map depth texture when available | Shadow-receiving materials |
| `viewport.texture` | Hydrator uses a live `ViewportTextureNode` path and rebinds the framebuffer/mip texture per render | Transmission and viewport-dependent materials |
| `reflector.texture` | Hydrator rebinds the live `ReflectorBaseNode` render target texture per render | Mirror/reflector materials |
| `scene.overrideMaterial` | Scene-override context is out of scope for v1 | Any material injected via `scene.overrideMaterial` |
| `uniform.live` (unnamed/custom) | Known light/shadow live sources have coverage, but custom `onRenderUpdate`-driven uniforms can still freeze if the extractor cannot map them to a stable source property | Custom live uniforms |

**Impact today:** PBR materials (`MeshStandardNodeMaterial`, `MeshPhysicalNodeMaterial`) with assigned textures and IBL `envMap` now hydrate end-to-end — `artifact.texture` and `builtin.dfgLUT` resolve via the runtime hydrator. `webgpu_clearcoat.html` is back above the E2E PSNR gate in the focused run. Shadow, viewport/transmission, and reflector texture bindings have runtime rebinder paths but still need visual hardening across the example set. AOT compute/storage paths remain the major binding-family gap.

---

## What's left to do (ordered by user impact)

### 1. Shadows  *(first visual correctness cluster)*

The loader/smoke story is good, but the PSNR report is still only **30 / 194**. Runtime rebinder paths now exist for `depth.texture`, `viewport.texture`, and `reflector.texture`; the remaining work is making them visually match live three.js across common examples:

- [ ] Fix no-replay cases: `webgpu_shadowmap.html` and `webgpu_shadowmap_pointlight.html`.
- [ ] Gate the replay shadow-scene/depth-texture path so it only runs for actual shadow receivers/casters and does not clobber non-shadow scenes.
- [ ] Raise the shadow cluster above the PSNR gate, starting with `webgpu_shadow_contact.html`, `webgpu_shadowmap_vsm.html`, and `webgpu_shadowmap_progressive.html`.

### 2. Bloom / postprocessing pass textures  *(current paused thread)*

The portal `pass(scene, camera)` path is now healthy for the focused portal example, but bloom still proves the render-target texture handoff is incomplete.

- [ ] Continue from `visual-bloom-diagnostic-15.json`: identify whether the black/dim bloom data is the source pass output, high-pass output, blur chain, composite output, or final artifact rebinding.
- [ ] Raise `webgpu_postprocessing_bloom.html`, `webgpu_postprocessing_bloom_emissive.html`, and `webgpu_postprocessing_bloom_selective.html` above the PSNR gate.
- [ ] Revisit `webgpu_postprocessing.html` missing dots after bloom, since it likely shares PassNode/render-target plumbing.

### 3. PMREM / environment / reflections  *(PBR correctness)*

Many real PBR scenes depend on environment lighting. Wrong PMREM/reflection wiring is dangerous because output can look plausible while still being invalid.

- [x] Focused glTF/PMREM bucket is green for `webgpu_loader_gltf.html`, `webgpu_loader_gltf_sheen.html`, and `webgpu_pmrem_cubemap.html`.
- [ ] Re-run the broader PMREM set: `webgpu_pmrem_equirectangular.html`, `webgpu_pmrem_scene.html`, `webgpu_pmrem_test.html`, plus PMREM-heavy compute/background examples.
- [ ] Improve reflection examples: `webgpu_reflection.html`, `webgpu_reflection_roughness.html`, and `webgpu_reflection_blurred.html`.
- [ ] Keep `MeshStandardNodeMaterial` / `MeshPhysicalNodeMaterial` texture-map coverage green while PMREM changes land.

### 4. Transmission / viewport / reflector texture path

`viewport.texture` and `reflector.texture` rebinder paths exist, but the common glass/mirror examples are still below the production bar.

- [ ] Fix `webgpu_materials_transmission.html` and `webgpu_loader_gltf_transmission.html`.
- [ ] Fix `webgpu_refraction.html` and `webgpu_mirror.html`.
- [ ] Add focused fixture coverage for `viewport.texture` and `reflector.texture` once the runtime behavior is stable.

### 5. Compute/storage paths  *(experimental for v0.1 beta)*

In-process compute and some storage-texture paths work, but the AOT compute/storage story is still incomplete.

- [ ] Add extractor/codegen coverage for storage buffers and the per-frame storage update model.
- [ ] Keep `webgpu_compute_reduce.html` green while improving the rest of the compute set; it is currently the only compute PSNR pass.
- [ ] Treat compute birds, storage buffers, and storage textures as experimental release notes unless the release goal changes toward creative-coding demos.

### 6. `uniform.live` and custom update callbacks

Known light/shadow live sources now have coverage (`light.shadow*`, `light.colorScaled`, PointsNodeMaterial scale), but arbitrary unnamed `UniformNode` / `onRenderUpdate`-driven uniforms can still freeze if the extractor cannot map them to a stable source property.

- [ ] Extend `packages/plugin/src/vendor/extractUniformPlan.js` for more known live-node names and property paths.
- [ ] For callbacks that cannot be statically resolved, document the limitation explicitly rather than silently freezing.

### 7. Operationalize the PSNR E2E gate

`run-e2e.mjs` now hard-fails visual mismatch by default. The next step is deciding how CI should consume it without making every PR run the full slow sweep.

- [ ] Define a small tier-1 PSNR subset for PR CI and keep the full 194-example grading as a slower scheduled/manual gate.
- [ ] Keep `--no-pixel-gate` for diagnostic load/runtime debugging, but do not treat it as a release gate.
- [ ] Triage real visual regressions from the current broad E2E sweep into [BACKLOG.md](BACKLOG.md) instead of treating low PSNR as harness noise by default.

### 8. Publish and external adoption  *(Phase 8 release gate)*

Both packages are at `0.1.0` with `engines.node`, `publishConfig`, `files`, and `repository.directory` already set. Remaining blockers:

- [ ] Run `pnpm publish --dry-run` for `vite-plugin-tsl-precompile` and `@tsl-precompile/runtime`; verify README files, runtime `build/`, and export paths are included.
- [ ] Confirm whether the unscoped plugin package needs any extra npm metadata beyond the current `files` list; the scoped runtime already has `publishConfig.access=public`.
- [ ] Tag and push `v0.1.0`. Update the install line in `README.md` (currently says "once published").

The ANNOUNCEMENT.md template is written; the ROADMAP Phase 8 gate requires "one external adopter reports success."

- [ ] Share the repo on three.js Discord + GitHub Discussions once npm packages are published.
- [ ] Keep a list of early adopter feedback in CONTRIBUTING.md or a separate ADOPTERS.md.

### Deferred for v0.1 messaging

- [ ] MRT / render-target examples remain experimental until the render-target / PassNode chain is wired end-to-end.
- [ ] Broad postprocessing remains experimental even though a few examples match; the full category is 3 / 28 today.

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

1. **Shadow visual correctness** — depth texture rebinding exists, but shadow examples still have the worst user-visible gaps: no replay in two cases and low PSNR in most others.
2. **Bloom/pass texture handoff** — portal is green, but bloom still shows that some pass/composite textures are not reaching the final precompiled postprocess artifact correctly.
3. **Broader PMREM/environment/reflection sweep** — the focused glTF/PMREM cubemap bucket is green; re-grade the broader PMREM/reflection set before calling PBR done.
4. **Transmission/viewport/reflector hardening** — the rebinder paths exist, but the visual examples are still below the production bar.
5. **Compute/storage coverage** — define the AOT storage-buffer update model and keep `webgpu_compute_reduce.html` passing while raising the rest of the compute set.
6. **Release dry-runs** — run npm dry-runs for plugin/runtime and verify package contents before tagging `v0.1.0`.
