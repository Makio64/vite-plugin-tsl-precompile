# Async-loaded cubemap background fix — webgpu_lightprobe — 2026-05-03

## Symptom

[webgpu_lightprobe.html.replay.png](./shots/webgpu_lightprobe.html.replay.png) rendered the two probe spheres correctly but the Pisa cubemap background was pure black; the [capture](./shots/webgpu_lightprobe.html.capture.png) shows the full skybox. PSNR before fix: **10.66 dB**.

## Root cause

The example creates the renderer + animation loop **before** the cube load completes ([webgpu_lightprobe.html line 66-69](file:///Users/davidronai/Desktop/git/three.js/examples/webgpu_lightprobe.html)). It only assigns `scene.background = cubeTexture` and adds the mesh from inside the async `CubeTextureLoader.load(...)` callback (line 111-138). So:

1. Frames N=1..M render with `scene.background === undefined` (still loading).
2. The slim harness sets `scene.backgroundNode = __nodeStub()` so Background.js still goes through `loadAux('background', …)`. A `PrecompiledMaterial` is built for the sky quad, hydrator runs, and the cube binding falls through to `fallbackCubeTexture` (1×1×6 grey) at [packages/runtime/src/hydrator.js:1438](../../runtime/src/hydrator.js#L1438). The sky quad's bind group is built and cached.
3. Cube load completes on a later frame → `scene.background = cubeTexture`. Each render the harness's `__wireBackgroundTextures` calls `Slim.attachArtifactTextureRefs(artifact, cubeTexture)` so `artifact._textureRefs` now points at the live cube.
4. **But** Background.js reuses the cached `sceneData.backgroundMesh.material`; its bind group still references the captured `fallbackCubeTexture`. Nothing forces re-hydration. The map gets the new pointer; the cached bind group never reads it again.
5. Result: sky quad keeps sampling the 1×1×6 fallback → near-black after toneMapping.

The PMREM-completion path at run-e2e.mjs already does the right invalidation (`_renderer._quadCache.clear()` + re-wire) but only when `__backgroundNeedsPMREM` is true. Lightprobe's mapping is `301` (CubeReflectionMapping, raw cube), so that path was skipped.

Confirmation by comparison: `webgpu_cubemap_dynamic` `await`s `loadAsync` **before** creating the renderer — its first render already sees the live cube — and that example's [replay](./shots/webgpu_cubemap_dynamic.html.replay.png) shows the Pisa background correctly. Same texture, same artifact shape, same hydrator path; only the load timing differs.

## Fix

`packages/examples/batch/run-e2e.mjs` — extend `__wireBackgroundTextures` to detect when the wired texture **changes** for a background artifact, and on change force re-hydration of the cached background material so the next render rebuilds its bind group against the freshly-loaded texture.

Mirrors the dispose + nodeBuilderCache.clear() pattern already used in `__wireEnvironmentPMREM` for environment PMREM completion. Adds:

- A module-scope `WeakMap` `__lastWiredBgTex` keyed on artifact, so steady-state renders are no-ops (we only invalidate when the source actually changes).
- On change: dispose `sceneData.backgroundMesh.material` (if Background.update has already created it), clear `renderer._nodes.nodeBuilderCache` (program cache), and clear `renderer._quadCache`. The next render creates a fresh `RenderObject` with `_nodeBuilderState = null`, triggering `hydrateNodeBuilderState` against the now-correct `_textureRefs`.

## Result

| Run | PSNR | Verdict |
| --- | --- | --- |
| `--filter=webgpu_lightprobe.html --replay-wait-ms=8000 --capture-wait-ms=10000` (post-fix) | **inf dB** | ✅ Pixel-perfect |
| `--filter=webgpu_cubemap_dynamic.html` (regression check) | passes (already correct pre-fix; WeakMap path is a no-op once first wire matches) | ✅ No regression |
| `--filter=webgpu_pmrem_cubemap.html` (regression check) | still failing pre-existing PMREM-2D issue (`replayBright=1` indicates background is now drawing; mismatch is the orthogonal "balls all white" Cluster A bug) | ⚠️ Pre-existing, unrelated |

Visual confirmation: [webgpu_lightprobe.html.replay.png](./shots/webgpu_lightprobe.html.replay.png) now shows the Pisa cubemap behind the two spheres, matching the capture.

## Why no production-runtime change

`packages/runtime/src/hydrator.js` and `packages/runtime/src/aux-loader.js` are untouched. The bug is e2e-harness-specific: production apps that own their texture-loading sequence call `registerLiveTexture` / `attachArtifactTextureRefs` themselves. The harness needs the dispose-and-flush dance because it generically replays examples that load textures asynchronously after first render — a pattern app authors usually avoid.

## Files touched

- [packages/examples/batch/run-e2e.mjs](../../run-e2e.mjs) — function `__wireBackgroundTextures` + new module-scope `WeakMap __lastWiredBgTex`.
