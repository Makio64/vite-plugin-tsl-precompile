# Continuation Plan

This file used to hold long session-by-session handoff notes. It was reduced on 2026-05-04 because the same status had drifted across several Markdown files.

Canonical docs now are:

- Current status and support slice: [STATUS.md](STATUS.md)
- Open tasks and priority order: [BACKLOG.md](BACKLOG.md)
- Investigation and fix history: [LOGS.md](LOGS.md)
- Parallel-agent workflow: [MULTI_AGENT.md](MULTI_AGENT.md)
- User-facing usage: [README.md](README.md)

Current handoff (2026-05-11):

We stopped during the visual replay cleanup queue for Three.js WebGPU examples. The main work-in-progress source files are:

- [packages/examples/batch/run-e2e.mjs](packages/examples/batch/run-e2e.mjs) and [packages/examples/batch/run-e2e-parallel.mjs](packages/examples/batch/run-e2e-parallel.mjs) — replay harness patches for backgrounds, PMREM, pass nodes, portal, bloom fixes, local example roots, memory-bounded worker batching, full-renderer helpers, and focused diagnostics.
- [packages/runtime/src/hydrator.js](packages/runtime/src/hydrator.js) — live uniform/shadow/texture rebinding fixes.
- [packages/plugin/src/vendor/extractUniformPlan.js](packages/plugin/src/vendor/extractUniformPlan.js) — light uniform source extraction fixes.
- [packages/plugin/src/wgsl-optimize.js](packages/plugin/src/wgsl-optimize.js), [packages/plugin/src/index.js](packages/plugin/src/index.js), and [packages/plugin/src/emit-manifest.js](packages/plugin/src/emit-manifest.js) — WGSL minification/deduplication for emitted virtual modules.
- [packages/runtime/src/aux-marker.js](packages/runtime/src/aux-marker.js), [packages/runtime/src/graph-hash.js](packages/runtime/src/graph-hash.js), [packages/runtime/src/slim-entry.js](packages/runtime/src/slim-entry.js), and [packages/plugin/src/dev-capture-server.js](packages/plugin/src/dev-capture-server.js) — aux/background/pass capture and replay support added while fixing portal/bloom.
- [packages/runtime/build/three.webgpu.slim.js](packages/runtime/build/three.webgpu.slim.js) — rebuilt slim bundle; keep in sync with runtime source changes.
- [packages/examples/shadow-debug](packages/examples/shadow-debug) — small local shadow repro pages wired to the E2E harness.

What is done:

- Background replay fixes are in place for the earlier wrong-background cases, including preserving explicit null backgrounds instead of forcing captured background aux artifacts.
- Instance-uniform color replay was fixed for the instance-uniform path; `webgpu_instancing_morph.html` is improved but still visually mismatched.
- Physical-light replay improved after recomputing live object `modelViewMatrix` / `normalMatrix`; latest focused report was `visual-lights-physical-after-matrix.json` with PSNR `25.65`, no replay errors/warnings.
- `webgpu_lights_spotlight.html` is restored functionally with projected texture/color visible. Latest focused report: `visual-lights-spotlight-targeted-shadow-fallback.json`, PSNR `29.71`, no replay errors/warnings. It is visually close but still just below the default 30 dB gate.
- PMREM/environment/background bucket is green:
	- `webgpu_loader_gltf.html`: `visual-loader-gltf-after-pmrem-flipy.json`, PSNR `inf`, no errors/warnings.
	- `webgpu_loader_gltf_sheen.html`: `visual-loader-gltf-sheen-after-pmrem-flipy.json`, PSNR `inf`, no errors/warnings.
	- `webgpu_pmrem_cubemap.html`: `visual-pmrem-cubemap-after-cube-mapping-normalize.json`, PSNR `inf`, no errors/warnings.
- Portal clipping is green. `webgpu_portal.html` now captures separate background aux artifacts for the main scene/pass scene and replays at PSNR `inf` in `visual-portal-after-bg-exact.json`.
- Focused bloom is green. `webgpu_postprocessing_bloom.html`, `webgpu_postprocessing_bloom_emissive.html`, and `webgpu_postprocessing_bloom_selective.html` all pass with PSNR `inf` in `visual-bloom-cluster-after-fixes.json`.
- The parallel E2E harness now uses short-lived worker batches, one worker slot by default on ordinary machines, and single-example retries for crashed batches so long sweeps are less likely to exhaust Chromium/WebGPU memory.

Important implementation notes:

- PMREM generation now chooses equirect/cube mode from source image shape, not only `texture.mapping`. It uses cloned source textures so temporary mapping changes do not corrupt background conversion, and it preserves loader `flipY` so sheen/model reflections are not inverted.
- Equirectangular HDR backgrounds that replay through a captured `texture_cube` background artifact are converted to a live `CubeTexture` via the full WebGPU renderer, then shared back into slim.
- Cubemap PMREM sources whose mapping was rewritten to `CubeUVReflectionMapping` are normalized on a clone before PMREM generation.
- Spotlight replay uses the underlying shadowed light `baseColorNode` for intensity-scaled light color and disables replay shadow intensity only for projected spotlights whose generated full-renderer depth map is all-zero.
- Portal replay now needs exact per-scene background aux matching; shape-only background fallback can leak a pass-scene background into the main scene.

Where we stopped:

- Bloom is no longer the current unfinished item for the focused cluster. `visual-bloom-cluster-after-fixes.json` (2026-05-11) has `webgpu_postprocessing_bloom.html`, `webgpu_postprocessing_bloom_emissive.html`, and `webgpu_postprocessing_bloom_selective.html` all passing with PSNR `inf`.
- The key selective-bloom fix was to capture material artifacts against the pass/global MRT descriptor first, letting three.js merge each material-level `mrtNode` into the pass layout. Captured selective MeshBasic artifacts now emit both `output` and `bloomIntensity`.
- The replay gate now waits for deferred scene assets in loader examples, which fixed the emissive bloom timing case where replay froze after the HDR background but before the GLTF helmet arrived.

What remains next:

- Revisit `webgpu_postprocessing.html` missing dots and `webgpu_postprocessing_ao.html`, since broad postprocessing still has non-bloom gaps.
- Revisit `webgpu_instancing_morph.html` replay color/darkness and `webgpu_lights_physical.html` remaining PSNR gap after the PMREM and shadow fixes.
- Check `webgpu_materials_basic.html.capture` black sphere if still visible in the current screenshots.
- Clean or intentionally keep generated debug reports/screenshots under `packages/examples/batch/results/` before any commit. There are many untracked `visual-*` and `debug-*` JSON files from this session.
- Run formatting/lint/tests before commit. `node --check`, plugin tests, runtime tests, and the focused bloom E2E cluster passed on 2026-05-11; the user's terminal still shows an older `pnpm lint` exit code `254`, so do not assume lint is clean.

Useful focused commands:

```bash
pnpm --filter @tsl-precompile/runtime build:slim
pnpm --filter examples-batch run:e2e -- --filter=webgpu_postprocessing_bloom --save-shots --replay-wait-ms=12000 --capture-wait-ms=12000 --report=visual-bloom-cluster-after-fixes.json
```
