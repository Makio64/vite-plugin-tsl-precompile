# Continuation Plan

This file used to hold long session-by-session handoff notes. It was reduced on 2026-05-04 because the same status had drifted across several Markdown files.

Canonical docs now are:

- Current status and support slice: [STATUS.md](STATUS.md)
- Open tasks and priority order: [BACKLOG.md](BACKLOG.md)
- Investigation and fix history: [LOGS.md](LOGS.md)
- Parallel-agent workflow: [MULTI_AGENT.md](MULTI_AGENT.md)
- AI contributor operating guide: [AGENTS.md](AGENTS.md)
- User-facing usage: [README.md](README.md)

Current handoff (2026-05-13):

**Resolved (2026-05-13, follow-ups landed 2026-05-14):** `packages/examples/ocean` now renders + animates end-to-end through `vite build && vite preview`, the production-preview pipeline is adopter-friendly (no `import.meta.env.DEV` boilerplate around `precompileAuxiliary`), build warnings discriminate between static and live frozen slots, slim mode survives addon-shader-graph chains, and a PR-blocking Playwright smoke locks in the regression. Filed and closed as `ocean-preview-pipeline` in [BACKLOG.md](BACKLOG.md); structural notes in [ARCHITECTURE_EVOLUTION.md §P1.8](ARCHITECTURE_EVOLUTION.md). Three wedges landed:

