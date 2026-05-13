# Architecture Evolution — structural debt & the path to 100% fidelity

Companion to [ARCHITECTURE.md](./ARCHITECTURE.md) (what the system is), [STATUS.md](./STATUS.md) (what works today), [BACKLOG.md](./BACKLOG.md) (per-example bugs), and [IDEAS.md](./IDEAS.md) (the wide design space).

This file is the **structural** to-do list: the changes that make the plugins easier to evolve and make 100% visual fidelity *reachable* rather than a per-example grind. The latest generated coverage summary currently reports **153 / 225 graded examples** at PSNR ≥ 30 dB, and that number moves quickly; refresh `packages/examples/batch/results/coverage-summary.md` before quoting it externally. The remaining work is no longer mostly limited by individual rendering bugs — it is limited by where the fidelity logic lives, how the modules are factored, and how brittle the three.js coupling is. Fix the structure and the per-example work gets cheaper, safer, and shippable to real users.

**Current read.** This roadmap is good to use, but it is not "done." The first shared-contract, graph-normalization, slim-support, texture-resolution, hydrator-rebinder, codegen-parse, coverage-config, and strict-rewrite wedges have landed. The unfinished evolution is the second half: move the rest of the harness runtime behavior into `slim-support`, finish shrinking `hydrator.js` into allocation/source/dynamic modules, turn dynamic binding descriptors into emitted/runtime-resolved artifact data, harden the three.js compat matrix, and add a dev-vs-build extractor convergence guard.

