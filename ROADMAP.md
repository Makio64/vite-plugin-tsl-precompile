# Roadmap — structural debt & the path to 100% fidelity

Companion to [ARCHITECTURE.md](./ARCHITECTURE.md) (what the system is) and
[evolution-archive.md](./evolution-archive.md) (what already happened).

This file is the **active** structural to-do list: the changes that make the plugins easier
to evolve and make 100% visual fidelity *reachable* rather than a per-example grind. The
remaining work is no longer mostly limited by individual rendering bugs — it is limited by
where the fidelity logic lives, how the modules are factored, and how brittle the three.js
coupling is. Fix the structure and the per-example work gets cheaper, safer, and shippable
to real users.

It holds **open items only**. Dated snapshots, completed-wedge narrative, and historical
measurements live in [evolution-archive.md](./evolution-archive.md); this file split out of
`ROADMAP.md` on 2026-08-02, when that document reached 1,417 lines of mixed
roadmap and history and its own figures had gone stale against the tree.

**Current read.** This roadmap is good to use, but it is not "done." The shared contract now owns represented variant families, material-global compute, and renderer-owned PMREM/VSM internal passes; the runtime can replay those artifacts directly or execute an exact shared-device hybrid transaction. The prebuilt and guarded source profiles retain zero stock Node/TSL modules, generated helpers converge on one prebuilt runtime identity, and source mode is the recommended compiler-free delivery path for fully captured new Vite apps. Exact `three@0.185.1` is the shipping baseline under `slim-three-policy@12`; the next-version matrix remains an early-warning surface, not an implicit support promise. The unfinished evolution is narrower: move the remaining harness-only pass/custom-shadow policy into `slim-support`, finish the hydrator's source/dynamic-descriptor split, deepen vendor/extractor diagnostics for the next Three drift, and expand the browser/Node extractor convergence guard beyond its first genuine capture fixture.

The generated [`coverage-summary.md`](packages/examples/batch/results/coverage-summary.md)
is the canonical global fidelity snapshot, but it can lag targeted fresh reruns; refresh it
before quoting a total externally.