1. **`precompileAuxiliary()` dev-gated in user code** — [packages/examples/ocean/main.js:188](packages/examples/ocean/main.js#L188) wraps the call in `if ( import.meta.env.DEV )`. Stops the runtime from POSTing to the dev capture endpoint (404 in preview) and from lazy-loading `compileTSL.js` via `/* @vite-ignore */` (bare specifier unresolvable in production).
2. **Aux-artifact registry now injected in every production build, not just slim** — [packages/plugin/src/index.js:377-385](packages/plugin/src/index.js#L377-L385) used to read `if ( opts.slim ) { injectSlimAuxImport(...) }`; the gate is removed. Captured `aux-background-*.json`, `aux-render-output-*.json`, `aux-lights-*.json` files on disk are now bundled into the artifact registry regardless of slim mode.
3. **Inspector + `@tsl-precompile/inspector-panel` dynamically imported only in dev** — [packages/examples/ocean/main.js:22-29, 47-52, 161-180](packages/examples/ocean/main.js#L22-L29). Inspector's `extensions.json` fetch hits Vite preview's SPA fallback and throws; without this guard it also blocks render init in preview, not just throws cosmetically.

Doc note: the original P1.8 framing (`uniform-live-tsl-globals` / TSL-global resolution) was a misread of a build warning. The 5 frozen `uniform.live` slots in ocean-water are 4 static identity texture-sampler matrices + 1 viewport vec2 — none of them animate, none of them blocked anything. The "not-yet-animated kind(s)" warning copy should be made more discriminating in a follow-up.

Older handoff (2026-05-12):

We stopped during the visual replay cleanup queue for Three.js WebGPU examples. The main work-in-progress source files are:

- [packages/examples/batch/run-e2e.mjs](packages/examples/batch/run-e2e.mjs) and [packages/examples/batch/run-e2e-parallel.mjs](packages/examples/batch/run-e2e-parallel.mjs) — replay harness patches for backgrounds, PMREM, pass nodes, portal, bloom fixes, local example roots, memory-bounded worker batching, full-renderer helpers, and focused diagnostics.
- [packages/examples/batch/psnr.mjs](packages/examples/batch/psnr.mjs) and [packages/examples/batch/coverage-config.json](packages/examples/batch/coverage-config.json) — shared Node-side PSNR comparator plus data-driven pixel-gate exclusions, ignore regions, and the CI-backed `tier1` subset.
- [packages/contract](packages/contract) — shared graph-normalization, texture-property, kind-registry, and artifact-validation contract used by plugin, runtime, and the E2E harness.
- [packages/runtime/src/slim-support/live-scene-index.js](packages/runtime/src/slim-support/live-scene-index.js) — first productized slim-support helper extracted from the harness for live texture indexing and null-image healing.
- [packages/runtime/src/hydrator.js](packages/runtime/src/hydrator.js) — live uniform/shadow/texture rebinding fixes.
- [packages/plugin/src/vendor/extractUniformPlan.js](packages/plugin/src/vendor/extractUniformPlan.js) — light uniform source extraction fixes.
- [packages/plugin/src/wgsl-optimize.js](packages/plugin/src/wgsl-optimize.js), [packages/plugin/src/index.js](packages/plugin/src/index.js), and [packages/plugin/src/emit-manifest.js](packages/plugin/src/emit-manifest.js) — WGSL minification/deduplication for emitted virtual modules.
- [packages/runtime/src/aux-marker.js](packages/runtime/src/aux-marker.js), [packages/runtime/src/graph-hash.js](packages/runtime/src/graph-hash.js), [packages/runtime/src/slim-entry.js](packages/runtime/src/slim-entry.js), and [packages/plugin/src/dev-capture-server.js](packages/plugin/src/dev-capture-server.js) — aux/background/pass capture and replay support added while fixing portal/bloom.
- [packages/runtime/build/three.webgpu.slim.js](packages/runtime/build/three.webgpu.slim.js) — rebuilt slim bundle; keep in sync with runtime source changes.
- [packages/examples/shadow-debug](packages/examples/shadow-debug) — small local shadow repro pages wired to the E2E harness.

What is done:

- The generated broad visual summary was refreshed: `packages/examples/batch/results/coverage-summary.md` now reports 153 / 225 examples at the 30 dB gate, with 72 visual regressions remaining.
- Architecture-evolution first wedges are implemented: shared contract package, shared graph normalizer, shared texture-property lists, shared `KINDS` registry and artifact validator, data-driven coverage config, tier-1 visual CI gate, updater parse guard, strict Three.js rewrite warning mode, nightly/manual `three@latest` compat probe, and the first runtime `slim-support` module.
- Background replay fixes are in place for the earlier wrong-background cases, including preserving explicit null backgrounds instead of forcing captured background aux artifacts.
- Instance-uniform color replay was fixed for the instance-uniform path; `webgpu_instancing_morph.html` is improved but still visually mismatched.
- Physical-light and spotlight replay are now green in the refreshed generated broad summary.
- The focused shadow sweep was green in `packages/examples/batch/results/e2e-report.json`, but the regenerated broad summary reports shadows at 7 / 8. `webgpu_shadowmap_array.html` is now consistent at 34.20 dB through the shared PSNR ignore region; `webgpu_shadowmap_opacity.html` is the active broad-shadow regression at 10.80 dB.
- `webgpu_materials_texture_manualmipmap.html` refreshed to PSNR `inf` in `next-pbr-manualmipmap.json`, and `webgpu_loader_gltf_iridescence.html` refreshed to 37.95 dB in `next-pbr-iridescence.json`.
- PMREM/environment/background bucket is green:
	- `webgpu_loader_gltf.html`: `visual-loader-gltf-after-pmrem-flipy.json`, PSNR `inf`, no errors/warnings.
	- `webgpu_loader_gltf_sheen.html`: `visual-loader-gltf-sheen-after-pmrem-flipy.json`, PSNR `inf`, no errors/warnings.
	- `webgpu_pmrem_cubemap.html`: `visual-pmrem-cubemap-after-cube-mapping-normalize.json`, PSNR `inf`, no errors/warnings.
- Portal clipping is green. `webgpu_portal.html` now captures separate background aux artifacts for the main scene/pass scene and replays at PSNR `inf` in `visual-portal-after-bg-exact.json`.
- Focused bloom is green. `webgpu_postprocessing_bloom.html`, `webgpu_postprocessing_bloom_emissive.html`, and `webgpu_postprocessing_bloom_selective.html` all pass with PSNR `inf` in `visual-bloom-cluster-after-fixes.json`.
- `webgpu_materials_toon.html` is green. The E2E harness now captures the dynamic `Toon_Outline` material from `renderer.renderObject()` and swaps the replay outline material to the captured `NodeMaterial` artifact; `next-toon-outline-pass.json` reports PSNR `inf`.
- Standalone render-target / QuadMesh material replay is fixed for `webgpu_rtt.html`, `webgpu_depth_texture.html`, and `webgpu_multisampled_renderbuffers.html`; all three focused reports are PSNR `inf`.
- Fresh focused runs promoted `webgpu_tsl_vfx_tornado.html` and `webgpu_equirectangular.html` to PSNR `inf`.
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

- **Done 2026-05-14:** items 1 (runtime DEV detection in aux-marker.js), 3 (split warning copy in emit-updater.js + plugin/src/index.js), 4 (slim Node Proxy fallback in slim-stubs.js), and 5 (`packages/examples/preview-smoke/` + PR-blocking CI job) all landed and verified. See the resolved `ocean-preview-pipeline` entry in [BACKLOG.md](BACKLOG.md) for file-level details.
- **Continue the structural track from [ARCHITECTURE_EVOLUTION.md](ARCHITECTURE_EVOLUTION.md):** watch hosted CI stability for the `tier1` visual gate AND the new `preview-smoke-ocean` gate, split the hydrator texture resolver, formalize dynamic binding descriptors in the shared contract, and move PMREM support into `runtime/slim-support`.
- **Inspector preview gap also closed (2026-05-14):** new `attachInspectorExtensionsShim` middleware in [packages/plugin/src/index.js](packages/plugin/src/index.js) intercepts `/extensions/extensions.json` requests in both `vite` and `vite preview`, returning `[]` so Inspector loads cleanly without the 404 → SPA-fallback HTML → JSON.parse trap. Ocean's `import.meta.env.DEV` guards around Inspector are gone — zero adopter-facing boilerplate left. `ocean-preview-pipeline` is fully closed.
- First re-check `webgpu_shadowmap_opacity.html` against a fresh focused shadow run so the broad-shadow bucket and focused report agree again.
- Continue the structural track from [ARCHITECTURE_EVOLUTION.md](ARCHITECTURE_EVOLUTION.md): watch hosted CI stability for the new `tier1` visual gate, split the hydrator texture resolver, formalize dynamic binding descriptors in the shared contract, and move PMREM support into `runtime/slim-support`.
- Continue with beta-relevant near-threshold material/light examples: `webgpu_materials_transmission.html` (26.25 dB fresh) and `webgpu_lights_selective.html` (26.18 dB in the generated broad summary). Keep the now-green manual-mipmap, iridescence, and toon examples as guardrails.
- MRT/readback is the next render-target-specific blocker: `webgpu_mrt.html` is green at PSNR `inf`, but `webgpu_multiple_rendertargets.html` and `webgpu_multiple_rendertargets_readback.html` are both 11.79 dB in the broad summary. `webgpu_rendertarget_2d-array_3d.html` compares at 30.87 dB from saved shots but its focused report exits with `Invalid string length`, so the harness/reporting path needs cleanup.
- Revisit `webgpu_postprocessing_outline.html`, `webgpu_postprocessing_godrays.html`, `webgpu_postprocessing_ssr.html`, plus near-threshold `webgpu_postprocessing_dof_basic.html` and `webgpu_postprocessing_ssgi.html`; AO and masking are green in the current generated summary.
- Revisit `webgpu_instancing_morph.html` replay color/darkness.
- Check `webgpu_materials_basic.html.capture` black sphere if still visible in the current screenshots.
- Clean or intentionally keep generated debug reports/screenshots under `packages/examples/batch/results/` before any commit. There are many untracked `visual-*` and `debug-*` JSON files from this session.
- Run formatting/lint/tests before commit. `node --check` for the batch scripts and full `pnpm test` passed on 2026-05-12; the user's terminal still shows an older `pnpm lint` exit code `254`, so do not assume lint is clean.

Useful focused commands:

```bash
pnpm --filter @tsl-precompile/runtime build:slim
TSLP_FAIL_ON_REWRITE_WARNING=1 pnpm --filter @tsl-precompile/runtime build:slim
pnpm test:e2e:tier1
pnpm coverage
pnpm --filter @tsl-precompile/site data
pnpm --filter examples-batch run:e2e -- --filter=webgpu_postprocessing_bloom --save-shots --replay-wait-ms=12000 --capture-wait-ms=12000 --report=visual-bloom-cluster-after-fixes.json
```