Items are ordered **P0 → P3**. Each has: **Symptom** (what's wrong), **Why it blocks evolution/fidelity**, **Change** (target shape), **First step** (a small, low-risk wedge), **Files**.

Last updated: 2026-05-13.

---

## The one-paragraph diagnosis

The real fidelity work — PMREM generation, texture rebinding by identity, compute-buffer sync, shadow/pass delegation — still mostly lives in a **9.8k-line test harness** ([`packages/examples/batch/run-e2e.mjs`](packages/examples/batch/run-e2e.mjs)), so fixes can land in scaffolding before adopters benefit. The first productized runtime wedges now exist in [`packages/runtime/src/slim-support/live-scene-index.js`](packages/runtime/src/slim-support/live-scene-index.js) and [`packages/runtime/src/slim-support/pmrem.js`](packages/runtime/src/slim-support/pmrem.js), including PMREM cache/pending orchestration, but compute / fallback-renderer behavior still needs to move behind that API. The runtime's [`hydrator.js`](packages/runtime/src/hydrator.js) is down to ~2.3k LOC from the earlier ~3.8k LOC, with texture/source resolution, binding allocation, built-in texture reconstruction, typed-array helpers, and per-frame texture rebinders now split across [`packages/runtime/src/hydrate`](packages/runtime/src/hydrate). The important remaining hydrator debt is no longer "one giant texture resolver"; it is the local orchestration/classification layer that still builds shadow/material/viewport/reflector rebinder entry arrays and still owns material/light uniform writer if-chains. The extractor -> codegen -> runtime contract now has a shared package ([`packages/contract`](packages/contract)) for graph normalization, texture-property lists, the `source.kind` registry, dynamic binding descriptors, and artifact validation, removing several drift risks. The vendored three.js fork (~2.8k LOC) plus [`three-rewrite.js`](packages/plugin/src/three-rewrite.js) (1,718 LOC of source-text AST surgery on ~9 three.js files) now fails strict/CI builds on rewrite warnings and has a locked/latest compat matrix, but the deeper upstream seam is still unresolved. And pure slim **cannot generate shaders**, so shadows / clipping / dynamic node subgraphs are blocked — the harness papers over this by spinning up a *full* `WebGPURenderer` on the side, a pattern that is not yet productized.

---

## P0 — structural blockers (everything else gets easier after these)

### P0.1 — Extract a productized slim-support runtime module

**Symptom.** ~3,600 lines inside [`run-e2e.mjs`](packages/examples/batch/run-e2e.mjs) are *runtime behavior a real app needs*, not test logic: `__indexLiveTextures`, `__healTextureImage`, `__wireEnvironmentPMREM`, `__kickPMREMGenAsync`, `__getCachedPMREMForSource` (PMREM cache/memoization), `__syncStorageBuffers`, `__wireAutoComputeAttrs`, `__dispatchAutoComputeNodes`, `__getComputeRenderer`, `__renderPassNodeWithFullRenderer`, `__prepareSceneForReplay`, reflector/portal aux wiring, null-image healing, color-transfer fallbacks. They exist only in the harness because the runtime hasn't stabilized.

**Why it blocks evolution/fidelity.** Every fidelity fix is authored and tested against a 9.4k-line E2E file with a Playwright loop instead of a unit-testable module. Adopters of the slim bundle still get only the parts that have been extracted. The harness can never shrink. There is no complete documented API surface for "use the slim bundle in a real app."

**Change.** A new sub-package / sub-export `@tsl-precompile/runtime/slim-support` exposing roughly:

```js
const support = createSlimSceneSupport(renderer, {
  fullRendererFallback?: boolean,   // boot a full WebGPURenderer on the shared device for the hard 5%
  pmrem?: boolean,                  // generate PMREM from source environments
  computeSync?: boolean,            // sync compute storage buffers/textures into slim
});
support.indexScene(scene);          // live-texture identity index (uuid / imageSrc / name)
support.prepareForReplay(scene);    // stub live graphs, swap in precompiled materials
await support.generatePMREMAsync(texture);
support.syncComputeOutputs();
support.renderPassWithFallback(pass);
```

Move the harness `__*` helpers in there one cluster at a time (textures → PMREM → compute → pass/shadow fallback), leaving `run-e2e.mjs` as a thin caller of the same API real users would use.

**Status (2026-05-13).** Three wedges have landed.
[`packages/runtime/src/slim-support/live-scene-index.js`](packages/runtime/src/slim-support/live-scene-index.js) now owns live texture identity indexing, material/node texture cataloguing, and null-image healing.
[`packages/runtime/src/slim-support/pmrem.js`](packages/runtime/src/slim-support/pmrem.js) now owns PMREM artifact/source detection, cache hits, pending joins, image-readiness skips, generation diagnostics, pending-counter hooks, and `_textureRefs` wiring helpers.
[`packages/runtime/src/slim-support/gpu-texture-share.js`](packages/runtime/src/slim-support/gpu-texture-share.js) now owns the keystone cross-renderer GPU-texture migration primitives — `shareGPUTextureEntry`, `sharePMREMGPUTexture`, `shareShadowGPUTextureIntoSlim`, `markTextureInitialized`, `clearTextureViewCache` — used by PMREM + shadows + future compute sync. Unit-test coverage in [`packages/runtime/test/slim-support-gpu-texture-share.test.js`](packages/runtime/test/slim-support-gpu-texture-share.test.js); 9 cases covering the success paths, missing-data branches, diagnostics counters, bind-group invalidation, and error forwarding.
`run-e2e.mjs` imports all three helpers through the runtime package and the five GPU-share duplicates there are now thin wrappers (~6 lines each, diagnostics forwarded through `opts`). The harness full-renderer fallback still supplies the PMREM-generator scene cloning and records share diagnostics, but the GPU-data plumbing is no longer duplicated.

**Next step.** Productize the full-renderer PMREM generator / device-sharing helpers behind the future `fullRendererFallback` API (they now sit on top of the shared `gpu-texture-share` module), then keep pulling harness-only runtime behavior in this order: compute sync, pass/shadow delegation.

**Files.** new `packages/runtime/src/slim-support/*`; `packages/runtime/src/index.js` (export); `packages/runtime/package.json` (export map); `packages/examples/batch/run-e2e.mjs` (call, don't inline).

---

### P0.2 — Break up `hydrator.js` into a binding-kind pipeline

**Symptom.** [`hydrator.js`](packages/runtime/src/hydrator.js) has been reduced from ~3,843 LOC to ~2,264 LOC, but it is still too broad. `resolveTextureBinding()` is now thinner, yet it still owns source-kind branch order, viewport fallback construction, `artifact.texture` diagnostic wiring, and final fallback selection. `hydrateRuntimeBindings()` still classifies static bindings into dynamic rebinder entry arrays (`shadowDepthBindings`, `materialDepthBindings`, `artifactTextureBindings`, `materialTextureBindings`, `viewportTextureBindings`, `reflectorTextureBindings`). `writeMaterialValue`/`writeLightValue` are still large if-chains. Six hard-coded `DepthTexture` fallback variants remain local to the hydrator.

**Why it blocks evolution/fidelity.** Any change to binding behavior means navigating one enormous file. The texture resolver's *silent* fall-through to 1×1 white is one of the biggest hidden fidelity-loss sources and is undebuggable — you cannot see which strategy fired.

**Change.** `packages/runtime/src/hydrate/` should settle into three layers rather than forcing every source into one fake "binding kind" interface:
- `kinds/` — allocate static runtime bindings from renderer descriptors (`uniform-buffer`, sampled texture/sampler, `storage-buffer`). These own "how do I construct a three.js binding object?"
- `sources/` or resolver tables — resolve initial source values by `source.kind` (`artifact.texture`, `material.*`, `viewport.texture`, `builtin.dfgLUT`, `builtin.ltcTexture`, `depth.texture`) and emit either `{ texture, strategy }` or a dynamic descriptor. These own "what does this artifact source mean?"
- `rebinders/` or `dynamic/` — per-frame dynamic resolvers (`shadow-depth`, `material-depth`, `artifact-texture`, `material-texture`, `viewport-texture`, `reflector-texture`) keyed by explicit descriptors. These own "what changes each render?"
- `texture-resolver.js` / fallback helpers — the fallback chain as explicit named strategies, each returning `{ texture, strategy }`, so the active strategy is loggable/assertable; on full miss, *warn loudly* instead of silently binding white.
- `material-writers.js` / `light-writers.js` — the per-kind uniform writers, consolidated with [`writers.js`](packages/runtime/src/writers.js).
- `hydrator.js` shrinks to orchestration: walk groups → allocate static bindings → collect dynamic descriptors → return update/rebinder nodes.

Adding a binding kind becomes: add one static allocator if the renderer binding object is new; add one source resolver if the artifact source vocabulary is new; add one dynamic resolver only if the resource is per-frame. This is less elegant on paper than one universal interface, but it matches the code better and avoids pretending that DFG LUT, viewport, shadow depth, and storage buffers are the same kind of thing.

**Status (2026-05-13).** First no-behavior-change seams landed. [`packages/runtime/src/hydrate/texture-resolver.js`](packages/runtime/src/hydrate/texture-resolver.js) now owns uniform-plan texture lookup, shader texture-shape inference, texture-vs-binding compatibility checks, and shader-compatible fallback texture selection, with focused tests in [`packages/runtime/test/hydrate-texture-resolver.test.js`](packages/runtime/test/hydrate-texture-resolver.test.js). [`packages/runtime/src/hydrate/artifact-texture-resolver.js`](packages/runtime/src/hydrate/artifact-texture-resolver.js) now owns the `artifact.texture` strategy order (`material-node-texture`, `render-target-texture-ref`, `live-texture-identity`, `texture-ref`, `material-slot-uuid`, `anonymous-data-texture`, `snapshot`, `multisampled-depth-fallback`, `anonymous-storage-texture`), records the last strategy per binding on a non-enumerable `_textureResolutionStrategies` map, and exposes `setTextureResolutionDebugHook()` / `getTextureResolutionDebugHook()` for structured resolution events. [`packages/runtime/src/hydrate/texture-snapshot.js`](packages/runtime/src/hydrate/texture-snapshot.js) now owns artifact snapshot hydration for 2D / 3D / array textures, trivial-snapshot classification, mipmap-filter downgrades, typed-array reconstruction, and the non-enumerable snapshot cache. [`packages/runtime/src/hydrate/live-texture-registry.js`](packages/runtime/src/hydrate/live-texture-registry.js) now owns public live-texture registration, image/name identity lookup, anonymous DataTexture shape lookup, anonymous storage-texture lookup, and the idempotent prototype hooks that feed those indexes. [`packages/runtime/src/hydrate/material-node-textures.js`](packages/runtime/src/hydrate/material-node-textures.js) now owns material node-graph texture collection and `artifact.texture` material-node lookup, shared by the hydrator and `slim-support`. [`packages/runtime/src/hydrate/builtin-textures.js`](packages/runtime/src/hydrate/builtin-textures.js) now owns DFG LUT and LTC built-in texture resolution, including LTC half-float reconstruction and per-artifact caching. [`packages/runtime/src/hydrate/kinds/texture-bindings.js`](packages/runtime/src/hydrate/kinds/texture-bindings.js) now owns sampled-texture / sampler binding construction and rebindable clone tracking. [`packages/runtime/src/hydrate/kinds/uniform-buffer.js`](packages/runtime/src/hydrate/kinds/uniform-buffer.js) now owns uniform-buffer allocation, grouped snapshot seeding, flat `NodeUniformBuffer` snapshot seeding, and live typed-array updater attachment. [`packages/runtime/src/hydrate/kinds/storage-buffer.js`](packages/runtime/src/hydrate/kinds/storage-buffer.js) now owns storage-buffer live-attribute reuse, JSON/typed-array snapshot seeding, and `StorageBuffer` metadata setup; typed-array constructor resolution is shared through [`packages/runtime/src/hydrate/typed-arrays.js`](packages/runtime/src/hydrate/typed-arrays.js). [`packages/runtime/src/hydrate/kinds/runtime-binding-dispatcher.js`](packages/runtime/src/hydrate/kinds/runtime-binding-dispatcher.js) now owns dispatch for the extracted runtime binding kinds, so `hydrator.js` only supplies context and dependencies. [`packages/runtime/src/hydrate/rebinders/texture-binding-targets.js`](packages/runtime/src/hydrate/rebinders/texture-binding-targets.js) now owns clone-aware texture binding target collection, rebinding, invalidation, and GPU-resource-change tracking shared by the remaining rebinder factories. [`packages/runtime/src/hydrate/rebinders/texture-rebinders.js`](packages/runtime/src/hydrate/rebinders/texture-rebinders.js) now owns material-slot and artifact-texture rebinder factories. [`packages/runtime/src/hydrate/rebinders/reflector-texture-rebinder.js`](packages/runtime/src/hydrate/rebinders/reflector-texture-rebinder.js) now owns reflector render-target resolution, material reflector-node lookup, and reflector texture rebinding. [`packages/runtime/src/hydrate/rebinders/viewport-texture-rebinder.js`](packages/runtime/src/hydrate/rebinders/viewport-texture-rebinder.js) now owns viewport texture rebinding, zero-thickness transmission fallback selection, and render-id copy dedupe. [`packages/runtime/src/hydrate/rebinders/shadow-depth-rebinder.js`](packages/runtime/src/hydrate/rebinders/shadow-depth-rebinder.js) now owns light shadow-depth rebinding, material-graph depth-texture rebinding, compare-function updates, and GPU-resource-change invalidation.

**Architecture review (2026-05-13).** The direction is good, but the better target is **static binding allocation + source resolution + dynamic rebinding**, not one universal binding-kind interface. We already have natural seams for all three. The next improvement should remove the remaining `source.kind` classification from `hydrateRuntimeBindings()` and `resolveTextureBinding()` by making it table-driven: source resolver returns an initial texture/fallback plus an optional dynamic descriptor; the dynamic layer turns descriptors into update-before nodes.

**Next step.** Decide whether `storage-texture` should stay modeled as an `artifact.texture` resolution strategy or become a first-class source/dynamic descriptor, then move texture fallback selection/source diagnostics behind the extracted resolver boundary before P1.7 turns these rebinders into artifact-level dynamic descriptors.

**Files.** new `packages/runtime/src/hydrate/*`; `packages/runtime/src/hydrator.js` (slimmed); `packages/runtime/src/writers.js`.

---

### P0.3 — One shared contract: kind registry + texture-prop list + artifact schema

**Symptom.** `source.kind` used to be an undocumented string used independently in vendored [`extractUniformPlan.js`](packages/plugin/src/vendor/extractUniformPlan.js), plugin [`emit-updater.js`](packages/plugin/src/emit-updater.js), and runtime [`hydrator.js`](packages/runtime/src/hydrator.js). The current `kind-drift.test.js` catches extractor↔codegen drift, and plugin build/capture paths can fail on unknown codegen kinds, but until this pass the vocabulary was still not a shared runtime contract. The canonical "which material properties hold textures" list also used to be copy-pasted across runtime, hydrator, and the E2E harness; that copy-paste has now been removed through [`@tsl-precompile/contract`](packages/contract). The artifact JSON had no schema, so malformed resources could fail late or be interpreted differently by plugin and runtime.

**Why it blocks evolution/fidelity.** Adding a kind means touching 3+ files without one registry proving the extractor, codegen, runtime hydrator, and artifact schema all agree. A renamed texture property silently drops a texture. A malformed artifact fails late and obscurely.

**Change.** A shared module — [`@tsl-precompile/contract`](packages/contract) — exporting:
- `KINDS` — the registry. Per kind: human description, the codegen emitter it maps to, the runtime hydrator it maps to, a `deferred` flag (replaces the ad-hoc "documented blocked kinds" set).
- `TEXTURE_PROPS` / `NODE_GRAPH_KEYS` — the single canonical lists; everyone re-imports.
- `validateArtifact(json)` — assert the artifact shape (WGSL strings present, `uniformPlan` entry shape, every `source.kind ∈ KINDS`).

Wire it so the **plugin build fails** when an artifact has a `source.kind` not in `KINDS`, and the **runtime validates artifacts on load in dev mode**.

**Status (2026-05-12).** Contract wedge landed. [`packages/contract/src/texture-props.js`](packages/contract/src/texture-props.js) now exports `MATERIAL_TEXTURE_PROPS`, `NODE_GRAPH_TEXTURE_KEYS`, and `MATERIAL_NODE_TEXTURE_KEYS`; runtime, hydrator, and the E2E harness import the shared arrays. [`packages/contract/src/kinds.js`](packages/contract/src/kinds.js) now exports `KINDS`, `BLOCKED_KINDS`, kind lookup helpers, `collectArtifactSourceKinds()`, and `validateArtifact()`. [`packages/contract/src/dynamic-bindings.js`](packages/contract/src/dynamic-bindings.js) now describes live/dynamic source descriptors and `validateArtifact()` enforces required descriptor fields. `emit-updater` imports the blocked-kind reasons from the shared registry, root `pnpm verify` validates the checked-in example artifact payloads against the registry, and `__applyPrecompiled` can validate artifacts in dev / `__TSLP_VALIDATE_ARTIFACTS` mode. The validator currently cross-checks 45 checked-in package artifact JSON files plus 464 batch artifact JSON files with zero schema/source-kind failures.

**Next step.** Push the dynamic descriptor registry deeper into extractor/runtime internals: emit explicit artifact-level dynamic bindings, then make the hydrator binding-kind split (P0.2) consume those descriptors instead of local string branches.

**Files.** [`packages/contract/*`](packages/contract); `packages/plugin/src/emit-updater.js`, `packages/plugin/src/vendor/extractUniformPlan.js`; `packages/runtime/src/apply-precompiled.js`, `packages/runtime/src/hydrator.js`; `packages/examples/batch/run-e2e.mjs`.

---

### P0.4 — De-duplicate the graph hasher

**Symptom.** [`packages/runtime/src/graph-hash.js`](packages/runtime/src/graph-hash.js) and [`packages/plugin/src/hash.js`](packages/plugin/src/hash.js) both carry the same load-bearing normalization rules (`normalizeNode`, `leafRepr`, the MRTNode special case, `MAX_GRAPH_DEPTH = 128`, cycle detection). `rewrite-hash-parity.test.js` already proves the current implementations agree; it does not remove the need to edit two files for every behavioral tweak. They exist separately because the plugin runs in Node (`node:crypto`) and the runtime runs in the browser. If they drift, the runtime computes a different hash than the artifact was filed under and silently loads the wrong artifact (or none).

**Why it blocks evolution/fidelity.** The entire five-layer staleness gate's correctness rests on two hand-synced normalization implementations staying semantically identical forever. The parity tests are a good alarm; a shared module would be the lock.

**Change.** Extract `normalizeNode` / `leafRepr` / the normalization constants into one ESM module that both `hash.js` and `graph-hash.js` import; leave only `sha256(string)` platform-specific (Node `crypto` vs `SubtleCrypto`/a tiny pure-JS sha256). Keep the existing parity tests as the safety net around the extraction.

**Status (2026-05-12).** First wedge landed. [`packages/contract/src/graph-normalize.js`](packages/contract/src/graph-normalize.js) now exports `normalizeMaterialGraph` and `normalizeNode`; plugin [`hash.js`](packages/plugin/src/hash.js) and runtime [`graph-hash.js`](packages/runtime/src/graph-hash.js) import/re-export the same implementation while keeping platform-specific hashing separate. Existing parity tests pass unchanged.

**Next step.** Keep graph-shape changes inside the contract module, and add contract-level fixtures if normalization starts growing beyond the current parity tests.

**Files.** [`packages/contract/src/graph-normalize.js`](packages/contract/src/graph-normalize.js); `packages/plugin/src/hash.js`; `packages/runtime/src/graph-hash.js`; existing `packages/plugin/test/unit/rewrite-hash-parity.test.js`.

---

### P0.5 — Harden the three.js fork seam (vendor + `three-rewrite.js`)

**Symptom.** Vendored [`compileTSL.js`](packages/plugin/src/vendor/compileTSL.js) (1,440 LOC) + [`extractUniformPlan.js`](packages/plugin/src/vendor/extractUniformPlan.js) (1,386 LOC) import internal `three/src/**` paths, pinned to a fork commit (`Makio64/three.js@tsl-precompile`) and `three >= 0.184`. [`three-rewrite.js`](packages/plugin/src/three-rewrite.js) (1,718 LOC) does exact-shape AST surgery on `CubeRenderTarget.js`, `Renderer.js`, `RenderPipeline.js`, `PostProcessing.js`, `Background.js`, `Nodes.js`/`NodeManager.js`, `WebGPURenderer.js`, `WebGPUBackend.js`, `WebGPUPipelineUtils.js`. The repo already has per-file rewrite shape tests against the installed `three`; local builds can still warn and fall back for diagnosis, while CI/strict builds now fail on rewrite warnings.

**Why it blocks evolution/fidelity.** A routine three.js bump can silently re-bloat the slim bundle, break a rewrite, or stale every artifact (the three version is in the hash) — and nobody notices until the coverage number drops weeks later.

**Change.**
1. A CI **three.js compat probe**: build the slim bundle against `three@latest` nightly and **fail loudly** on any `three-rewrite.js` fallback or any vendor import error.
2. Extend the existing per-file rewrite shape tests into a compat matrix, so a three.js bump or `three@latest` drift produces a specific CI failure instead of only a local warning.
3. Evaluate replacing the riskiest text surgery with a **single upstreamed seam** — e.g. a `NodeManager` precompile hook or a `Renderer` extension point in three.js itself (the "sidecar / upstream the marker" direction in [IDEAS.md §5.6](IDEAS.md)). One sanctioned hook beats nine fragile rewrites.
4. Consider splitting the vendored extractor into `@tsl-precompile/three-extract` with its own version-compat matrix, decoupling its release cadence from the plugin.

**Status (2026-05-12).** First wedge landed. [`packages/runtime/rollup.config.js`](packages/runtime/rollup.config.js) now turns rewrite warnings into build errors when `CI=true` or `TSLP_FAIL_ON_REWRITE_WARNING=1`, and [`.github/workflows/three-compat.yml`](.github/workflows/three-compat.yml) runs a nightly/manual locked/latest matrix: per-file rewrite shape tests first, then a strict slim-build probe.

**Next step.** Expand the matrix with targeted vendor/extractor diagnostics, then evaluate the smallest upstream three.js hook that could remove the riskiest source rewrites.

**Files.** `.github/workflows/*`; `packages/plugin/src/three-rewrite.js`; `packages/plugin/src/index.js`; `packages/plugin/src/vendor/VENDORING.md`.

---

## P1 — fidelity ceiling decisions

### P1.6 — Decide and commit the slim-vs-full-renderer story

**Symptom.** `ShadowBaseNode.generate()` returns a constant `1.0` ([`slim-stubs.js:694`](packages/runtime/src/slim-stubs.js#L694)); `MeshDepthNodeMaterial` can't be built in slim (no node builder); clipping depends on `setupClipping()` reading the renderer's `ClippingContext`. So the harness boots a *full* `WebGPURenderer` on the shared GPU device for shadows, compute, and some passes (`__getComputeRenderer`, `__renderPassNodeWithFullRenderer`). Half the pipeline is "precompiled aux artifact", half is "full renderer on the side" — and nothing in the design says which path a given feature is supposed to take.

**Why it blocks evolution/fidelity.** Every "hard" example (shadows, MRT, reflectors, compute) needs a bespoke harness path because there's no productized policy. Pure-slim fidelity has an undocumented hard ceiling that nobody can plan around.

**Change.** Pick one and write it down:
- **(A) "Slim + full-renderer fallback" as a first-class runtime mode** — bootstrap a full `WebGPURenderer`, swap to slim for the 95%, keep the full one for shadows/compute/complex passes on the shared device. Cheaper near-term; productizes what the harness already does. ([IDEAS.md §5.7](IDEAS.md).)
- **(B) Extend the aux-artifact machinery** (already used for background / PMREM / post-processing) to also precompile the internal depth/shadow/clipping material *variants*, so pure slim can render them. The right end state; more work.

Likely (A) now, (B) later. Either way, document it as the policy.

**Status (2026-05-13).** Not done yet. The harness already behaves like option (A), and the latest MRT wedge makes that more explicit by resizing PassNode render targets to the active MRT descriptor, retargeting global `renderer.setMRT(...)` scenes to captured multi-output artifacts before WebGPU pipeline creation, and bypassing generic material replacement for the already-precompiled RenderPipeline fullscreen quad. Runtime/API docs still do not define this as a supported mode.

**First step.** Write the decision section here. If (A): move `__getComputeRenderer` + `__renderPassNodeWithFullRenderer` into `slim-support` (depends on P0.1) behind a `fullRendererFallback` flag.

**Files.** this doc; later `packages/runtime/src/slim-support/*`, `packages/runtime/src/slim-stubs.js`, `packages/runtime/src/aux-marker.js`.

---

### P1.7 — Make dynamic bindings a first-class artifact concept

**Symptom.** The artifact's `uniformPlan` is static, but several resources are inherently dynamic — per-camera framebuffer textures, reflector render targets, viewport textures, shadow-map depth textures, and the set of lights (which can change mid-session). These are handled by five hand-written rebinder *factories* plus per-frame heuristics: `createReflectorTextureRebinder`, `createViewportTextureRebinder`, `createShadowDepthRebinder`, and a light-by-index cache (`findLightInScene`) that never invalidates when lights are added/removed.

**Why it blocks evolution/fidelity.** Each rebinder is a pile of special-casing that silently goes stale (e.g. add a light at runtime → the cache is wrong). There's no shared model for "this binding resolves its resource per render."

**Change.** Add a `dynamicBindings` section to the artifact: "slot X resolves its GPU resource per render from descriptor D" (descriptor types: `shadow-depth(lightRef)`, `reflector-rt(reflectorRef, camera)`, `viewport-texture`, `framebuffer`, …). One generic `DynamicBindingResolver` keyed by descriptor type replaces the five bespoke rebinders. Pairs naturally with the kinds pipeline (P0.2).

**Status.** First contract wedge landed. [`packages/contract/src/dynamic-bindings.js`](packages/contract/src/dynamic-bindings.js) now describes dynamic binding sources and validates required descriptor fields, but artifacts do not yet emit a first-class `dynamicBindings` section and the runtime still resolves them through the existing rebinder factories.

**Current runtime descriptor map.**

| Runtime path today | Resolves | Current inputs | Better emitted descriptor |
| --- | --- | --- | --- |
| `shadow-depth-rebinder` | live light shadow depth texture or VSM moments texture | `source.kind = "depth.texture"`, `lightUuid`, `lightIndex`, `vsm` | `shadow-depth({ lightRef, mode: "depth" \| "vsm" })` |
| `shadow-depth-rebinder` material branch | material-graph / reflector depth texture | `fromMaterialGraph`, `textureUuid`, material sidecars | `material-depth({ textureRef, reflectorIndex? })` |
| `viewport-texture-rebinder` | per-frame viewport color/depth framebuffer texture | `source.kind = "viewport.texture"`, `generateMipmaps`, `isDepth`, transmission flags | `viewport-texture({ variant: "mip" \| "plain" \| "depth", fallbackPolicy })` |
| `reflector-texture-rebinder` | live `ReflectorBaseNode` render-target texture | `source.kind = "reflector.texture"`, `reflectorIndex` | `reflector-rt({ reflectorIndex, cameraScope: "frame" })` |
| `texture-rebinders` artifact branch | late/live `artifact.texture`, PMREM, compute/storage texture, stale GPUTexture | `source.kind = "artifact.texture"` plus UUID/name/image/snapshot hints | `artifact-texture({ sourceRef, strategyHints, late: true })` |
| `texture-rebinders` material branch | live material property texture | `source.kind = "material.*"` | `material-texture({ property })` |

**Next step.** Promote this table into emitted artifact data: extractor/codegen should emit a `dynamicBindings` section beside `uniformPlan`, and runtime should create update-before nodes from that section rather than rediscovering dynamic behavior from local string branches.

**Files.** this doc; later `packages/plugin/src/emit-*.js` (emit the section), `packages/plugin/src/vendor/extractUniformPlan.js` (classify dynamic slots), `packages/runtime/src/hydrate/*`.

---

## P2 — maintainability / measurement

### P2.8 — Replace string-concatenation codegen in `emit-updater.js`

**Symptom.** [`emit-updater.js`](packages/plugin/src/emit-updater.js) is ~930 LOC of `lines.push('    ' + writer)` — the generated updater function body is built by string concatenation in a loop. The unit tests assert many emitted substrings, but they do not systematically parse every generated updater shape before bundle time. 40+ `source.kind` cases are handled inline.

**Why it blocks evolution/fidelity.** Adding a kind is still scarier than it should be: a writer typo or a malformed call can ship into generated source and surface as a runtime error in the browser. The codegen has useful fixtures, but it is hard to test comprehensively while the output is assembled as raw strings.

**Change.** Either build the updater with `@babel/types` + `@babel/generator` (Babel is already a dependency), or — cheaper — restructure as a table of small writer templates and add a test that `new Function(emittedBody)` or `@babel/parser` parses every fixture kind.

**Status (2026-05-12).** First wedge landed. [`packages/plugin/test/unit/emit-updater.test.js`](packages/plugin/test/unit/emit-updater.test.js) now parses representative generated updater modules with `@babel/parser`. The new parse guard caught and fixed a real malformed-source bug in blocked-kind diagnostics: nested quotes in blocked kind names are now escaped with `JSON.stringify()`.

**Next step.** Convert the largest inline `source.kind` branches into a small writer-template table before moving to full AST codegen.

**Files.** `packages/plugin/src/emit-updater.js`; tests under `packages/plugin/test/`.

---

### P2.9 — Trustworthy coverage measurement

**Symptom.** Before 2026-05-12, PSNR was computed *twice* by *different* code: offline by [`run-coverage-summary.mjs`](packages/examples/batch/run-coverage-summary.mjs) decoding the saved PNGs, and in-browser via `page.evaluate` inside `run-e2e.mjs` (subject to rAF jitter). That first split is now closed by [`psnr.mjs`](packages/examples/batch/psnr.mjs). Per-example pixel-gate exclusions and ignore regions now live in checked-in config, but CI still needs to persist shots consistently and the PR tier still needs to be wired into CI.

**Why it blocks evolution/fidelity.** The headline coverage trend can't be fully trusted; nobody can see at a glance which examples are excluded from the gate or why.

**Change.** One deterministic offline PSNR path (decode PNGs in Node; a single shared `comparePSNR` used by both the harness and the summary). Always persist shots in CI. Move per-example gate config + ignore-regions to a checked-in `coverage-config.json`. Define a stable **tier-1 subset** that must stay green on every PR, separate from the slow full sweep.

**Status (2026-05-12).** Wedges landed: `run-e2e.mjs` and `run-coverage-summary.mjs` both use [`packages/examples/batch/psnr.mjs`](packages/examples/batch/psnr.mjs), and [`packages/examples/batch/coverage-config.json`](packages/examples/batch/coverage-config.json) now owns pixel-gate disabled reasons, ignore regions, and the first `tier1` subset. [`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs that configured `tier1` subset as a PR/push visual gate after a strict slim build, then uploads the tier report, coverage summary, and saved shots. The regenerated broad summary is 153 / 225, and the shared comparator exposed `webgpu_shadowmap_opacity.html` as the current broad-shadow regression.

**Next step.** Watch CI stability on hosted WebGPU, then expand the tier-1 set only with examples that are deterministic enough to be a PR gate. Keep the full sweep as scheduled/manual coverage.

**Files.** [`packages/examples/batch/psnr.mjs`](packages/examples/batch/psnr.mjs); new `packages/examples/batch/coverage-config.json`; `packages/examples/batch/run-e2e.mjs`; `packages/examples/batch/run-coverage-summary.mjs`; `.github/workflows/*`.

---

### P2.10 — Dev/build extractor convergence guard

**Symptom.** Dev path = the in-browser extractor running on the live scene; build path = [`node-harness.js`](packages/plugin/src/node-harness.js) + [`mock-webgpu.js`](packages/plugin/src/mock-webgpu.js) re-extracting with a minimal scene. Scene differences (light count, fog, shadow casters) can change the artifact shape; `pnpm verify` catches *some* of this but doesn't systematically diff "what dev captured" against "what build re-extracts."

**Why it blocks evolution/fidelity.** Silent drift between the two extraction paths is a correctness hazard that can mask itself as a per-example bug.

**Change.** Have `pnpm verify` (or a dedicated check) diff dev-captured vs build-re-extracted artifacts across the example corpus and fail on shape divergence; document explicitly which scene properties are *allowed* to differ.

**Status.** Not done yet. `pnpm verify` validates artifact shape/source-kind contract coverage, but it does not yet diff dev-captured artifacts against build-re-extracted artifacts.

**First step.** Add the diff step to [`packages/plugin/src/cli/verify.js`](packages/plugin/src/cli/verify.js).

**Files.** `packages/plugin/src/cli/verify.js`; `packages/plugin/src/node-harness.js`.

---

## P3 — cleanup (low risk; do alongside the above)

### P3.11 — Stub & dead-code hygiene
- [`slim-stubs.js`](packages/runtime/src/slim-stubs.js): close the PassNode/Node coverage gaps (track via the "[tsl-precompile/slim] X is not available" load-smoke errors). Resolve `ShadowBaseNode`'s inert stub together with P1.6.
- [`mock-webgpu.js`](packages/plugin/src/mock-webgpu.js): document the no-readback limitation loudly (scenes doing `mapAsync` get zeros and are flagged for real-browser re-render).
- `emit-updater.js`: the `switch`-after-`default` STATUS entry appears stale now; keep the default-last invariant and remove that note when STATUS.md is refreshed.
- The `frame.object.viewPosition` / `frame.object.direction` non-standard-property assumption (flagged in STATUS "Known issues") — verify the slim render loop populates `frame.object` before the updater runs, or fix the source.
- Prune the many untracked `visual-*` / `debug-*` JSON files under `packages/examples/batch/results/` (already flagged in [CONTINUATION_PLAN.md](CONTINUATION_PLAN.md)).

### P3.12 — Diagnostic-hook formalization
`__tslpHarnessDiagnostics`, `__TSLP_DEBUG_LIGHT_LINKAGE`, `__TSLP_DEBUG_SHADOW_BINDINGS`, `__TSLP_DEBUG_SHADOW_COVERAGE` etc. are ad-hoc globals with no schema. Fold them into the `slim-support` module's debug API (depends on P0.1) so they're documented, schema'd, and testable.

---

## Sequencing

```
P0.4 (hasher dedupe) ──┐  first shared-module wedge landed
P0.3 (shared contract) ─┼─► both feed P0.2 (hydrator split) and P1.7 (dynamic bindings)
                        │  texture-props + KINDS/schema + dynamic descriptors landed
P0.1 (slim-support) ────┴─► enables P1.6 (full-renderer policy) and P3.12 (debug hooks)
                           live-scene-index + PMREM orchestration wedges landed; compute/full-renderer next

P0.5 (three.js seam)  — strict rewrite warnings + locked/latest rewrite/slim matrix landed; vendor diagnostics next
P2.9 (coverage)       — shared PSNR + config/tier data + CI tier gate landed; expand/stabilize next
P2.8 (codegen)        — parser guard landed; writer table/AST codegen next
P2.10 (verify) , P3.* — opportunistic
```

Suggested order from here: **P0.2 source/dynamic descriptor table + storage-texture decision**, then **P1.7 emitted `dynamicBindings` consumed by runtime**, then **P0.1 full-renderer PMREM/compute/pass support + P1.6 policy**, then **P2.10 dev/build extractor convergence**, with P0.5 vendor diagnostics and P2/P3 cleanup folded in as touched areas stabilize.

## What "done" looks like

- Slim-bundle fidelity logic lives in `@tsl-precompile/runtime/slim-support` with unit tests; `run-e2e.mjs` is a thin caller and an adopter can get PMREM / texture rebinding / compute sync by importing the module.
- `hydrator.js` is < ~1k LOC of orchestration; binding kinds and texture-resolution strategies are individually testable; a full texture-resolution miss warns instead of binding white.
- There is one `KINDS` registry, one `TEXTURE_PROPS` list, one artifact schema; the build fails on an unknown kind; the runtime validates artifacts in dev.
- One `graph-normalize` module; a parity test guards plugin↔runtime hash agreement.
- A nightly job builds the slim bundle against `three@latest` and fails on any rewrite fallback; the slim-vs-full-renderer policy is written down.
- Coverage is one deterministic number from one code path, with a checked-in tier-1 PR gate.