Items are ordered **P0 → P3**. Each has: **Symptom** (what's wrong), **Why it blocks
evolution/fidelity**, **Change** (target shape), **First step** (a small, low-risk wedge),
**Files**.

## Measurement policy — do not hand-write file sizes into active items

**Active P0–P3 items must not quote an absolute LOC, byte, or file-count figure.**
Every such number in this document has gone stale, usually within days: the 2026-08-02 audit
found `hydrator.js` documented at 1,402 against an actual 1,439, `aux-marker.js` at 2,688
against 2,820, `aux-loader.js` at 1,223 against 1,235, and `run-e2e.mjs` at 5,495 against
5,855. A reader cannot tell a deliberately-recorded historical figure from a forgotten one, so
every figure has to be re-checked before it can be trusted — which is the same as having none.

Instead:

- **Quote the command, not the digit.** `pnpm analyze:modules` emits a
  `tslp-module-budget-report@1` JSON block with per-file lines and branch counts, package and
  test-tree totals, and the installed diagnostic-global count. `pnpm test:module:budget` prints
  the same data as a table. Both are defined in
  [`scripts/repo-metrics.mjs`](scripts/repo-metrics.mjs) with exact, reproducible rules.
- **Let the gate hold the number.** [`scripts/module-budget.json`](scripts/module-budget.json)
  is the one place a current file size is written down, and CI fails when the tree disagrees
  with it — in *either* direction, so a cap that a split made obsolete must be ratcheted down
  rather than left as dead slack. A number that CI enforces cannot silently rot.
- **Dated snapshots may keep their figures**, because they are explicitly historical. Anything
  under a `## <date>` heading, and the §"Historical snapshot" sections, are exempt — they
  record what was true then. Active items are not.
- **Relative claims are fine and preferred**: "the largest file in the runtime", "roughly
  double the next-largest module", "regrew after its first split". These stay true.

Last updated: 2026-08-02 (compiler-free WebGL backend replay;
Three r185.1 compatibility and provenance;
artifact payload/generated scene data, generated selector adapters, temporal
projection identity, evidence integrity, and source-first slim UX remain from
2026-07-17; previous full audit 2026-06-09).

---

---

## The one-paragraph diagnosis

The remaining structural risk is no longer the absence of a product runtime: [`createSlimSceneSupport()`](packages/runtime/src/slim-support/scene-support.js) now productizes lazy shared-device full-renderer bootstrap, PMREM, material compute, shadow, pass fallback, texture sharing, and lifecycle-safe disposal. The harness still owns example-specific PMREM scene cloning and several pass/shadow policies, so those fixes can still benefit tests before adopters. The hydrator has already been split into focused allocation, source-resolution, variant, and dynamic-rebinder modules; its remaining debt is the orchestration/classification layer and explicit artifact-level dynamic descriptors. The shared contract now owns graph normalization, source kinds, represented families, material-global compute, and artifact validation. Strict version-locked Three rewrites and residue budgets make drift fail closed, but the upstream private seam remains a maintenance cost. Pure slim intentionally cannot compile arbitrary new graphs: the supported path is exact precompiled artifacts, with opt-in shared-device delegation for the bounded policies that still need a full renderer.

---

## P0 — structural blockers (everything else gets easier after these)

### P0.1 — Extract a productized slim-support runtime module

**Original symptom (historical).** At the first audit, ~3,600 lines inside [`run-e2e.mjs`](packages/examples/batch/run-e2e.mjs) were *runtime behavior a real app needs*, not test logic: `__indexLiveTextures`, `__healTextureImage`, `__wireEnvironmentPMREM`, `__kickPMREMGenAsync`, `__getCachedPMREMForSource` (PMREM cache/memoization), `__syncStorageBuffers`, `__wireAutoComputeAttrs`, `__dispatchAutoComputeNodes`, `__getComputeRenderer`, `__renderPassNodeWithFullRenderer`, `__prepareSceneForReplay`, reflector/portal aux wiring, null-image healing, and color-transfer fallbacks. The status below records which parts have since moved into the product runtime.

**Why it blocks evolution/fidelity.** At that audit, every fidelity fix was authored and tested against a 9.4k-line E2E file with a Playwright loop instead of a unit-testable module. The remaining risk is narrower but still real: harness-only policy can produce fixes that adopters cannot call until it moves behind `slim-support`.

**Change.** A new sub-package / sub-export `@tsl-precompile/runtime/slim-support` exposing roughly:

```js
const support = createSlimSceneSupport({
  renderer,
  loadThreeFullModule: () => import('virtual:tsl-precompile/full-three'),
  fullRendererFallback: 'auto', // enabled because a lazy full module is configured
  pmrem: true,
  computeSync: true,
});
support.indexScene(scene);          // live-texture identity index (uuid / imageSrc / name)
await support.ensureFallback();     // only when an uncaptured path is expected
await support.generatePMREMAsync(texture, generator);
await support.dispatchMaterialComputes(scene);
await support.populateShadowMaps(scene, camera);
await support.renderPassWithFallback(pass);
```

Move the harness `__*` helpers in there one cluster at a time (textures → PMREM → compute → pass/shadow fallback), leaving `run-e2e.mjs` as a thin caller of the same API real users would use.

**Status (2026-07-15).** The focused support modules and public orchestrator have landed incrementally; material-owned compute discovery is now runtime-owned as well.
[`packages/runtime/src/slim-support/live-scene-index.js`](packages/runtime/src/slim-support/live-scene-index.js) now owns live texture identity indexing, material/node texture cataloguing, and null-image healing.
[`packages/runtime/src/slim-support/pmrem.js`](packages/runtime/src/slim-support/pmrem.js) now owns PMREM artifact/source detection, cache hits, pending joins, image-readiness skips, generation diagnostics, pending-counter hooks, `_textureRefs` wiring helpers, and PMREM texture selection for artifacts.
[`packages/runtime/src/slim-support/gpu-texture-share.js`](packages/runtime/src/slim-support/gpu-texture-share.js) now owns the keystone cross-renderer GPU-texture migration primitives — `shareGPUTextureEntry`, `sharePMREMGPUTexture`, `shareShadowGPUTextureIntoSlim`, `markTextureInitialized`, `clearTextureViewCache` — used by PMREM, shadows, and compute sync. Unit-test coverage in [`packages/runtime/test/slim-support-gpu-texture-share.test.js`](packages/runtime/test/slim-support-gpu-texture-share.test.js); 9 cases covering the success paths, missing-data branches, diagnostics counters, bind-group invalidation, and error forwarding.
[`packages/runtime/src/slim-support/compute-sync.js`](packages/runtime/src/slim-support/compute-sync.js) now owns compute-output synchronisation across renderers — `getComputeBindGroups`, `computeNodeUsesStorageTexture`, `syncComputeStorageOutputs` — for the case where the slim renderer borrows a full renderer to run a `ComputeNode` and needs its storage textures/buffers visible to its own draw call. Delegates storage-texture sharing to `shareShadowGPUTextureIntoSlim`; storage-buffer paths cover both "adopt full's GPUBuffer when slim has none" and "copyBufferToBuffer when slim already allocated its own". Unit-test coverage in [`packages/runtime/test/slim-support-compute-sync.test.js`](packages/runtime/test/slim-support-compute-sync.test.js); 8 cases covering bind-group detection, storage-texture sharing with mipmap regeneration, buffer adopt/copy paths, the `onStorageAttr` callback, missing-device gracefulness, and error forwarding.
[`packages/runtime/src/slim-support/auto-compute.js`](packages/runtime/src/slim-support/auto-compute.js) now owns the material scene walk that used to be `__wireAutoComputeAttrsToArtifact` / `__dispatchAutoComputeNodes`: it retains every material owner of a shared kernel, filters writable full-renderer storage bindings, rejects ambiguous same-shape outputs, retries transient pre-bootstrap states, invalidates each newly wired material once, and dispatches a shared node once per call. The signed `materialCompute` contract supplies exact kernel/resource/render-binding ownership, lifecycle cadence, and schedule order. `precompiled` mode hydrates proven storage-buffer kernels without a live graph; storage textures and other unsupported proofs use `hybrid-required`, which retains the exact raw kernel and delegates one serialized shared-device transaction. Owner-local mappings are applied only after exact render-variant selection, serialized artifacts remain immutable, and `createSlimSceneSupport().dispatchMaterialComputes(scene)` is the awaited adopter API. The harness is now a thin adapter that retains only frozen-screenshot policy.
[`packages/runtime/src/slim-support/full-renderer-fallback.js`](packages/runtime/src/slim-support/full-renderer-fallback.js) now owns the lazy bootstrap of a full `WebGPURenderer` on the slim renderer's shared `GPUDevice` — the productized version of `__getComputeRenderer`. Single-promise de-duplication, shared-device + `reversedDepthBuffer` forwarding, `shadowMap.enabled` toggle, optional `loadThreeFullModule()` async factory for non-bundler environments, `dispose()` + re-boot semantics. Unit-test coverage in [`packages/runtime/test/slim-support-full-renderer-fallback.test.js`](packages/runtime/test/slim-support-full-renderer-fallback.test.js); 9 cases covering boot/dedup/option-forwarding/error/dispose paths.
[`packages/runtime/src/slim-support/shadow-fallback.js`](packages/runtime/src/slim-support/shadow-fallback.js) now owns the standard Directional/Spot/Point depth-shadow fallback: it builds and refreshes a cached full-native proxy scene, performs the two lazy shadow warm-up renders, copies live map/matrix/camera state to the slim lights, and shares depth GPU textures. It preserves native `autoUpdate` behavior, validates shared-device/depth conventions, and fails closed for VSM/transmitted shadows, custom shadow nodes, skinned/batched/morphing casters, clipping shadows, and opaque node graphs unless the caller supplies `resolveShadowMaterial`; `createSlimSceneSupport().populateShadowMaps()` is the public orchestrator surface.
[`packages/runtime/src/slim-support/precompiled-shadows.js`](packages/runtime/src/slim-support/precompiled-shadows.js) now owns the captured non-point VSM resource graph on slim: shadow-depth render, vertical moments, horizontal moments, live semantic rebinding, target resize, update cadence, and disposal. Point/custom VSM remains explicitly unsupported; the full-renderer shadow adapter covers only the non-VSM depth families it validates.
[`packages/runtime/src/slim-support/scene-support.js`](packages/runtime/src/slim-support/scene-support.js) is the public **`createSlimSceneSupport()`** orchestrator referenced at the top of this section — composes the focused support modules into a single opt-in entry point (`indexScene`, `getFullRenderer`, `generatePMREMAsync`, `dispatchMaterialComputes`, `syncComputeOutputs`, `populateShadowMaps`, pass fallback, texture sharing, and `dispose`), with a shared diagnostics bag and an `onError(err, where)` for non-fatal sub-module failures. Focused unit coverage exercises opt-in defaults, fallback boot, material compute ownership/delegation, texture sharing, scene indexing, PMREM routing, pass fallback, and missing shadow-fallback configuration.

`run-e2e.mjs` imports the compute primitives and material dispatcher through the runtime package. Its auto-compute block now supplies only the active full renderer, the existing delegated `slimRenderer.compute()` call, and the harness-specific frozen-frame `Set`; owner discovery, attribute matching, retry state, and invalidation are shared with adopters. Compiler-free PMREM texture generation and non-point VSM scheduling are runtime-owned; the harness still owns example-specific scene cloning and several pass/custom-shadow policies. Harness-only visual interventions are no longer anonymous inline branches: [`e2e-browser-stabilization-policy.mjs`](packages/examples/batch/e2e-browser-stabilization-policy.mjs) is a data-only registry for media, audio, and multi-canvas stabilization, every applied policy is serialized into the fingerprinted per-case configuration, and a source guard rejects new direct example-name branches in the visit/screenshot seams.

**Next step.** Continue migrating the remaining harness pass/custom-shadow policy onto the existing support surface, and profile whether hybrid kernels can be retained more narrowly without weakening exact resource ownership. Keep point/custom shadow nodes and GPU/skinned caster proxies as explicit adapters until captured schedulers exist.

**Files.** new `packages/runtime/src/slim-support/*`; `packages/runtime/src/index.js` (export); `packages/runtime/package.json` (export map); `packages/examples/batch/run-e2e.mjs` (call, don't inline).

---

### P0.2 — Break up `hydrator.js` into a binding-kind pipeline

**Current symptom.** [`hydrator.js`](packages/runtime/src/hydrator.js) is capped by
[`scripts/module-budget.json`](scripts/module-budget.json) (`pnpm test:module:budget`); it is
roughly a third of its pre-split size but has regrown since the split, and it is still one of
the largest files in the runtime. Static binding dispatch, dynamic texture classification, fallback textures, material/light writers, variants, and rebinder execution have moved into focused modules. The remaining broad seam is orchestration: `hydrateRuntimeBindings()` still owns the arrays that connect classified bindings to per-render resolvers, while `resolveTextureBinding()` remains the top-level source-resolution entry point.

**Why it blocks evolution/fidelity.** Texture resolution now records named strategies and can warn or fail strictly on a shape-only fallback, but the artifact does not yet describe every per-render resource uniformly. Adding a dynamic source can still require coordinated classification arrays and orchestration changes instead of one contract-owned descriptor and resolver.

**Change.** `packages/runtime/src/hydrate/` should settle into three layers rather than forcing every source into one fake "binding kind" interface:
- `kinds/` — allocate static runtime bindings from renderer descriptors (`uniform-buffer`, sampled texture/sampler, `storage-buffer`). These own "how do I construct a three.js binding object?"
- `sources/` or resolver tables — resolve initial source values by `source.kind` (`artifact.texture`, `material.*`, `viewport.texture`, `builtin.dfgLUT`, `builtin.ltcTexture`, `depth.texture`) and emit either `{ texture, strategy }` or a dynamic descriptor. These own "what does this artifact source mean?"
- `rebinders/` or `dynamic/` — per-frame dynamic resolvers (`shadow-depth`, `material-depth`, `artifact-texture`, `material-texture`, `viewport-texture`, `reflector-texture`) keyed by explicit descriptors. These own "what changes each render?"
- `texture-resolver.js` / fallback helpers — the fallback chain as explicit named strategies, each returning `{ texture, strategy }`, so the active strategy is loggable/assertable; on full miss, *warn loudly* instead of silently binding white.
- `material-writers.js` / `light-writers.js` — the per-kind uniform writers, consolidated with [`writers.js`](packages/runtime/src/writers.js).
- `hydrator.js` shrinks to orchestration: walk groups → allocate static bindings → collect dynamic descriptors → return update/rebinder nodes.

Adding a binding kind becomes: add one static allocator if the renderer binding object is new; add one source resolver if the artifact source vocabulary is new; add one dynamic resolver only if the resource is per-frame. This is less elegant on paper than one universal interface, but it matches the code better and avoids pretending that DFG LUT, viewport, shadow depth, and storage buffers are the same kind of thing.

**Historical status (2026-05-14).** Hydrator was down to **656 LOC** from a session-start of 1193 (-45%) — three fresh extractions: [`packages/runtime/src/hydrate/fallback-textures.js`](packages/runtime/src/hydrate/fallback-textures.js) owns the per-shape fallback singletons + `makeViewportFallback()`; [`packages/runtime/src/hydrate/clipping-planes.js`](packages/runtime/src/hydrate/clipping-planes.js) owns `collectClippingGroupsForObject` + `projectClippingPlanes` + `clippingPlaneSetsForFrame` + `selectClippingPlaneArray`; [`packages/runtime/src/hydrate/user-attributes.js`](packages/runtime/src/hydrate/user-attributes.js) owns `bindUserNodeAttributesToArtifact` + `bindUserStorageBuffersToArtifact` + `findInstancedObjectAttributeMatchingEntry` + `getInstancedMatrixColumnAttribute` + `findFirstAttributeMatchingEntry` + `hydrateNodeAttributes` + `itemSizeFromAttributeType` (~320 LOC of attribute/storage-buffer binding for compute-mesh and instanced paths). `Matrix3` / `Plane` / `InstancedBufferAttribute` / `StorageBufferAttribute` no longer imported into `hydrator.js`. All 278 runtime tests were green at that checkpoint.

Earlier wedges. [`packages/runtime/src/hydrate/texture-resolver.js`](packages/runtime/src/hydrate/texture-resolver.js) now owns uniform-plan texture lookup, shader texture-shape inference, texture-vs-binding compatibility checks, and shader-compatible fallback texture selection, with focused tests in [`packages/runtime/test/hydrate-texture-resolver.test.js`](packages/runtime/test/hydrate-texture-resolver.test.js). [`packages/runtime/src/hydrate/artifact-texture-resolver.js`](packages/runtime/src/hydrate/artifact-texture-resolver.js) now owns the `artifact.texture` strategy order (`material-node-texture`, `render-target-texture-ref`, `live-texture-identity`, `texture-ref`, `material-slot-uuid`, `anonymous-data-texture`, `snapshot`, `multisampled-depth-fallback`, `anonymous-storage-texture`), records the last strategy per binding on a non-enumerable `_textureResolutionStrategies` map, and exposes `setTextureResolutionDebugHook()` / `getTextureResolutionDebugHook()` for structured resolution events. [`packages/runtime/src/hydrate/texture-snapshot.js`](packages/runtime/src/hydrate/texture-snapshot.js) now owns artifact snapshot hydration for 2D / 3D / array textures, trivial-snapshot classification, mipmap-filter downgrades, typed-array reconstruction, and the non-enumerable snapshot cache. [`packages/runtime/src/hydrate/live-texture-registry.js`](packages/runtime/src/hydrate/live-texture-registry.js) now owns public live-texture registration, image/name identity lookup, anonymous DataTexture shape lookup, anonymous storage-texture lookup, and the idempotent prototype hooks that feed those indexes. [`packages/runtime/src/hydrate/material-node-textures.js`](packages/runtime/src/hydrate/material-node-textures.js) now owns material node-graph texture collection and `artifact.texture` material-node lookup, shared by the hydrator and `slim-support`. [`packages/runtime/src/hydrate/builtin-textures.js`](packages/runtime/src/hydrate/builtin-textures.js) now owns DFG LUT and LTC built-in texture resolution, including LTC half-float reconstruction and per-artifact caching. [`packages/runtime/src/hydrate/kinds/texture-bindings.js`](packages/runtime/src/hydrate/kinds/texture-bindings.js) now owns sampled-texture / sampler binding construction and rebindable clone tracking. [`packages/runtime/src/hydrate/kinds/uniform-buffer.js`](packages/runtime/src/hydrate/kinds/uniform-buffer.js) now owns uniform-buffer allocation, grouped snapshot seeding, flat `NodeUniformBuffer` snapshot seeding, and live typed-array updater attachment. [`packages/runtime/src/hydrate/kinds/storage-buffer.js`](packages/runtime/src/hydrate/kinds/storage-buffer.js) now owns storage-buffer live-attribute reuse, JSON/typed-array snapshot seeding, and `StorageBuffer` metadata setup; typed-array constructor resolution is shared through [`packages/runtime/src/hydrate/typed-arrays.js`](packages/runtime/src/hydrate/typed-arrays.js). [`packages/runtime/src/hydrate/kinds/runtime-binding-dispatcher.js`](packages/runtime/src/hydrate/kinds/runtime-binding-dispatcher.js) now owns dispatch for the extracted runtime binding kinds, so `hydrator.js` only supplies context and dependencies. [`packages/runtime/src/hydrate/rebinders/texture-binding-targets.js`](packages/runtime/src/hydrate/rebinders/texture-binding-targets.js) now owns clone-aware texture binding target collection, rebinding, invalidation, and GPU-resource-change tracking shared by the remaining rebinder factories. [`packages/runtime/src/hydrate/rebinders/texture-rebinders.js`](packages/runtime/src/hydrate/rebinders/texture-rebinders.js) now owns material-slot and artifact-texture rebinder factories. [`packages/runtime/src/hydrate/rebinders/reflector-texture-rebinder.js`](packages/runtime/src/hydrate/rebinders/reflector-texture-rebinder.js) now owns reflector render-target resolution, material reflector-node lookup, and reflector texture rebinding. [`packages/runtime/src/hydrate/rebinders/viewport-texture-rebinder.js`](packages/runtime/src/hydrate/rebinders/viewport-texture-rebinder.js) now owns viewport texture rebinding, zero-thickness transmission fallback selection, and render-id copy dedupe. [`packages/runtime/src/hydrate/rebinders/shadow-depth-rebinder.js`](packages/runtime/src/hydrate/rebinders/shadow-depth-rebinder.js) now owns light shadow-depth rebinding, material-graph depth-texture rebinding, compare-function updates, and GPU-resource-change invalidation.

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

**Status (2026-05-12; production boundary tightened 2026-07-13).** Contract wedge landed. [`packages/contract/src/texture-props.js`](packages/contract/src/texture-props.js) now exports `MATERIAL_TEXTURE_PROPS`, `NODE_GRAPH_TEXTURE_KEYS`, and `MATERIAL_NODE_TEXTURE_KEYS`; runtime, hydrator, and the E2E harness import the shared arrays. [`packages/contract/src/kinds.js`](packages/contract/src/kinds.js) now exports `KINDS`, `BLOCKED_KINDS`, kind lookup helpers, `collectArtifactSourceKinds()`, and `validateArtifact()`. [`packages/contract/src/dynamic-bindings.js`](packages/contract/src/dynamic-bindings.js) now describes live/dynamic source descriptors and `validateArtifact()` enforces required descriptor fields. `emit-updater` imports the blocked-kind reasons from the shared registry, root `pnpm verify` validates the checked-in example artifact payloads against the registry, and the conditional runtime `/apply` entry performs the same broad schema validation in development. Production keeps the artifact hash and live source-graph freshness gates but excludes the `contract/kinds` schema closure. The validator currently cross-checks 45 checked-in package artifact JSON files plus 464 batch artifact JSON files with zero schema/source-kind failures.

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

**Symptom.** Vendored [`compileTSL.js`](packages/plugin/src/vendor/compileTSL.js) +
[`extractUniformPlan.js`](packages/plugin/src/vendor/extractUniformPlan.js) — the two largest
files in the plugin package, and both excluded from the correctness lint — import internal
`three/src/**` paths, pinned to a fork commit (`Makio64/three.js@tsl-precompile`) and
`three >= 0.184`. [`three-rewrite.js`](packages/plugin/src/three-rewrite.js) does exact-shape
AST surgery on every module named in
[`SLIM_THREE_REWRITE_TARGETS`](packages/contract/src/slim-three-policy.js) — currently 16
targets across 14 rewrite families (`CubeRenderTarget.js`, `Renderer.js`, `RenderPipeline.js`,
`PostProcessing.js`, `Background.js`, `Nodes.js`/`NodeManager.js`, `WebGPURenderer.js`,
`WebGPUBackend.js`, `WebGPUPipelineUtils.js`, `WebGLBackend.js`, the node-utils and
node-core-constants surfaces, loader tracking, and the shadow filter node). The policy list is
the source of truth: `three-rewrite.js` throws at import time if a declared family has no
handler or an implemented family is undeclared, so the count cannot silently drift out of this
paragraph's date. Run `node -e "import('./packages/contract/src/slim-three-policy.js').then(m
=> console.log(m.SLIM_THREE_REWRITE_TARGETS.length))"` for the current number. The repo already
has per-file rewrite shape tests against the installed `three`; local builds can still warn and
fall back for diagnosis, while CI/strict builds now fail on rewrite warnings.

**Why it blocks evolution/fidelity.** A routine three.js bump can silently re-bloat the slim bundle, break a rewrite, or stale every artifact (the three version is in the hash) — and nobody notices until the coverage number drops weeks later.

**Change.**
1. A CI **three.js compat probe**: build the slim bundle against `three@latest` nightly and **fail loudly** on any `three-rewrite.js` fallback or any vendor import error.
2. Extend the existing per-file rewrite shape tests into a compat matrix, so a three.js bump or `three@latest` drift produces a specific CI failure instead of only a local warning.
3. Evaluate replacing the riskiest text surgery with a **single upstreamed seam** — e.g. a `NodeManager` precompile hook or a `Renderer` extension point in three.js itself. One sanctioned hook beats nine fragile rewrites.
4. Consider splitting the vendored extractor into `@tsl-precompile/three-extract` with its own version-compat matrix, decoupling its release cadence from the plugin.

**Status (2026-05-12).** First wedge landed. [`packages/runtime/rollup.config.js`](packages/runtime/rollup.config.js) now turns rewrite warnings into build errors when `CI=true` or `TSLP_FAIL_ON_REWRITE_WARNING=1`, and [`.github/workflows/three-compat.yml`](.github/workflows/three-compat.yml) runs a nightly/manual locked/latest matrix: per-file rewrite shape tests first, then a strict slim-build probe.

**Next step.** Expand the matrix with targeted vendor/extractor diagnostics, then evaluate the smallest upstream three.js hook that could remove the riskiest source rewrites.

**Files.** `.github/workflows/*`; `packages/plugin/src/three-rewrite.js`; `packages/plugin/src/index.js`; `packages/plugin/src/vendor/VENDORING.md`.

---

## P1 — fidelity ceiling decisions

### P1.6 — Decide and commit the slim-vs-full-renderer story

**Original symptom (historical).** The harness booted a *full* `WebGPURenderer` on the shared GPU device for shadows, compute, and some passes without a documented boundary between precompiled replay and live compilation. The current boundary is artifact-first: signed compute, shadow, pass/effect, PMREM, and clipping families replay compiler-free when represented; an explicit lazy full renderer owns only uncaptured or `hybrid-required` work.

**Why it blocks evolution/fidelity.** Every "hard" example (shadows, MRT, reflectors, compute) needs a bespoke harness path because there's no productized policy. Pure-slim fidelity has an undocumented hard ceiling that nobody can plan around.

**Original decision space.** Pick one and write it down:
- **(A) "Slim + full-renderer fallback" as a first-class runtime mode** — bootstrap a full `WebGPURenderer`, swap to slim for the 95%, keep the full one for shadows/compute/complex passes on the shared device. Cheaper near-term; productizes what the harness already does.
- **(B) Extend the aux-artifact machinery** (already used for background / PMREM / post-processing) to also precompile the internal depth/shadow/clipping material *variants*, so pure slim can render them. The right end state; more work.

Likely (A) now, (B) later. Either way, document it as the policy.

### Decision (2026-05-13): Option (A) is the supported mode for v0.1+

**The supported `@tsl-precompile/runtime` mode is artifact-first slim replay plus an explicit lazy full-renderer fallback.** The slim renderer owns every represented path. A full `WebGPURenderer` boots on the **shared `GPUDevice`** only when the application configures it and requests work that cannot be proven from captured artifacts. Outputs return through the contracted texture/buffer share primitives.

The full-renderer fallback covers:

| Feature | Compiler-free path | Explicit fallback for uncaptured/live work |
|---|---|---|
| **Compute kernels** | Proven storage-buffer kernels replay from signed `materialCompute` artifacts | A full renderer dispatches `hybrid-required` kernels; contracted writable outputs sync back |
| **Shadow maps** | Captured depth plus non-point VSM vertical/horizontal passes replay on slim | Shared-device fallback handles validated non-VSM depth families; point/custom VSM fails closed |
| **PMREM** | Captured source conversion, blur, and GGX passes run through the compiler-free slim generator | Full PMREM is optional for an uncaptured layout |
| **Pass/effect WGSL** | Captured execution plans replay exact producer/effect/consumer order | A full renderer produces an uncaptured dynamic pass and shares its render-target textures |
| **Clipping context** | Captured planes and live `ClippingGroup` ancestry feed generated writers | A topology outside the signed artifact fails closed until recaptured or explicitly delegated |

The fallback is **explicitly available only when the application supplies** `threeFullModule` or `loadThreeFullModule`. The public default is `fullRendererFallback: 'auto'`: it enables fallback when one of those sources exists and otherwise stays pure slim. `false` opts out even when a loader is present; `true` requires one. The full renderer lazy-boots on first `await support.getFullRenderer()` / `ensureFallback()` and is then reused.

**Wiring:**

```js
import { createSlimSceneSupport } from '@tsl-precompile/runtime/slim-support';

const support = createSlimSceneSupport( {
  renderer: slimRenderer,
  loadThreeFullModule: () => import( 'virtual:tsl-precompile/full-three' ),
  fullRendererFallback: 'auto',
} );
```

**Status (2026-05-14).** Productized and shipping. [`packages/runtime/src/slim-support/full-renderer-fallback.js`](packages/runtime/src/slim-support/full-renderer-fallback.js) owns the lazy-init + shared-device bootstrap + dispose. [`packages/runtime/src/slim-support/scene-support.js`](packages/runtime/src/slim-support/scene-support.js) composes it with `live-scene-index`, `pmrem`, `compute-sync`, and `gpu-texture-share` behind `createSlimSceneSupport`. [`packages/runtime/test/slim-support-full-renderer-fallback.test.js`](packages/runtime/test/slim-support-full-renderer-fallback.test.js) + [`slim-support-scene-support.test.js`](packages/runtime/test/slim-support-scene-support.test.js) cover the boot, dispose, device-sharing, and PMREM cache paths.

**Render-fallback dispatch (2026-05-14).** Slim mode now degrades gracefully on non-precompiled materials instead of hard-throwing. New [`packages/runtime/src/slim-support/render-fallback-registry.js`](packages/runtime/src/slim-support/render-fallback-registry.js) holds a module-level `(renderObject) => nodeBuilderState` handler. [`scene-support.js`](packages/runtime/src/slim-support/scene-support.js)'s new `ensureFallback()` async method eagerly boots the full renderer and registers a sync handler that proxies to `fullRenderer.nodes.getForRender(renderObject)`. The slim Nodes.js rewrite ([`packages/plugin/src/three-rewrite.js:791-803`](packages/plugin/src/three-rewrite.js#L791-L803)) now calls `getSlimRenderFallback()?.( renderObject )` before throwing; the fallback path is invisible to adopters until they configure it. New error copy points adopters at the configuration: "*Either call .precompile() on the material at capture time, or boot a full-renderer fallback via createSlimSceneSupport({ fullRendererFallback: true }) and call await support.ensureFallback() before rendering.*" Five-test suite locks the registry contract ([`packages/runtime/test/slim-support-render-fallback-registry.test.js`](packages/runtime/test/slim-support-render-fallback-registry.test.js)).

Adopter pattern for slim mode with non-precompiled materials (Inspector helpers, addon meshes, code paths the user doesn't own):

```js
import { createSlimSceneSupport } from '@tsl-precompile/runtime/slim-support';

const support = createSlimSceneSupport( {
  renderer: slimRenderer,
  loadThreeFullModule: () => import( 'virtual:tsl-precompile/full-three' ),
} );
await support.ensureFallback();   // boot full renderer + register slim getForRender handler
slimRenderer.setAnimationLoop( () => slimRenderer.render( scene, camera ) );
```

`run-e2e.mjs`'s `__getComputeRenderer` now delegates to the productized fallback so the harness exercises exactly the same code path adopters will.

Option (B) has advanced: signed shadow-depth families, non-point VSM
filter scheduling, PMREM source/blur/GGX passes, and captured clipping topology
replay directly. The remaining follow-up is to broaden exact proofs for
unsupported dynamic families without turning the fallback into an implicit
catch-all.

**Files.** [`packages/runtime/src/slim-support/full-renderer-fallback.js`](packages/runtime/src/slim-support/full-renderer-fallback.js); [`packages/runtime/src/slim-support/scene-support.js`](packages/runtime/src/slim-support/scene-support.js); [`packages/examples/batch/run-e2e.mjs`](packages/examples/batch/run-e2e.mjs) `__getComputeRenderer` delegation.

---

### P1.7 — Make dynamic bindings a first-class artifact concept

**Symptom.** The artifact's `uniformPlan` is static, but several resources are inherently dynamic — per-camera framebuffer textures, reflector render targets, viewport textures, shadow-map depth textures, and the set of lights (which can change mid-session). These are handled by five hand-written rebinder *factories* plus per-frame heuristics: `createReflectorTextureRebinder`, `createViewportTextureRebinder`, `createShadowDepthRebinder`, and a light-by-index cache (`findLightInScene`) that never invalidates when lights are added/removed.

**Why it blocks evolution/fidelity.** Each rebinder is a pile of special-casing that silently goes stale (e.g. add a light at runtime → the cache is wrong). There's no shared model for "this binding resolves its resource per render."

**Change.** Add a `dynamicBindings` section to the artifact: "slot X resolves its GPU resource per render from descriptor D" (descriptor types: `shadow-depth(lightRef)`, `reflector-rt(reflectorRef, camera)`, `viewport-texture`, `framebuffer`, …). One generic `DynamicBindingResolver` keyed by descriptor type replaces the five bespoke rebinders. Pairs naturally with the kinds pipeline (P0.2).

**Status.** First contract wedge landed. [`packages/contract/src/dynamic-bindings.js`](packages/contract/src/dynamic-bindings.js) now describes dynamic binding sources and validates required descriptor fields.

**Status update (2026-06-09): partially landed — texture-shaped entries only.** Artifacts now DO emit `dynamicBindings` (`collectArtifactDynamicBindings` in emit-manifest), and the runtime consumes the sampled-texture/sampler entries through [`hydrate/kinds/dynamic-texture-classifier.js`](packages/runtime/src/hydrate/kinds/dynamic-texture-classifier.js) → per-kind rebinders. Still open: uniform-slot UPDATE_BEFORE descriptors and `storage.buffer` dispatch are described in the contract but not consumed; and the light-by-index cache (`findLightInScene`) never invalidates when lights are added/removed mid-session — a confirmed per-frame O(scene) traversal cost, not just maintenance debt. Fold §P1.9's per-render resolution caching into this item's design: both express "this binding resolves its resource per render".

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

### P1.8 — Make production-preview a first-class supported workflow

**Symptom.** `packages/examples/ocean` is the canonical hand-test for the dev capture flow but had never been driven through `vite build && vite preview` end-to-end. Doing so on 2026-05-13 surfaced four layered gaps in the **production-preview pipeline** for non-trivial examples (Inspector + addon objects + `RenderPipeline + bloom` + PMREM env). The ocean preview canvas is black; an initial diagnosis blamed the build-time warning "5 not-yet-animated kind(s) (`uniform.live` × 5)", but inspection of the artifact showed those slots are static identity texture-sampler matrices (4 mat3) and viewport size (1 vec2) — they are not animated values whose freezing breaks anything. The real blockers are below.

**Why it blocks evolution/fidelity.** "Capture in dev → ship in prod" is the headline value proposition. Today the prod side works for trivial examples (`getting-started`) but quietly degrades to a black canvas on anything that uses three.js's standard production-ready building blocks (Inspector, addon meshes, `RenderPipeline`). Until this path is documented and tested end-to-end, every adopter who tries to ship hits the same multi-day debugging chain.

**The four gaps**, in priority order:

1. **`precompileAuxiliary()` has no production no-op.** Calling it unconditionally in user code triggers a runtime `fetch('/__tsl-precompile/capture')` (404 in preview → SPA fallback returns HTML → `JSON.parse` throws "Unexpected token '<'") AND `lazyLoadCompileTSL()` (which uses `/* @vite-ignore */` so Vite doesn't rewrite the bare specifier — the dynamic import then fails with `Failed to resolve module specifier 'vite-plugin-tsl-precompile/src/vendor/compileTSL.js'`). **Workaround landed**: wrap the call in `if ( import.meta.env.DEV )` ([packages/examples/ocean/main.js:188](packages/examples/ocean/main.js#L188)). **Real fix**: detect production at runtime inside [`packages/runtime/src/aux-marker.js`](packages/runtime/src/aux-marker.js) and no-op cleanly; document the recommended call shape so users don't need the `import.meta.env.DEV` guard.
2. **Aux artifacts are auto-registered ONLY in slim mode.** [packages/plugin/src/index.js:379-385](packages/plugin/src/index.js#L379-L385): `if ( opts.slim ) { injectSlimAuxImport(...) }`. Without `slim: true`, the captured `aux-background-*.json`, `aux-render-output-*.json`, `aux-lights-*.json` files on disk are never loaded into the production bundle, so background / RenderPipeline / PMREM fall back to live three.js compilation paths that may not produce a valid frame. **Real fix**: hoist `injectSlimAuxImport` out from the slim branch — aux registration should run in any production build, slim or not.
3. **Inspector preview-mode bug.** [three/addons/inspector/tabs/Settings.js:5,256](node_modules/.pnpm/three@0.184.0/node_modules/three/examples/jsm/inspector/tabs/Settings.js): `await fetch( new URL( '../extensions/extensions.json', import.meta.url ) ).then( r => r.json() )`. Vite preview's SPA fallback returns HTML for the unknown URL → `JSON.parse` throws. The existing `optimizeDeps.exclude: ['three/addons/inspector/Inspector.js']` in [vite.config.js:21](packages/examples/ocean/vite.config.js#L21) only addresses a different layer of the same `import.meta.url` problem in dev. Stripping Inspector from main.js was enough on 2026-05-13 to flip the canvas from pure black to the navy clear-color, confirming Inspector also blocks render init in preview, not just throwing a cosmetic JSON error. **Real fix**: either fork/patch Inspector to gracefully handle a 404 on extensions.json, or document a "skip Inspector in production" pattern (e.g. `if ( import.meta.env.DEV )` around the Inspector wiring).
4. **Slim mode is incomplete for addon shader graphs.** Trying `slim: true` on ocean revealed missing exports: `varyingProperty`, `OnMaterialUpdate`, `reflect`, `reflector`. **Wedge landed**: added all four as inert stubs ([packages/runtime/src/slim-stubs.js:943-946](packages/runtime/src/slim-stubs.js#L943-L946)). The deeper issue: `WaterMesh`'s constructor unconditionally calls `this.sunDirection.negate()` to build a TSL graph, and the slim `UniformNode`/`Node` classes don't implement chain methods like `negate()` — the next slim run on ocean will throw `this.sunDirection.negate is not a function`. **Real fix**: either add a Proxy-fallback to slim `Node` so all method chains return `inertNodeStub`, or replace the slim `uniform()` factory with a Proxy-wrapped `UniformNode`. Pairs with [§P1.6](#p16--decide-and-commit-the-slim-vs-full-renderer-story) since the fallback policy decides whether slim should keep growing TSL coverage or hand off.

**First step.** A node-level smoke test for `packages/examples/ocean`: build the example via the plugin, spawn `vite preview`, drive Playwright to load it, assert the canvas is non-trivial (mean luma > some threshold across regions where water+sky belong) and there are zero `pageerror` events. This pins the four gaps as a regression suite before any structural fix lands.

**Status (2026-05-14).** Headline gap resolved end-to-end and locked in by CI. Items 1, 3, 4, 5 from the original follow-up list landed:
- **Gap 1 moved into the runtime** — [packages/runtime/src/aux-marker.js](packages/runtime/src/aux-marker.js) `lazyLoadCompileTSL()` now catches the production import failure, sets a `compileTSLLoadFailed` flag, and `precompileAuxiliary()` short-circuits to `[]` after one info-level note. The `import.meta.env.DEV` boilerplate is gone from the ocean example.
- **Item 3 warning copy refined** — `severity: 'blocked'` push sites in [packages/plugin/src/emit-updater.js](packages/plugin/src/emit-updater.js) tag identity-matrix snapshots with `isStaticSnapshot: true`; [packages/plugin/src/index.js:515-526](packages/plugin/src/index.js#L515-L526) splits the warning into "safe to ignore" vs. the original alarming copy.
- **Item 4 slim Node Proxy fallback** — [packages/runtime/src/slim-stubs.js](packages/runtime/src/slim-stubs.js) `wrapWithSlimNodeChainFallback()` lets `slim: true` builds survive addon-shader-graph chains (`WaterMesh.sunDirection.negate()` etc.). 245/245 runtime tests pass. Slim mode still rejects unprecompiled `MeshBasicMaterial` internals — that's a §P1.6 policy question, not §P1.8.
- **Item 5 PR-blocking smoke** — new [packages/examples/preview-smoke/](packages/examples/preview-smoke/) package + `preview-smoke-ocean` job in [.github/workflows/ci.yml](.github/workflows/ci.yml). Asserts canvas non-trivial pixels + inter-frame diff + zero `pageerror`. Local run: `{"ok":true,"nonZeroRatio":0.9761,"diffRatio":0.994}`.

Inspector preview gap also closed via a Vite plugin middleware (`attachInspectorExtensionsShim` in [packages/plugin/src/index.js](packages/plugin/src/index.js)) wired to both `configureServer` and `configurePreviewServer`; intercepts `/extensions/extensions.json` requests and returns `[]`. Ocean now imports Inspector unconditionally — zero adopter-facing boilerplate. §P1.8 is fully resolved.

**Files.** [packages/runtime/src/aux-marker.js](packages/runtime/src/aux-marker.js) (gap 1 production no-op), [packages/plugin/src/index.js:379-385](packages/plugin/src/index.js#L379-L385) (gap 2 un-gate aux injection), upstream three.js Inspector / a doc-only "skip in prod" note (gap 3), [packages/runtime/src/slim-stubs.js](packages/runtime/src/slim-stubs.js) Node class (gap 4 method-chain fallback).

---

### P1.9 — Per-render resolution caching for shared materials (dynamic-binding follow-on)

**Symptom.** Every render object sharing a material gets its own rebinder entry arrays from `hydrateNodeBuilderState()`; `resolveTextureBinding()` re-runs the 9-strategy chain per object per frame ([artifact-texture-resolver.js:189-193](packages/runtime/src/hydrate/artifact-texture-resolver.js)); `textureBindingTargets()` was re-iterated once per rebinder type per frame ([texture-binding-targets.js](packages/runtime/src/hydrate/rebinders/texture-binding-targets.js)); the light-by-index cache never invalidates when lights are added/removed.

**Why it blocks evolution/fidelity.** 200 sprites with one material did 200× identical source→live-texture resolution every frame; rebinders silently go stale; there is no shared model for "resolved this render."

**Change.** Resolution results cached at `(artifact, material, binding)` scoped to the current render, shared across all render objects of that material; light index version-stamped and invalidated on scene mutation; target lists cached at hydration.

**Status (2026-06-09).** First wedge landed: [`hydrate/rebinders/resolution-memo.js`](packages/runtime/src/hydrate/rebinders/resolution-memo.js) (`createFrameScopedResolutionMemo`) wraps the hydrator's `resolveTextureBinding`; the material/artifact texture rebinders thread `options.frame` through, and reuse is keyed on `frame.renderId`/`frameId` + `avoidTexture` identity. Covered by [`test/hydrate-resolution-memo.test.js`](packages/runtime/test/hydrate-resolution-memo.test.js), including the call-count-independent-of-instance-count contract. `textureBindingTargets()` now caches its target array keyed on the add-only clone-set size. Still open: the light-cache invalidation (tracked with §P1.7) and extending the memo to shadow/viewport/reflector rebinders if profiling shows the same duplication there.

**Files.** [resolution-memo.js](packages/runtime/src/hydrate/rebinders/resolution-memo.js), [texture-rebinders.js](packages/runtime/src/hydrate/rebinders/texture-rebinders.js), [texture-binding-targets.js](packages/runtime/src/hydrate/rebinders/texture-binding-targets.js), [hydrator.js](packages/runtime/src/hydrator.js).

---

## P2 — maintainability / measurement

### P2.8 — Replace string-concatenation codegen in `emit-updater.js`

**Symptom.** [`emit-updater.js`](packages/plugin/src/emit-updater.js) builds the generated updater function body by `lines.push()` string concatenation in a loop, with every `source.kind` case handled by an inline branch in one dispatcher. The unit tests assert many emitted substrings, but they do not systematically parse every generated updater shape before bundle time.

**Status (2026-08-02).** The writer-template table now covers every slot whose emitted
body is a single `writeYYY(view, off, expr);`: `DIRECT_SLOT_WRITERS` absorbed the camera
matrices, `object.*`/`object3d.*` world matrices and scales, the frame clock (including the
`__tslpPinnedClock` replay expression, which two cases previously spelled out separately),
renderer screen state, and `scene.fog.color`; `VELOCITY_SLOT_WRITERS` absorbed the four
TemporalNode records. What is left in the switch is exactly the set of slots that need a
guard, a matrix recompute, a scratch object, or a block body — which is what makes the
remaining switch worth reading. Adding a slot of the common shape is now one table entry
that cannot forget its `usedWriters.add()` or fall through. Verified byte-identical against
the previous implementation across 120 kind/target combinations before landing.

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

**Status (2026-05-13).** Wedges landed: `run-e2e.mjs` and `run-coverage-summary.mjs` both use [`packages/examples/batch/psnr.mjs`](packages/examples/batch/psnr.mjs), and [`packages/examples/batch/coverage-config.json`](packages/examples/batch/coverage-config.json) now owns pixel-gate disabled reasons, ignore regions, and the first `tier1` subset. [`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs that configured `tier1` subset as a PR/push visual gate after a strict slim build, then uploads the tier report, coverage summary, and saved shots. The 163 / 226 total recorded at that historical wedge is chronology, not current evidence; current claims require a manifest-bound exact campaign whose repository-source fingerprint still validates.

**Fail-closed evidence status (2026-07-31).** Pixel similarity is no longer
allowed to hide an incomplete or failed replay operation.
[`e2e-evidence-gate.mjs`](packages/examples/batch/e2e-evidence-gate.mjs)
publishes the schema-validated `tslp-e2e-semantic-evidence-gate@3` record for
every row. Stock, capture, and replay must all be observed and explicitly
complete their deterministic freeze boundary. Missing/incomplete phases,
timeouts, unexpected browser/runtime or GPU errors, and `[tslp*]` or
`[tsl-precompile*]` warnings
block the row. Each phase also has to prove that GPU hooks and device observers
were installed and that submitted work on every observed queue was fenced.

The gate consumes a complete `tslp-e2e-operation-registry@1` and validates each
outcome against a closed operation/requiredness policy. Material compute,
direct `NodeMaterial` replacement, `RenderPipeline` pass rendering, and Bloom
rendering are required when discovered; missing or unknown outcomes,
duplicates, an incomplete registry, or a requiredness downgrade fail closed.
Only auxiliary capture may publish optional outcomes, whose failures remain
visible without becoming product failures. Required failures can pass only
when every selector-class failure is recorded in order, bound to the exact FSR
or Bloom component/operation/effect, and paired one-to-one with a later render
and presentation (plus zero downstream failures for FSR). Coverage aggregation
and site evidence validation reinspect this record rather than trusting pixel
verdicts or a stored pass label.

The checked configuration has one explicit pixel diagnostic,
`webgpu_storage_buffer.html` under `volatileCompute`, because the upstream r185
shader is nondeterministic under the configured WebGPU execution model. Every
other canonical row retains its pixel gate, and the diagnostic still has to
pass artifact, browser/runtime, brightness, freeze, and semantic gates. Cohort
manifests bind the repository-source and harness fingerprint, so any
fingerprinted source change invalidates prior results and requires a fresh
exact campaign before a new coverage claim is current.

Three-source proof is also closed over the exact served file set.
`threeCheckout.sourceVerification.files` now carries each path's byte count,
SHA-256, Git blob/mode/object format, and official r185 commit/tree; its shared
digest and count are recomputed rather than shape-checked. Visual validators
additionally require those records to match the nonempty
`manifest.sources.three` snapshot and its checkout fingerprint exactly. Stock
validation uses the same self-contained proof contract.

Schema-2 artifact descriptors also bind path containment, stored byte length,
and SHA-256 before bounded gzip decoding; the declared encoding and exact
uncompressed length must match before strict UTF-8/schema validation. Landing
the v2 evidence contract changes the harness fingerprint, so this status entry
does not claim a final 254-route campaign. That claim becomes current only
after the exact stock/capture/replay rerun and its manifest-bound byte evidence
validate.

**Next step.** Keep fresh exact-campaign evidence coupled to fingerprinted
harness changes, watch CI stability on hosted WebGPU, and expand the tier-1 set
only with examples deterministic enough to be a PR gate. Keep the full sweep as
scheduled/manual coverage.

**Files.** [`packages/examples/batch/psnr.mjs`](packages/examples/batch/psnr.mjs); new `packages/examples/batch/coverage-config.json`; `packages/examples/batch/run-e2e.mjs`; `packages/examples/batch/run-coverage-summary.mjs`; `.github/workflows/*`.

---

### P2.10 — Dev/build extractor convergence guard

**Symptom.** Dev path = the in-browser extractor running on the live scene; build path = [`node-harness.js`](packages/plugin/src/node-harness.js) + [`mock-webgpu.js`](packages/plugin/src/mock-webgpu.js) re-extracting with a minimal scene. Scene differences (light count, fog, shadow casters) can change the artifact shape; `pnpm verify` catches *some* of this but doesn't systematically diff "what dev captured" against "what build re-extracts."

**Why it blocks evolution/fidelity.** Silent drift between the two extraction paths is a correctness hazard that can mask itself as a per-example bug.

**Change.** Have `pnpm verify` (or a dedicated check) diff dev-captured vs build-re-extracted artifacts across the example corpus and fail on shape divergence; document explicitly which scene properties are *allowed* to differ.

**Status.** The first two wedges have landed. [`packages/contract/src/artifact-shape.js`](packages/contract/src/artifact-shape.js) exports `fingerprintArtifactShape` / `diffArtifactShapes` for shader-stage, binding, byte-layout, uniform-plan, variant, compute, and internal-pass topology while intentionally ignoring WGSL, UUIDs, hashes, and live numeric snapshots. [`packages/plugin/test/unit/extractor-convergence.test.js`](packages/plugin/test/unit/extractor-convergence.test.js) asserts both Node-harness repeatability and exact structural convergence between a genuine browser-captured getting-started artifact and a Node re-extract of the same scene. `pnpm verify` fingerprints every checked artifact and reports empty shapes. Corpus-wide browser/Node re-extraction remains outstanding.

**First fixture (done).** Shared shape fingerprint + Node stability guard + browser/Node getting-started convergence + verify wiring.

**Next step.** Grow the small committed fixture set toward representative shadows, compute, postprocessing, and variants. Keep this as a dedicated deterministic convergence test rather than making structural `pnpm verify` initialize WebGPU for every artifact directory.

**Files.** [`packages/contract/src/artifact-shape.js`](packages/contract/src/artifact-shape.js); `packages/plugin/src/cli/verify.js`; `packages/plugin/src/node-harness.js`; `packages/plugin/test/unit/extractor-convergence.test.js`.

---

### P2.11 — Document & converge the aux artifact pipeline

**Symptom.** Two registration/loading systems: [`precompile-marker.js`](packages/runtime/src/precompile-marker.js) → `apply-precompiled` for user materials, versus [`aux-marker.js`](packages/runtime/src/aux-marker.js) — the largest file in the runtime — → [`aux-loader.js`](packages/runtime/src/aux-loader.js) + [`aux-capture.js`](packages/plugin/src/aux-capture.js) for three.js internals. Both aux files are capped by [`scripts/module-budget.json`](scripts/module-budget.json). aux-loader carries texture-wiring predicates (`wireViewportTextureRefs`, `attachPostprocessTextureRefs`, `bindAuxConfig`) overlapping [`slim-support/artifact-texture-wiring.js`](packages/runtime/src/slim-support/artifact-texture-wiring.js) and [`postprocess-wire.js`](packages/runtime/src/slim-support/postprocess-wire.js). Neither aux file appeared in this document before 2026-06-09. Shape-fallback warnings fire once per `<shape>:<configHash>` then fall back silently.

**Why it blocks evolution/fidelity.** Two of the five largest runtime files have no documented architecture or review bar; the verified genuine duplication is a handful of texture-wiring predicates (the split registration models are intentional), but wiring fixes can land in the wrong copy, and stale-hash bugs are invisible after the first warning.

**Change.** Keep the two registration models; document their contract here; make aux-loader consume the `artifact-texture-wiring` predicates; add an aux debug hook per §P3.12 (mirror `setTextureResolutionDebugHook`).

**Status (2026-07-13).** The CubeRenderTarget wedge puts shared hashing and
texture-evidence vocabulary in `@tsl-precompile/contract`, while the dev-only
temporary graph, CubeCamera, compile-lock, restoration, and disposal lifecycle
live in the named
[`auxiliary/cube-render-target-capture.js`](packages/runtime/src/auxiliary/cube-render-target-capture.js)
module. `aux-marker.js` only discovers inputs, requests capture, registers, and
persists results for this shape. This is the first shape-specific extraction
from that orchestrator; the broader texture-wiring convergence remains open.

**First step.** Write the doc section + migrate one duplicated predicate cluster to the shared slim-support module behind existing tests.

**Files.** [aux-marker.js](packages/runtime/src/aux-marker.js), [cube-render-target-capture.js](packages/runtime/src/auxiliary/cube-render-target-capture.js), [aux-loader.js](packages/runtime/src/aux-loader.js), [aux-capture.js](packages/plugin/src/aux-capture.js), [artifact-texture-wiring.js](packages/runtime/src/slim-support/artifact-texture-wiring.js), [postprocess-wire.js](packages/runtime/src/slim-support/postprocess-wire.js).

---

### P2.12 — Startup hydration caching pass

**Symptom.** Hydration repeated work per material: WGSL source re-concatenated and regexes recompiled per binding probe; `uniformPlan` re-walked via `Array.find` per uniform-buffer binding; variant selection re-scanned `Object.values(artifact.variants)` per call; snapshot textures cached under a collision-prone shape key; LTC sources retained as boxed JSON arrays after texture build.

**Why it blocks evolution/fidelity.** 100ms-class time-to-first-frame overhead on texture-heavy materials and retained memory in long dev sessions; each future binding kind inherits the same uncached patterns.

**Status (2026-06-09).** Wedges landed with the audit: per-artifact shader-source + query memo ([`hydrate/texture-resolver.js`](packages/runtime/src/hydrate/texture-resolver.js) `cachedShaderQuery`), `(group,binding)→planEntry` memo + variant-view memo keyed on the registry's replace-on-grow `variants` object ([`hydrator.js`](packages/runtime/src/hydrator.js)), snapshot identity key ([`hydrate/texture-snapshot.js`](packages/runtime/src/hydrate/texture-snapshot.js)), LTC typed-array swap ([`hydrate/builtin-textures.js`](packages/runtime/src/hydrate/builtin-textures.js)).

**Next step.** A per-artifact hydration context object built once in `hydrateRuntimeBindings()` to carry these memos explicitly (instead of module-level WeakMaps) when the §P0.2 source/dynamic descriptor table work touches the same files; release/dedupe snapshot JSON arrays after GPU upload (blocked on the `Array.isArray(snapshot.data)` guards spread across hydrate/ and aux paths).

**Files.** [texture-resolver.js](packages/runtime/src/hydrate/texture-resolver.js), [hydrator.js](packages/runtime/src/hydrator.js), [texture-snapshot.js](packages/runtime/src/hydrate/texture-snapshot.js), [builtin-textures.js](packages/runtime/src/hydrate/builtin-textures.js).

### P2.13 — Stage the dev capture server's trust boundary

**Symptom.** [`dev-capture-server.js`](packages/plugin/src/dev-capture-server.js) is the only
place in the project where an untrusted browser POSTs into a local process that writes files.
It owns origin/protocol checks, a streaming byte ceiling, JSON parsing, payload schema
validation, family-envelope validation, legacy payload migration, and atomic family publishes —
all interleaved in one module, with request handling and policy in the same call frames. The
invariants are well documented in comments; they are not individually addressable.

**Why it blocks evolution/fidelity.** This is the highest-consequence file per line in the repo,
and it is the one whose correctness is hardest to review, because a reviewer cannot look at the
size limit without also reading the publish logic. A regression here is a local-file-write bug,
not a rendering artifact.

**Change.** Extract the boundary policy into ordered, individually testable stages so each
answers exactly one question, and leave the module as the transport that runs them:

1. **transport guard** — is this request allowed to speak to us at all? (method, origin,
   protocol, content type)
2. **size/stream limit** — bounded read; refuse before buffering.
3. **parse** — bytes to JSON, with the decode failure surfaced as a client error.
4. **payload validation** — is this a well-formed capture payload?
5. **family-envelope validation** — is this a coherent, non-colliding artifact family?
6. **atomic publish** — write to a temp path and rename, or fail without partial state.

**Status (2026-08-02).** Stages 1–3 extracted into
[`dev-capture-request.js`](packages/plugin/src/dev-capture-request.js) with direct unit tests;
the server now calls them and keeps validation and publishing. Stages 4–6 are the next wedge.
Capped by [`scripts/module-budget.json`](scripts/module-budget.json).

**First step.** Done — see status. Next: lift family-envelope validation out behind the same
seam, since it is pure and already has downstream tests to compare against.

**Files.** [dev-capture-server.js](packages/plugin/src/dev-capture-server.js),
[dev-capture-request.js](packages/plugin/src/dev-capture-request.js).

### P2.14 — Split `precompile-marker.js` into extractor / transport / installation

**Symptom.** [`precompile-marker.js`](packages/runtime/src/precompile-marker.js) has the highest
branch density of any non-vendored runtime file and is second only to `aux-marker.js` in size,
yet before 2026-08-02 it had **no entry in this document at all** — hydrator (§P0.2), aux-marker
(§P2.11) and three-rewrite (§P0.5) were all tracked and it was not. It owns three separable
responsibilities in one module:

- **extractor driving** — running the dev-mode extractor over marked materials, the synthetic
  render guard (`__tslpSyntheticRenderActive`), observation windows and fallback timing
  (`__TSLP_PRECOMPILE_OBSERVE_TIMEOUT_MS__`, `__TSLP_AUTO_FALLBACK_DELAY_MS__`).
- **capture transport** — the pending counter (`__tslpPrecompilePending`), POSTing captures to
  the dev capture server, and the outcome/retry handling that pairs with §P2.13.
- **marker installation** — `.precompile(name)` / `autoMark` constructor interception and the
  call-site ownership bookkeeping the staleness gate depends on.

**Why it blocks evolution/fidelity.** This is the same failure mode §P0.2 documents for the
hydrator, one stage earlier in the pipeline: every new capture feature lands in the orchestrator
because there is no other obvious home, and the branch density makes each addition harder to
reason about than the last. It also sits directly on the staleness gate's call-site ownership
layer, so a mistake here is a *silent* correctness bug — a stale artifact that still validates.

**Change.** Three modules behind the current public surface, split in the order above:
`precompile-extract.js` (drive + guard + timing), `precompile-transport.js` (pending counter +
POST + outcome), and `precompile-marker.js` retained as installation plus the thin orchestrator
that wires the other two. No behavior change; the module's exports stay put.

**First step.** Take the transport slice first. It is the most self-contained (its state is one
counter and one fetch path), it is the piece §P2.13 has to interoperate with, and it can be
tested without a renderer.

**Ratchet.** Capped by [`scripts/module-budget.json`](scripts/module-budget.json) at its
2026-08-02 size so it cannot regrow while the split is staged, and so the reclaimed space is
ratcheted away as each slice lands.

**Files.** [precompile-marker.js](packages/runtime/src/precompile-marker.js),
[dev-capture-outcome.js](packages/runtime/src/dev-capture-outcome.js),
[apply-precompiled-common.js](packages/runtime/src/apply-precompiled-common.js).

---

## P3 — cleanup (low risk; do alongside the above)

### P3.11 — Stub & dead-code hygiene
- [`slim-stubs.js`](packages/runtime/src/slim-stubs.js): close the PassNode/Node coverage gaps (track via the "[tsl-precompile/slim] X is not available" load-smoke errors). Resolve `ShadowBaseNode`'s inert stub together with P1.6.
- [`mock-webgpu.js`](packages/plugin/src/mock-webgpu.js): document the no-readback limitation loudly (scenes doing `mapAsync` get zeros and are flagged for real-browser re-render).
- `emit-updater.js`: keep the default-last invariant in the `switch`-after-`default` case.
- The `frame.object.viewPosition` / `frame.object.direction` non-standard-property assumption — verify the slim render loop populates `frame.object` before the updater runs, or fix the source.
- Prune the many untracked `visual-*` / `debug-*` JSON files under `packages/examples/batch/results/`.

### P3.12 — Diagnostic-hook formalization
`__tslpHarnessDiagnostics`, `__TSLP_DEBUG_LIGHT_LINKAGE`, `__TSLP_DEBUG_SHADOW_BINDINGS`, `__TSLP_DEBUG_SHADOW_COVERAGE` etc. were ad-hoc globals with no schema. Fold them into the `slim-support` module's debug API (depends on P0.1) so they're documented, schema'd, and testable. Progress (2026-06-09): the `writeColor` harness probe is removed from [`writers.js`](packages/runtime/src/writers.js); shadow-depth rebinders now accept a `diagnosticsEnabled` predicate so payload construction (not just recording) is gated on `__TSLP_DEBUG_SHADOW_BINDINGS`. The `seedUniformBufferSnapshots` probe in `hydrator.js` still writes to the global bag.

**Status (2026-08-02) — the direction is inverted; the remaining work is migration, not
discovery.** The 2026-08-02 audit found this item was losing: hooks were being formalized
retroactively and were spreading faster than the item absorbed them.
[`@tsl-precompile/contract/diagnostic-globals`](packages/contract/src/diagnostic-globals.js) now
declares every `__tslp*` / `__TSLP_*` name installed on a global object, and
`pnpm test:diagnostic:globals` fails CI on an installed-but-undeclared name, a
declared-but-uninstalled name, a hook whose surfaces drift, and any hook reaching shipped
runtime/plugin code without a written purpose. **A new hook must be declared before it can be
used.**

Declaring the whole set also corrected the audit's own reading of the problem: the sprawl is
overwhelmingly *harness*-side. Only 15 of the declared hooks are installed by runtime or plugin
code; the rest never leave the e2e/replay tooling. That makes the remaining P3.12 work much
smaller than the raw count suggested — fold those 15 into the `slim-support` debug API and route
them through `installDiagnosticGlobal()` / `readDiagnosticGlobal()`, and the product surface is
done. Run `pnpm test:diagnostic:globals` for the current split.

### P3.13 — Bundle surface diet: stubs, core entry, artifact payloads

**Symptom (as found 2026-06-09).** The slim gzip gate had been relaxed 263 → 420 KB against a stale checked-in bundle; [`slim-stubs.js`](packages/runtime/src/slim-stubs.js) (1,430 LOC) always ships — Proxy chains, full Node protocol stub, stateful PassNode stub — via slim-entry; the main barrel [`index.js`](packages/runtime/src/index.js) re-exports dev-only modules (aux-marker, graph-hash) so root-import users pull them in; the runtime package declares no `sideEffects` field; on-disk artifacts are pretty-printed with inline WGSL although [`wgsl-optimize.js`](packages/plugin/src/wgsl-optimize.js) implements minify/dedupe for virtual modules.

**Status (2026-06-09).** The headline regression is resolved at the bundler: the `threeBareAlias` + `webglFallbackStub` rollup wedges (see the 2026-06-09 audit refresh in [evolution-archive.md](./evolution-archive.md)) cut the bundle ~407 → 238.8 KB gzip, and the gate is re-tightened to 250 KB with the stale comments fixed ([`slim-bundle.test.js`](packages/plugin/test/unit/slim-bundle.test.js)). The `TSLP_ANALYZE=1` rollup flag prints a per-module breakdown — use it before any future gate bump. Refuted during verification: lazy-importing aux-loader from slim-entry (it is exported slim API, not a one-call dependency).

**Status (2026-07-13).** The single gzip constant is replaced by the machine-readable [`slim-budget.json`](packages/runtime/build-tools/slim-budget.json) and shared [`slim-bundle-analysis.js`](packages/runtime/build-tools/slim-bundle-analysis.js). The dedicated `pnpm test:slim:budget` gate performs one strict prebuilt Rollup build plus minimal and advanced production `slim: 'source'` Vite builds; it caps raw/gzip bytes, compiler residue, stock-adapter residue, retained Node module count/bytes for every profile, and split bare-Three identity. `pnpm analyze:slim` emits deterministic JSON for CI or trend tooling. After the graph-free shadow, CubeRenderTarget, and Node-core wedges, current observations are 768,403 raw / 210,865 gzip bytes and zero retained Node modules / zero rendered bytes for prebuilt. Minimal and advanced source are 137,680 and 145,631 gzip bytes, also with zero Node residue. All compiler, stock-adapter, and duplicate-identity counts are zero. The expensive three-build check stays outside the quick unit tier and runs once in Linux CI and `release:check`.

**Status (2026-07-15).** The production-helper profile now proves that generated
`/apply`, `/writers`, `/generated/light-writer`, and
`/slim-support/node-dependencies` imports converge on the prebuilt singleton:
exactly one runtime module, one prebuilt module, and zero `runtime/src` modules.
Both renderer paths construct the graph-free `ReplayNodeLibrary`; stock
`LightsNode`, `NodeLibrary`, and `StandardNodeLibrary` remain forbidden residue.
Replay lighting uses its own small `slim-replay-lights-node.js`, independent of
the broad stubs. Policy `slim-three-policy@10` also rewrites the exact r184 base
`Loader` constructor so texture tracking installs only when a concrete subclass
is instantiated. Allocation-only stub and Node-material factory initializers are
pure, allowing guarded source consumers to omit unused compatibility shells;
the checked prebuilt intentionally retains the complete exported surface.

The report captured with this 2026-07-15 wedge was prebuilt 765,909 raw /
210,466 gzip bytes (338 modules), helper consumer 578,509 raw / 163,030 gzip,
minimal source 491,728 raw / 137,472 gzip (180 modules), and advanced source
520,230 raw / 145,111 gzip (190 modules). Treat these as historical; the one
current report is recorded in the runtime-identity section above.

**Core entry wedge (2026-07-13).** `@tsl-precompile/runtime/core` now exposes
one explicit additive AOT surface: `__applyPrecompiled`, the three public user-
artifact registry operations, and the twelve uniform writers. It does not
re-export the dev marker, auxiliary capture, hydrator, slim-support, internal
apply helpers, or registry test reset. Generated modules remain on the narrower
`/apply`, `/loader`, and `/writers` entries. Its declarations are self-contained
and do not import the root barrel's dev-only `three.Material` augmentation.
Focused identity, shared-registry, declaration-isolation, packed-runtime,
NodeNext type-resolution, and Rollup closure tests lock that boundary.

**Conditional setup entry wedge (2026-07-13).** The recommended
`@tsl-precompile/runtime/setup` subpath now has explicit Vite development and
production halves. Development imports the resolved `three/webgpu` namespace
inside the package and preserves synchronous marker installation, so app code
uses named Three imports and calls `setupPrecompile({ renderer })`. Production
resolves to a single inert module and never imports `setup.js`,
`precompile-marker.js`, `aux-marker.js`, Three, TSL, or any builder path. The
default condition also resolves to production, so unsupported/custom bundler
condition sets fail closed instead of accidentally retaining the dev closure.
The legacy root export remains unchanged for compatibility, but the canonical
docs, runnable examples, site snippet, and fresh packed-project fixture now use
the conditional subpath. Focused resolution, synchronous-dev behavior,
production-contract, package-contents, declaration, Vite-build, and Rollup
closure checks lock the boundary; the production microbundle is capped at
4 KiB raw / 1.5 KiB gzip and currently measures 759 B raw / 432 B gzip.

**Conditional apply entry wedge (2026-07-13).** The transform-owned
`@tsl-precompile/runtime/apply` subpath now resolves to a development wrapper
that runs the shared artifact-schema validator and a production/default entry
that omits that registry. The production implementation still enforces the
module hash and recomputes the captured source-graph hash; only the generic
schema pass that is already exercised during development and repository
verification is split away; plugin code generation keeps its existing
fail-closed kind gates. On the real getting-started source build this removes
about 23.8 KiB raw / 6.0 KiB gzip while retaining zero compiler,
stock-adapter, or Node-runtime modules.

**Artifact parse/payload wedge (2026-07-16–17).** Capture serialization now drops
private `_...` sidecars before their values (and therefore a Three object's
`toJSON`) can be visited; the dev server repeats that guard before validation
and persistence. Generated artifact literals omit the validated-but-derived
`dynamicBindings` payload, then reconstruct the public root/variant views from
references into `uniformPlan`; compact consumers can still index the
texture-shaped subset directly from that plan. Emission restores the
extractor's schema-known flat/ordered plan
aliases, hoists profitable shared records, and packs sufficiently large,
exactly representable typed-array snapshots into raw little-endian base64
constants. The tiny generated decoder uses a direct byte loop and returns
ordinary Arrays for the current runtime contract. This is synchronous raw-byte
materialization, not compression/decompression; unknown paths, lossy numeric
conversions, and small or unprofitable aggregate payloads retain ordinary JS
literals. In a one-off local Node/Babel benchmark on the checked galaxy
outlier, the generated module fell from
6,468,938 to 2,146,838 raw bytes (2,614,865 to 1,202,991 gzip); an alternating
Babel parse benchmark fell from about 415 to 12.4 ms while synchronous
materialization added about 5.2 ms. All 640,000 values remained `Object.is`
exact, including four logical Float32 zero/one buffers represented internally
by narrower raw Uint8 scalars.

**Generated scene-data removal (2026-07-17).** The checked galaxy outlier was
not a multi-megabyte shader: its minified WGSL is 4,032 bytes, while eight
anonymous 80,000-value instance-attribute snapshots occupied 99.23% of the
generated module. Development setup now replaces only Three r184 `RangeNode`'s
above-uniform-limit attribute branch with a versioned local deterministic PRNG
without reading or replacing `Math.random`, verifies the resulting live
Float32 attribute byte-for-byte, and lets capture
persist the tiny `{ kind: 'range@1', seed, min, max }` recipe after a second
extraction-time verification. Scalar and uniform-buffer paths retain their
stock random stream. Runtime hydration fills the final interleaved typed array
directly from that recipe; there is no base64, decompressor, temporary boxed
Array, or second copy. Four `instanceMatrix` columns likewise retain no
snapshot only when extraction proves exact shared-array/stride/offset
provenance as `instance-matrix@1` references, after which runtime binds shared
live object-array views with source-version propagation. Changed Three
internals or unverifiable data fail closed to the existing snapshot path.

In a one-off local Node benchmark on the galaxy payload shape after recapture,
the generated module models at
17,128 bytes raw / 4,175 gzip instead of 2,150,915 / 1,204,753. Median module
emission fell from about 100 ms to 0.47 ms and Babel parse from 7.6 ms to
0.54 ms. Direct generation of its four 20,000-instance range buffers takes
about 2.7 ms in the checked Node runtime, versus roughly 9.5 ms for the prior
raw-base64 materialization plus hydration copy. Existing captures cannot be
retrofit because ambient `Math.random()` results do not reveal a seed; they
must be recaptured. The previously cited 475,090-byte raw bundle was the pooled
hybrid model for 62 artifact files / 106 non-empty shader stages, not one
shader.

**Generated selector-adapter boundary (2026-07-17).** Canonical artifact
traversal now visits user roots, auxiliary arrays, variants, and embedded
material-compute kernels once. Generated modules materialize projection and
bounded sibling-matching logic as a non-enumerable contract sidecar, while the
checked renderer retains only a small `project`/`match` consumer and legacy
unsigned fallback. Manually registered signed JSON without materialization
fails loudly instead of pulling the analysis into every runtime. The browser
capture harness explicitly rematerializes POST-parsed and structured-cloned
artifacts because Symbols cannot survive JSON or structured clone. Generated
modules resolve those build-time materializers through the plugin's own
contract dependency, so applications do not need an undocumented direct
`@tsl-precompile/contract` install or workspace hoist.

**Temporal identity and visual-evidence integrity (2026-07-17).** The
RenderObject observer records the exact active TRAA unjittered projection
object before r184 clears `VelocityNode.projectionMatrix`; deferred extraction
classifies only the anonymous UniformNode that retains that identity. Equal
matrix snapshots remain live uniforms. The SSGI ball-pool canary improved to
36.3 dB and its capture/replay velocity textures are byte-identical. Separately,
the e2e writer now removes both old screenshot counterparts before publishing
the images available from the current run. Fresh point/spot PCF-soft reruns are
byte-identical, proving their prior regression rows were mixed stale evidence,
not a shadow-renderer difference.

A read-only format benchmark reserves `.tslb` for a future real **TSL binary
bundle**, never for renamed or compressed JSON. The candidate uncompressed
hybrid uses a 32-byte `TSLB` header, 16-byte section records, compact metadata,
raw minified UTF-8 WGSL, and aligned little-endian typed sections. Across 62
checked non-batch artifacts it modeled at 597,241 bytes versus 810,163 bytes of
compact JSON (475,090 bytes with a manifest-scope raw WGSL pool); targeted full
resolve measured 0.974 ms versus 1.56 ms compact-JSON parsing. The galaxy
outlier modeled at 2,572,456 versus 6,471,576 bytes and 0.035 versus 24.74 ms.
The format must resolve only contract-proven fields and keep typed sections as
immutable views; a generic recursive resolver measured slower on the small
corpus, and eagerly boxing the galaxy views into Arrays cost 9.93 ms. Keep
product capture artifacts as readable `.json`, preserve logical artifact
hashes independently of byte encoding, and introduce `.tslb` only with a
dual-reader migration that does not make today's synchronous apply/hydration
APIs depend on an async fetch waterfall. Run-scoped campaign evidence is a
separate transport/storage plane and may compress those JSON graphs without
changing the product artifact format.

**Run-scoped evidence storage (2026-07-30).** The browser campaign runner no
longer persists full user/auxiliary graphs as pretty-printed JSON. The focused
`e2e-artifact-output.mjs` boundary serializes compact JSON and writes
deterministic gzip with the fast level-1 policy and a zero timestamp through
the existing atomic, path-contained output primitive. Evidence descriptors
continue to hash stored bytes, now carry explicit `contentEncoding: "gzip"`
and `uncompressedBytes`, and use `.json.gz`. Replay verifies the generic
run/path/size/hash descriptor before validating the storage contract, then
uses a 512 MiB maximum and the exact declared output size to bound
decompression. Unknown encodings, suffix drift, corrupt/truncated streams,
invalid UTF-8/JSON, and expansion beyond either bound fail closed. Legacy
schema-2 `.json` evidence remains readable only when both compression fields
are absent. The codec itself participates in the harness source fingerprint
and is required by coverage aggregation, so storage-policy drift makes
evidence stale rather than silently changing its interpretation.

**Remaining.** Do not add a package-wide `sideEffects: false`: the focused build
experiment removed required bootstrap and policy effects. Consider an explicit,
audited side-effect manifest only if profiling justifies it; otherwise prefer
narrow feature entries and pure allocation annotations. Deeper source feature
entries remain an option when the analyzer identifies a dominant closure.
Opt-in on-disk artifact minification remains low value because dev artifacts are
gitignored test fixtures.

**Files.** [core.js](packages/runtime/src/core.js), [core.d.ts](packages/runtime/types/core.d.ts), [core-entry.test.js](packages/runtime/test/core-entry.test.js), [package.json](packages/runtime/package.json), [slim-stubs.js](packages/runtime/src/slim-stubs.js), [slim-entry.js](packages/runtime/src/slim-entry.js), [index.js](packages/runtime/src/index.js), [slim-bundle.test.js](packages/plugin/test/unit/slim-bundle.test.js).

---

## Sequencing

```
P0.4 (hasher dedupe) ──┐  first shared-module wedge landed
P0.3 (shared contract) ─┼─► both feed P0.2 (hydrator split) and P1.7 (dynamic bindings)
                        │  texture-props + KINDS/schema + dynamic descriptors landed
P0.1 (slim-support) ────┴─► enables P1.6 (full-renderer policy) and P3.12 (debug hooks)
                           live-scene-index + PMREM orchestration wedges landed; compute/full-renderer next

P0.5 (three.js seam)  — exact r185.1 baseline + strict locked/latest rewrite/slim matrix landed; next-version vendor diagnostics next
P2.9 (coverage)       — shared PSNR + config/tier data + CI tier gate landed; expand/stabilize next
P2.8 (codegen)        — parser guard landed; writer table/AST codegen next
P2.10 (verify) , P3.* — opportunistic
```

Suggested order from here (revised 2026-06-09; P1.8 is resolved and the first P1.9/P2.12 wedges landed with the audit): **P0.2 hydrator-shape decision (orchestrator+variants vs `hydrate/variants/` extraction) + source/dynamic descriptor table + storage-texture decision**, then **P1.7 completion designed together with P1.9** (uniform-slot/storage descriptors + light-cache invalidation + extending the render-scoped memo — the largest verified per-frame payoff), then **P0.1 remaining pass/shadow productization + the §P2.11 aux convergence** (do alongside any aux bugfix, not standalone), then **P2.10 dev/build extractor convergence**, with P0.5 vendor diagnostics, P3.13 remaining bundle work, and P2/P3 cleanup folded in as touched areas stabilize.

## What "done" looks like

- Slim-bundle fidelity logic lives in `@tsl-precompile/runtime/slim-support` with unit tests; `run-e2e.mjs` is a thin caller and an adopter can get PMREM / texture rebinding / compute sync by importing the module.
- `hydrator.js` is < ~1k LOC of orchestration; binding kinds and texture-resolution strategies are individually testable; a full texture-resolution miss warns instead of binding white.
- There is one `KINDS` registry, one `TEXTURE_PROPS` list, one artifact schema; the build fails on an unknown kind; the runtime validates artifacts in dev.
- One `graph-normalize` module; a parity test guards plugin↔runtime hash agreement.
- A nightly job builds the slim bundle against `three@latest` and fails on any rewrite fallback; the slim-vs-full-renderer policy is written down.
- `vite build && vite preview` works end-to-end for the canonical examples (ocean + getting-started), with Inspector + RenderPipeline + bloom + PMREM env all rendering identically to dev mode; the four gaps in §P1.8 (precompileAuxiliary prod no-op, aux injection un-gated from slim, Inspector preview-mode behavior, slim Node method-chain fallback) are closed and covered by a Playwright smoke.
- Coverage is one deterministic number from one code path, with a checked-in tier-1 PR gate.
