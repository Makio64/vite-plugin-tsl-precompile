# Continuation Plan

This file used to hold long session-by-session handoff notes. It was reduced on 2026-05-04 because the same status had drifted across several Markdown files.

Canonical docs now are:

- Current status and support slice: [STATUS.md](STATUS.md)
- Open tasks and priority order: [BACKLOG.md](BACKLOG.md)
- Investigation and fix history: [LOGS.md](LOGS.md)
- Parallel-agent workflow: [MULTI_AGENT.md](MULTI_AGENT.md)
- User-facing usage: [README.md](README.md)

Current handoff (2026-05-05):

We stopped during the visual replay cleanup queue for Three.js WebGPU examples. The main work-in-progress source files are:

- [packages/examples/batch/run-e2e.mjs](packages/examples/batch/run-e2e.mjs) — replay harness patches for backgrounds, PMREM, pass nodes, portal, bloom experiments, full-renderer helpers, and focused diagnostics.
- [packages/runtime/src/hydrator.js](packages/runtime/src/hydrator.js) — live uniform/shadow/texture rebinding fixes.
- [packages/plugin/src/vendor/extractUniformPlan.js](packages/plugin/src/vendor/extractUniformPlan.js) — light uniform source extraction fixes.
- [packages/runtime/src/aux-marker.js](packages/runtime/src/aux-marker.js), [packages/runtime/src/graph-hash.js](packages/runtime/src/graph-hash.js), [packages/runtime/src/slim-entry.js](packages/runtime/src/slim-entry.js), and [packages/plugin/src/dev-capture-server.js](packages/plugin/src/dev-capture-server.js) — aux/background/pass capture and replay support added while fixing portal/bloom.
- [packages/runtime/build/three.webgpu.slim.js](packages/runtime/build/three.webgpu.slim.js) — rebuilt slim bundle; keep in sync with runtime source changes.

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

Important implementation notes:

- PMREM generation now chooses equirect/cube mode from source image shape, not only `texture.mapping`. It uses cloned source textures so temporary mapping changes do not corrupt background conversion, and it preserves loader `flipY` so sheen/model reflections are not inverted.
- Equirectangular HDR backgrounds that replay through a captured `texture_cube` background artifact are converted to a live `CubeTexture` via the full WebGPU renderer, then shared back into slim.
- Cubemap PMREM sources whose mapping was rewritten to `CubeUVReflectionMapping` are normalized on a clone before PMREM generation.
- Spotlight replay uses the underlying shadowed light `baseColorNode` for intensity-scaled light color and disables replay shadow intensity only for projected spotlights whose generated full-renderer depth map is all-zero.
- Portal replay now needs exact per-scene background aux matching; shape-only background fallback can leak a pass-scene background into the main scene.

Where we stopped:

- Bloom is the current unfinished item. The experiments made the real addon `BloomNode` run in replay and removed WebGPU/runtime errors, but the bloom contribution is still too dim or effectively black in the final composite.
- Latest useful bloom diagnostics:
	- `visual-bloom-diagnostic-15.json`: `webgpu_postprocessing_bloom.html` functionally passes but PSNR is `15.44`; replay brightness `0.1186` vs capture `0.7503`. Bloom diagnostics showed `collected=1`, `prepared=1`, `fullRendered=15`, `highPass=15`, `blur=150`, `composite=15`, and no render failures.
	- `visual-bloom-after-internal-aux.json`: `webgpu_postprocessing_bloom.html` PSNR `15.44`, `webgpu_postprocessing_bloom_emissive.html` PSNR `20.84`, `webgpu_postprocessing_bloom_selective.html` PSNR about `13.36` and still fails the pixel gate.
	- `visual-bloom-texture-share.json` is an incomplete/failed diagnostic run and should not be treated as a success signal.
- Current suspicion: the full-renderer bloom pass can execute, but the final slim postprocess artifact is still not sampling the intended bloom composite texture (`UnrealBloomPass.h0`) or the source texture handed to the full renderer is still black/stale.

What remains next:

- Continue bloom from the texture handoff/composite wiring point. Verify which texture is black: source pass output, high-pass output, blur chain, composite output, or final artifact rebinding.
- Recheck `webgpu_postprocessing_bloom.html`, `webgpu_postprocessing_bloom_emissive.html`, and `webgpu_postprocessing_bloom_selective.html` after each bloom patch with focused reports and screenshots.
- Revisit `webgpu_postprocessing.html` missing dots after bloom, since it likely shares PassNode/render-target plumbing.
- Revisit `webgpu_instancing_morph.html` replay color/darkness and `webgpu_lights_physical.html` remaining PSNR gap after the PMREM and shadow fixes.
- Check `webgpu_materials_basic.html.capture` black sphere if still visible in the current screenshots.
- Clean or intentionally keep generated debug reports/screenshots under `packages/examples/batch/results/` before any commit. There are many untracked `visual-*` and `debug-*` JSON files from this session.
- Run formatting/lint/tests before commit. `node --check packages/examples/batch/run-e2e.mjs` passed during focused work; no final full lint/test pass was run after the bloom experiments. The user's terminal shows an older `pnpm lint` exit code `254`, so do not assume lint is clean.

Useful focused commands:

```bash
pnpm --filter @tsl-precompile/runtime build:slim
pnpm --filter examples-batch run:e2e -- --filter=webgpu_postprocessing_bloom.html --save-shots --no-pixel-gate --replay-wait-ms=12000 --capture-wait-ms=12000 --verbose --report=visual-bloom-next.json
pnpm --filter examples-batch run:e2e -- --filter=webgpu_postprocessing_bloom_emissive.html --save-shots --no-pixel-gate --replay-wait-ms=12000 --capture-wait-ms=12000 --verbose --report=visual-bloom-emissive-next.json
pnpm --filter examples-batch run:e2e -- --filter=webgpu_postprocessing_bloom_selective.html --save-shots --no-pixel-gate --replay-wait-ms=12000 --capture-wait-ms=12000 --verbose --report=visual-bloom-selective-next.json
```
