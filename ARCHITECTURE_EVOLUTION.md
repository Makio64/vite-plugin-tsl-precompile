# Architecture Evolution — structural debt & the path to 100% fidelity

Companion to [ARCHITECTURE.md](./ARCHITECTURE.md) (what the system is).

This file is the **structural** to-do list: the changes that make the plugins easier to evolve and make 100% visual fidelity *reachable* rather than a per-example grind. The latest generated coverage summary currently reports **163 / 226 graded examples** at PSNR >= 30 dB, and that number moves quickly; refresh `packages/examples/batch/results/coverage-summary.md` before quoting it externally. The remaining work is no longer mostly limited by individual rendering bugs — it is limited by where the fidelity logic lives, how the modules are factored, and how brittle the three.js coupling is. Fix the structure and the per-example work gets cheaper, safer, and shippable to real users.

**Current read.** This roadmap is good to use, but it is not "done." The first shared-contract, graph-normalization, slim-support, texture-resolution, hydrator-rebinder, codegen-parse, coverage-config, strict-rewrite, and production-preview wedges have landed (§P1.8 closed end-to-end on 2026-05-14 — ocean `vite build && vite preview` is green and locked in by the preview-smoke CI gate). The unfinished evolution is the second half: move the rest of the harness runtime behavior into `slim-support`, finish shrinking `hydrator.js` into allocation/source/dynamic modules, turn dynamic binding descriptors into emitted/runtime-resolved artifact data, harden the three.js compat matrix, and add a dev-vs-build extractor convergence guard.

Items are ordered **P0 → P3**. Each has: **Symptom** (what's wrong), **Why it blocks evolution/fidelity**, **Change** (target shape), **First step** (a small, low-risk wedge), **Files**.

Last updated: 2026-07-13 (capture/identity/temporal/effect-dependency wedges; previous full audit 2026-06-09).

---

## 2026-07-11 capture/identity spike — staged direction

The real-render observation added in July exposed a simpler target than
reconstructing every render context in a throwaway scene. A mock-WebGPU
generation test now harvests the `NodeBuilderState` produced by one ordinary
render and extracts complete WGSL plus light, shadow, depth-texture, and fog
sources without a second compile. The private Three seam is centralized in
[`packages/plugin/src/vendor/render-object-observer.js`](packages/plugin/src/vendor/render-object-observer.js), which uses a Symbol-backed subscriber registry; `compileTSL` consumes that adapter instead of replacing `NodeManager.getForRender` itself.

`compileTSL` can now consume a completed real-render harvest. The observer
freezes request-time target/face/mip/MRT state, joins cached or newly built
`NodeBuilderState` objects by material plus Three cache key, and exposes one
atomic family per material. Extraction prefers a supplied complete family and
falls back to the whole synthetic family when any requested sibling is
incomplete; it never mixes a partial real family with synthetic siblings. The
production marker has **not** switched to handing this harvest across its real
render yet, so synthetic capture remains its default compatibility path. That
marker handoff is the next adoption wedge, especially for multi-call epochs
such as the six CubeCamera faces.

Identity is now split in the first useful way: `__hash` is derived from runtime
artifact content (shaders, binding/layout data, uniform plans, render state, and
variants), while `sourceGraphHash` remains source provenance. Dev captures also
record stable call-site owners and a conservative whole-module revision; build
rejects a changed or unobserved owner. `autoMark` relies on that build-time gate
because it rewrites the constructor before later `*Node` assignments, making an
adoption-time graph comparison inherently too early. Still open: extend module
revision to a transitive local-import closure, and use render-context
fingerprints only for live variant selection rather than treating stored
context as source freshness.

**Live uniform identity wedge (2026-07-13).** Anonymous `uniform.live` slots now
serialize artifact-local `liveNodeId` identity, plus an exact `nodePath` when the
UniformNode is reachable from a material `*Node` root. The slim TSL `uniform()`
facade registers runtime UniformNodes in a weak, Symbol-backed ledger, and
`live-node-sidecars.js` reconnects repeated identities across the top-level
artifact and every variant before falling back to name/value heuristics. This
preserves graphs such as reflection's two equal-valued effectors reused as
`A/B/A/B`; JSON previously reduced all four slots to indistinguishable `-0.2`
snapshots. The e2e harness now calls the product helper instead of carrying a
second matcher. Focused reflection still remains below the visual gate: the
identity ledger updates correctly at later ticks, but its animation clock and
the capture clock are not yet the same logical frame. That remaining issue is
temporal scheduling/clock ownership, not uniform identity.

**Shared light identity wedge (2026-07-13).** Light, shadow, and owned shadow-
depth sources now reference one variant-local `light-identity@1` table instead
of matching every scalar/vector slot independently. Capture records durable
UUID/application-key/name/type metadata plus complete world-space and light-
property evidence; process-local `Object3D.id` remains only an ordering input
and is never serialized. Generated and generic updaters use the same resolver,
prefer Three's active render-light list, enforce one-to-one claims, and share
those claims with shadow-depth and anonymous shadow-matrix consumers even when
generated and parsed tables are distinct objects. Legacy UUID/snapshot/index
descriptors remain supported. This closes the scalar-first and reordered-light
failure mode behind selective lighting and multi-light shadow replay; remaining
target/pass mismatches belong to real RenderObject
topology capture rather than light-slot heuristics.

**Shadow fallback lifecycle wedge (2026-07-13).** The public standard-shadow
fallback now has explicit ownership and disposal rather than relying on an
opaque `WeakMap` lifetime. Proxy geometry, generated stand-in materials,
cloned `LightShadow` maps, and internal discard targets are released on
topology/renderer changes and explicit teardown; application-supplied
materials and targets are never owned. Source shadow map/camera/matrix
references are restored only when they still point at the proxy resources.
`createSlimSceneSupport()` uses an iterable private cache, can dispose one
scene or all scenes, and waits for an in-flight shadow render to settle before
disposing its full-renderer fallback. A tombstone also makes an immediate
repopulation wait for that cleanup instead of overlapping the old renderer.

**Exact render-target topology wedge (2026-07-13).** The shared graph-free
selector now describes the actual render surface rather than only a loose list
of attachments. It distinguishes default, output, renderer-owned output
intermediate, and offscreen 2D/cube/array/3D targets; snapshots the active cube
face and mip before Three reuses the mutable `RenderContext`; normalizes the
effective sample count; and records attachment names/formats plus ordered MRT
names and replayable blend modes. Width and height remain live resource state,
so target resize does not manufacture a shader variant. This is the contract
prerequisite for harvesting every real RenderObject family, especially the six
faces of a dynamic cubemap.

**Logical temporal-frame wedge (2026-07-13).**
[`slim-support/temporal-frame.js`](packages/runtime/src/slim-support/temporal-frame.js)
now gives slim and full fallback renderers one explicit application-frame key
and an `advance: false` maintenance-render mode. Velocity camera/object writers
and skinned previous/current bone buffers consume that key before falling back
to Three's per-render `frameId`; nested sync/async scopes restore renderer state
on success or failure. `createSlimSceneSupport()` exposes the scope, and the e2e
RenderPipeline shares it with its full fallback while loader-forced renders are
non-advancing. Focused runtime tests cover multi-renderer sharing, nesting,
failures, velocity matrices, and skinned buffers. The two visual canaries did
not materially change (`motion_blur` 29.65 dB, AO 28.39 dB), which narrows their
remaining issue further: the harness still executes too many pass stages per
logical frame (AO's producer/consumer order and motion blur's four pipeline
renders), rather than merely keying history to the wrong renderer frame ID.

**Explicit live-effect dependency wedge (2026-07-13).** Closure-backed TSL
contexts are now a first-class live graph plane instead of harness-only object
properties. [`slim-support/node-dependencies.js`](packages/runtime/src/slim-support/node-dependencies.js)
attaches deduplicated, non-enumerable Symbol sidecars with optional role
metadata; effect discovery follows those edges and may also start from the
extractor-observed `_liveUpdateBeforeNodes` before JSON removes the live
sidecar. Slim `builtinAOContext()` / `builtinShadowContext()` stubs and the e2e
TSL facade use the same product helper. Focused capture coverage proves that a
GTAO node absent from the reflected output graph still emits its auxiliary
artifact, and the replay frame-effect walker follows the same edges. The narrow
visual canaries complete without replay errors (AO 28.59
dB; SSS remains a disabled-gate diagnostic at 4.57 dB), so this closes effect
visibility, not execution fidelity. The next boundary is an explicit effect
execution plan; renderer ownership, owned targets, inputs, and
once-per-logical-frame scheduling remain after that first plan wedge.

**Single context-wave execution-plan wedge (2026-07-13).**
[`slim-support/postprocess-execution-plan.js`](packages/runtime/src/slim-support/postprocess-execution-plan.js)
now recognizes one deliberately limited pass order from handler metadata.
GTAO declares its input pass and `pass-context` placement; TRAA declares
terminal placement. The planner follows explicit dependency edges to identify
the AO-consuming scene pass and refuses the optimized path when a pass is
unplaced or a legacy effect is not represented. The e2e caller then executes
`prePass -> GTAO -> scenePass -> TRAA`, retaining the old path for unsupported
graphs. The focused AO run confirms 25 pipeline calls now perform 50 pass
renders instead of 100 while GTAO and TRAA remain at 25 each. PSNR remains
effectively unchanged at 28.51 dB, so duplicate pass execution is closed as a
logic/performance fault but is not the remaining AO fidelity cause. This is
not a general render DAG; the next safe extensions are explicit target/input
ownership and per-logical-frame execution semantics.

**Owner-scoped postprocess-frame scheduler wedge (2026-07-13).**
[`slim-support/postprocess-frame-scheduler.js`](packages/runtime/src/slim-support/postprocess-frame-scheduler.js)
now keeps successful work claims on a durable pipeline owner and keys them by
the explicit `(frameId, renderId)` pair, so repeated pipeline calls and separate
slim/full temporal scopes cannot advance the same pass or effect twice. Role
conflicts and missing identities fail closed; false, thrown, and rejected work
releases its claim for retry; concurrent async callers share one in-flight
Promise; and consumers can inspect or declare failed producer dependencies.
The batch pipeline maps planned producer/context-effect/consumer/TRAA work onto
those roles. RTT composites that contain a live effect dependency are deferred
until that effect succeeds, replacing the SSGI-specific render-again heuristic
with graph-derived ordering. Target ownership and resize-triggered resource
rebinding remain the next separate stage.

**Closure-backed SSS product path (2026-07-13).** Named imports of
`builtinAOContext` and `builtinShadowContext` are now wrapped by the plugin in
dev and build so the real full-Three context constructors attach the same live
dependency edges as the slim stubs. This closes the capture gap that an
extractor-only fix cannot see: the context's `getAO`/`getShadow` functions keep
their effect inputs solely in JavaScript closures. The SSS handler captures its
single RedFormat material, opts into live uniform overlays, declares pre-pass
producer/context-consumer placement, and rewires captured material-graph depth
to the current pass depth. The focused SSS canary captures an `sss` aux shape,
selects the planned `prePass -> SSS -> scenePass -> TRAA` wave, prepares one
precompiled SSS material, and renders it 33/33 times on the slim renderer with
zero misses, warnings, or replay errors (66 pass renders for 33 pipeline calls).
Its disabled-gate diagnostic remains 4.57 dB, so missing SSS capture/execution
is closed while the example's larger visual mismatch remains independent.

**Compiler-free slim closure audit (2026-07-13).** The important boundary is
now measured from Rollup module IDs instead of minified string fingerprints.
`WGSLNodeBuilder`, `GLSLNodeBuilder`, `NodeBuilder`, their parsers,
`StandardNodeLibrary`, real `NodeMaterial`, and Three's runtime-compiling
`PMREMGenerator` are hard build failures when they contribute rendered bytes;
`NodeBuilderState` was initially retained as a renderer data carrier; the
replay-native manager described below now replaces it with runtime-owned
hydrated state. Two dead paths were removed immediately:
NodeManager no longer catches hydration failure by constructing a generic
NodeMaterial after the backend builder has already been stripped, and the slim
PMREM export is now a constructible compatibility shell which directs actual
generation to the documented full-renderer adapter. A focused PMREM equirect
replay still completes through that adapter. Together these cuts moved the
checked bundle from 916,965 raw / ~249,100 gzip bytes to 876,647 raw / 238,462
gzip bytes (the standard test reports 856.1 / 232.9 KiB).

The builder is therefore no longer the remaining bundle problem. A follow-up
removed RenderPipeline's unused live `renderOutput()` wrapper and replaced the
viewport rebinder's three real `Viewport*TextureNode` dependencies with a
replay-native framebuffer-copy source. The focused AO diagnostic stayed at
28.51 dB and the transmission canary passes at 38.71 dB. The latter extraction
moves the bundle to 877,831 raw / 237,527 gzip bytes and leaves **100 Three
Node/TSL runtime modules / 437.5 KiB rendered before
minification**, rooted mainly in NodeManager scene topology, Background,
RenderPipeline, renderer output/shadow helpers, viewport texture nodes, and XR.
Disposable graph experiments put the next ceiling near 189 KiB gzip for the
same prebuilt public surface, and near 140 KiB for a selective tree-shakeable
source entry; those are directional upper bounds, not committed budgets. The
safe sequence is: (1) give each artifact variant a semantic render-context
selector rather than relying only on Three's private numeric cache key, (2)
replace NodeManager/Lighting and renderer auxiliaries with runtime-owned slim
state adapters, then (3) expose an experimental source entry so applications
pay only for the core/geometry/loaders they import. Dropping those modules
before semantic variant selection risks silently choosing the wrong
lights/fog/environment/shadow WGSL.

**Semantic render-variant wedge (2026-07-13).** The first prerequisite is now
implemented. Capture records one or more canonical `render-object-selector@1`
descriptors for every observed cache entry, using only topology that a
compiler-free RenderObject can reproduce: active attachment formats/count,
MRT outputs, selected lights and shadow kinds, fog/environment presence,
geometry layout, material feature buckets, clipping, instancing/skinning, and
the few renderer/camera modes that change generated shaders. Runtime selects
an exact signed variant before considering Three's private cache identity;
uncaptured, ambiguous, or partially signed families throw typed recapture
errors. Unsigned legacy artifacts keep the old cache-key and MRT-count path.
Variant payload vocabulary is centralized in the contract (including LTC
textures), dynamic-binding descriptors are derived recursively, and a root
generated updater is reused only when the selected uniform plan is identical.
Focused selector, validator, registry, hydrator, shadow-family, rewrite, and
slim-bundle checks pass. The correctness metadata adds about 5.4 KiB gzip to
the prebuilt bundle (892,844 raw / 243,077 gzip bytes); the next manager-adapter
stage is expected to recover that cost and then reduce the retained graph.

**Replay-native Lighting wedge (2026-07-13).** Three's stock `Lighting` and
real `LightsNode` are replaced in slim builds by a graph-free per-scene
registry. Its state retains the public light list, numeric cache-key inputs,
ID ordering used by captured light uniform indices, subclassing, and the slim
node-chain compatibility surface, without constructing a lighting TSL graph.
A bundle guard now fails if either stock module contributes bytes. The focused
`webgpu_lights_selective` capture/replay passes at 46.9 dB, and the checked
bundle moves from 892,994 raw / 243,126 gzip bytes (after the transmission and
clipping adoption fixes) to 886,948 raw / 241,103 gzip bytes. NodeManager is
the next boundary; Background remains a temporary live-graph island until its
own replay adapter can replace graph-hash-based auxiliary lookup.

**Replay-native NodeManager wedge (2026-07-13).** Slim builds now redirect
Three's stock `NodeManager` to a runtime-owned manager that returns the
hydrator's state directly, preserving its per-object `createBindings()` UBO
clones. Replay cache identity is material-scoped and includes both Three's
initial cache key and the canonical semantic selector, so material-bound
rebinders cannot leak across instances or captured topologies. Synchronous,
async, deferred, compute, update scheduling, ref-count deletion, and full-
renderer fallback lifecycles remain available without `ChainMap`, build
queues, or `NodeBuilderState`; fallback release delegates back into the full
manager. A shared fallback-state adapter also builds legacy raw builders and
clones their non-shared bind groups. Hydrated Proxy states explicitly reject
Promise `.then` probing, fixing a latent `compileAsync()` hang. Stock
background/environment/fog/output node construction is isolated in
`slim-replay-scene-nodes.js` for the next auxiliary-adapter stage. The strict
bundle retains 96 Node/TSL modules / 417.2 KiB rendered and measures 887,942
raw / 240,534 gzip bytes (about 0.6 KiB gzip below the Lighting baseline).
The selective-light canary remains green at 46.9 dB. Compute rain still fails
closed on a captured-vs-replay semantic selector mismatch, confirming its
missing particles are a capture/topology parity issue rather than compute
state hydration; that mismatch remains a separate fix rather than a reason to
weaken signed variant selection.

**Replay-native Background wedge (2026-07-13).** Slim builds now redirect
Three's stock `Background` to a captured-pass adapter and prohibit the stock
module from contributing bytes. This fixes a real selection-boundary mismatch:
capture hashes raw `scene.backgroundNode || scene.background`, while the old
runtime re-hashed a generated Texture/Cube/PMREM node wrapper and then silently
fell back to the first background capture. Replay now resolves an explicitly
bound hash exactly, hashes raw inputs against the version domain recorded with
each capture, auto-selects only when one background artifact exists, and throws
a typed ambiguity error otherwise. Signed background selectors intentionally
exclude lights, fog, environment, and shadow state that the sky material cannot
consume while retaining target/MRT topology. Each scene gets an artifact-local
texture-ref map and its own precompiled sky material; compatible direct textures
are wired without replacing CubeUV/PMREM resources with raw sources.
Clear colors, forced color clears, XR blend overrides, alpha premultiplication,
sky geometry/state, replacement, and disposal retain Three's behavior. The
background graph was removed from the temporary scene-node island, cutting the
strict bundle to 92 Node/TSL modules / 396.9 KiB rendered and 887,050 raw /
239,966 gzip bytes. Focused replay canaries pass at 52.81 dB
(`webgpu_custom_fog_background`) and 30.45 dB (`webgpu_cubemap_dynamic`). PMREM
generation remains the next resource adapter rather than being folded into
background selection.

**Replay-native output wedge (2026-07-13).** Renderer output and
`RenderPipeline` now share versioned topology descriptors from the contract.
The renderer-output key covers tone mapping, the active color space, sampled
texture dimension (`2d` versus `2d-array`), and multiview; exposure is removed
from identity because extraction/runtime already update it through the live
`renderer.toneMappingExposure` uniform. The Three rewrite delegates cache-key,
selection, texture-role validation, cloning, replacement, and disposal to
`slim-replay-output.js`, and no longer calls `NodeManager.getOutputNode()` or
mutates a registry artifact across render targets. Renderer-output replay
rejects even a single mismatched configuration instead of falling back by
shape. Dev capture drives the real renderer output pass and correlates the
active private quad by both material UUID and NodeManager cache key before the
caller render target is restored; it never scans the accumulated cache, so an
older target/config cannot be mislabeled and an offscreen caller cannot leak
its working color space into the output hash. RenderPipeline honors
explicit/exact graph hashes; a sole capture is accepted only after its
versioned transform/tone/color metadata exists and matches, while multiple
unresolved graphs remain a typed ambiguity. RenderPipeline
capture now compiles its real internal `fragmentNode`, including the context
wrapper and implicit `renderOutput()` transform when enabled; hashes include
the user graph, transform flag, tone mapper, and output color space. The public
`renderPipeline` capture option now works directly, with `postProcessing` kept
as an alias. The batch renderer's private `_renderOutput` fallback was deleted,
so the focused `webgpu_tonemapping` fresh capture/replay exercises the product
adapter and passes at infinite PSNR. Focused extraction proves transform-on WGSL
contains the tone/color conversion while transform-off does not. The broader
`webgpu_postprocessing` canary reaches the new captured pipeline but still
fails closed on the pre-existing signed user-material pass-topology mismatch;
that is the next semantic capture issue, not an output-artifact fallback.
The strict bundle retains 92 Node/TSL modules / 396.9 KiB rendered and measures
890,831 raw / 241,080 gzip bytes. Environment/fog scene topology is now the
remaining live scene-node island before XR and resource adapters.

**Explicit texture-constructor ownership (2026-07-13).** The live texture
registry no longer dynamically imports the bare `three` namespace. The slim
runtime already owns direct imports for all six Data/Storage texture classes;
full-runtime marker setup and scene support now patch the exact Three namespace
supplied by the application. Direct hydrator tests now inject that application
namespace explicitly as well. This removes an accidental Rollup
`inlineDynamicImports` retention root without changing configured lookup behavior:
the strict bundle drops from 444 to 414 modules and from 890,831 to 853,932 raw
bytes (about 10.6 KiB gzip), while compiler-only modules remain zero and the
remaining Node/TSL runtime stays at 92 modules / 396.9 KiB rendered. Explicit
constructor injection is the model for optional full-runtime compatibility;
slim internals must not recover broad package namespaces dynamically.

**Direct slim-source import prerequisite (2026-07-13).** The replay closure no
longer imports the bare `three` barrel for texture constructors, math helpers,
attributes, constants, or `EventDispatcher`. Those eleven runtime modules now
reference exact `three/src/**` files, preserving source-module identity and
allowing a future named-import source entry to tree-shake away `Three.Core`,
`ObjectLoader`, `BatchedMesh`, and unused geometry exports. A focused policy
test bans regressions to the bare/Core barrels and imports every path against
the installed Three version so private filename drift fails in compatibility
CI. This changes dependency roots only; the guarded source entry and shared
rewrite policy remain separate stages.

**Replay-native environment/fog topology (2026-07-13).** The final live
scene-node construction island is removed. `render-selector.js` now exports
the canonical scene topology descriptor already embedded in signed material
selectors, and the slim NodeManager hashes that same descriptor together with
light, shadow, and multiview state for RenderObject invalidation. Built-in
`Fog`, `FogExp2`, 2D/cube environments, and their live scalar/texture values
no longer cause `slim-replay-scene-nodes.js` to import the TSL barrel or build
temporary `reference()`, `fog()`, `texture()`, or `cubeTexture()` graphs.
Custom `scene.fogNode` and `scene.environmentNode` remain presence-compatible
with inert slim stubs; replacing an already observed custom node fails closed
because compiler-free replay cannot infer whether the opaque graph still
matches captured WGSL. A Rollup residue guard now rejects Three's stock fog
graph if it becomes reachable again. Custom graph topology must remain
immutable during replay; only its captured live values/resources may change.
Analytic-light descriptors are canonicalized as a semantic multiset so
selector signing is stable across Three revisions that expose traversal order
versus process-local `Object3D.id` order at different points in node setup.
Focused selector, scene-state, NodeManager, and build-policy tests pass. The
custom height-fog visual canary replays exactly (infinite PSNR). The strict analyzed bundle moves
from 414 to 388 rendered modules and from 853,932 raw / 230,578 gzip bytes to
827,464 raw / 222,801 gzip-9 bytes. Retained Node/TSL runtime falls from 92
modules / 396.9 KiB rendered to 66 modules / 302.7 KiB; compiler-only modules
remain zero. Dynamic cubemap verification remains assigned to the later
cube/XR/PMREM adapter stage because its current miss is target topology
(captured multisampled 2D versus replay single-sample cube), not scene graph
construction.

---

## 2026-06-09 audit refresh — corrections to the map

A verified architecture+performance audit (56 findings raised, 26 confirmed after adversarial verification) re-measured this document against the tree. Corrections, so later sections are read with current numbers:

- **Metrics drifted.** `hydrator.js` is ~1,075 LOC (doc body still says 656 below — that was accurate for 2026-05-14). [`run-e2e.mjs`](packages/examples/batch/run-e2e.mjs) is **15,542 LOC** (was 9,758), with **417 `__*` helper functions**. `slim-support/` has **17 modules** (the doc body describes 6), `hydrate/` has 26 files.
- **The hydrator regrowth is feature work, not failed decomposition.** The 656→1,008 growth is Tier C MRT variant selection (`selectArtifactVariant` + merge views, commits `6a15d662`/`0858b65e`) and live-uniform sidecar/skeleton state (`2e1e32cf`). The "shrink hydrator" framing in §P0.2 needs a decision: accept hydrator as orchestrator + variant dispatcher, or extract `hydrate/variants/`. The binding-kind split itself remains open and is unaffected.
- **§P0.1 is missing 11 of the 17 slim-support modules** (landed after 2026-05-14, no review bar in this doc): `traa-replay` (308 LOC), `postprocess-wire` (214), `postprocess-effects` (747), `postprocess-effects-replay` (462), `renderer-lighting` (491), `pass-render-fallback` (450), `live-node-sidecars` (416), `artifact-texture-wiring` (262), `diagnostics` (145), `index` barrel, plus `render-fallback-registry` (52, covered under §P1.6). Harness extraction follow-through is incomplete — fidelity fixes still land in `run-e2e.mjs` first.
- **The slim bundle regression is fixed at the bundler, not by budget bumps.** The gate in [`slim-bundle.test.js`](packages/plugin/test/unit/slim-bundle.test.js) had been bumped 263 → 420 KB gzip; the checked-in bundle measured 1.59 MB raw / ~407 KB gzip. The audit's per-module analysis found the growth was **not** feature cost: (1) runtime modules importing from bare `'three'` resolved to the *prebuilt* `three.module.js`/`three.core.js`, bundling ~2 MB of three a second time on top of `three/src/**`; (2) `WebGPURenderer.js`'s static `WebGLBackend` import dragged the whole `webgl-fallback/**` subtree (a second, GLSL shader compiler) into a WebGPU-only bundle. Two rollup wedges landed in [`rollup.config.js`](packages/runtime/rollup.config.js) — `threeBareAlias` (bare `three` → `three/src/Three.Core.js`, deduped by Rollup) and `webglFallbackStub` (redirects `WebGLBackend` to a throwing stub, [`src/slim-stub-webgl-backend.js`](packages/runtime/src/slim-stub-webgl-backend.js)) — plus a `TSLP_ANALYZE=1` per-module size reporter. Strict rebuild: **875 KB raw / 238.8 KB gzip**, fallback rendering/compute/offscreen support included. Gate re-tightened to **250 KB**; stale "≤ 350 KB" comments fixed. Lesson under §P0.5: run the analyzer before bumping a budget — both leaks were single-import-path mistakes invisible from the total.
- **§P1.8's gap 2 is confirmed closed in code**: aux-artifact injection runs in any production build, not just slim ([`packages/plugin/src/index.js:392-397`](packages/plugin/src/index.js#L392-L397)).
- **`aux-marker.js` (1,045 LOC) and `aux-loader.js` (951 LOC) had no entry in this document** despite being two of the five largest runtime files — now tracked as §P2.11.
- **New items from the audit:** §P1.9 (per-render resolution caching — first wedge landed), §P2.11 (aux pipeline doc/convergence), §P2.12 (startup hydration caching — several wedges landed), §P3.13 (bundle surface diet — partially resolved by the gate fix above).
- **Performance quick wins landed with the audit (2026-06-09):** per-binding `DataView` cache + clipping change-detection + `(group,binding)→planEntry` memo + variant-view memo in [`hydrator.js`](packages/runtime/src/hydrator.js); per-artifact WGSL/regex query cache in [`hydrate/texture-resolver.js`](packages/runtime/src/hydrate/texture-resolver.js); snapshot identity-keyed cache in [`hydrate/texture-snapshot.js`](packages/runtime/src/hydrate/texture-snapshot.js) (fixes a same-shape collision hazard); LTC boxed-array release in [`hydrate/builtin-textures.js`](packages/runtime/src/hydrate/builtin-textures.js); gated shadow-diagnostic payload construction in [`hydrate/rebinders/shadow-depth-rebinder.js`](packages/runtime/src/hydrate/rebinders/shadow-depth-rebinder.js); harness diagnostic removed from `writeColor` in [`writers.js`](packages/runtime/src/writers.js); artifact-path watcher filter + HMR batch window in [`packages/plugin/src/index.js`](packages/plugin/src/index.js) / [`dev-capture-server.js`](packages/plugin/src/dev-capture-server.js).
- **Deliberate non-changes** (verified intentional; do not "fix"): the serial e2e loop and 2-runs-per-browser recycling (the parallel runner froze machines ~150 examples in — deleted in `ee4ae2e3`; documented at `run-e2e.mjs:13905-13921`); `slim-entry.js`'s aux-loader import (it is exported slim API surface, not a one-call import).

---

## The one-paragraph diagnosis

The real fidelity work — PMREM generation, texture rebinding by identity, compute-buffer sync, shadow/pass delegation — still mostly lives in a **9.8k-line test harness** ([`packages/examples/batch/run-e2e.mjs`](packages/examples/batch/run-e2e.mjs)), so fixes can land in scaffolding before adopters benefit. The first productized runtime wedges now exist in [`packages/runtime/src/slim-support/live-scene-index.js`](packages/runtime/src/slim-support/live-scene-index.js), [`packages/runtime/src/slim-support/pmrem.js`](packages/runtime/src/slim-support/pmrem.js), [`packages/runtime/src/slim-support/gpu-texture-share.js`](packages/runtime/src/slim-support/gpu-texture-share.js), and [`packages/runtime/src/slim-support/compute-sync.js`](packages/runtime/src/slim-support/compute-sync.js), including PMREM cache/pending orchestration and cross-renderer compute output sync; fallback-renderer orchestration still needs a public setup surface. The runtime's [`hydrator.js`](packages/runtime/src/hydrator.js) is down to ~660 LOC (656 verified 2026-05-14) from the earlier ~3.8k LOC, with texture/source resolution, binding allocation, built-in texture reconstruction, typed-array helpers, per-frame texture rebinders, and material/light/snapshot UBO writers now split across [`packages/runtime/src/hydrate`](packages/runtime/src/hydrate). The important remaining hydrator debt is no longer "one giant texture resolver"; it is the local orchestration/classification layer that still builds shadow/material/viewport/reflector rebinder entry arrays. The extractor -> codegen -> runtime contract now has a shared package ([`packages/contract`](packages/contract)) for graph normalization, texture-property lists, the `source.kind` registry, dynamic binding descriptors, and artifact validation, removing several drift risks. The vendored three.js fork (~2.8k LOC) plus [`three-rewrite.js`](packages/plugin/src/three-rewrite.js) (1,718 LOC of source-text AST surgery on ~9 three.js files) now fails strict/CI builds on rewrite warnings and has a locked/latest compat matrix, but the deeper upstream seam is still unresolved. And pure slim **cannot generate shaders**, so shadows / clipping / dynamic node subgraphs are blocked — the harness papers over this by spinning up a *full* `WebGPURenderer` on the side, a pattern that is not yet productized.

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

**Status (2026-05-13).** Six wedges have landed plus the public orchestrator described above.
[`packages/runtime/src/slim-support/live-scene-index.js`](packages/runtime/src/slim-support/live-scene-index.js) now owns live texture identity indexing, material/node texture cataloguing, and null-image healing.
[`packages/runtime/src/slim-support/pmrem.js`](packages/runtime/src/slim-support/pmrem.js) now owns PMREM artifact/source detection, cache hits, pending joins, image-readiness skips, generation diagnostics, pending-counter hooks, `_textureRefs` wiring helpers, and PMREM texture selection for artifacts.
[`packages/runtime/src/slim-support/gpu-texture-share.js`](packages/runtime/src/slim-support/gpu-texture-share.js) now owns the keystone cross-renderer GPU-texture migration primitives — `shareGPUTextureEntry`, `sharePMREMGPUTexture`, `shareShadowGPUTextureIntoSlim`, `markTextureInitialized`, `clearTextureViewCache` — used by PMREM + shadows + future compute sync. Unit-test coverage in [`packages/runtime/test/slim-support-gpu-texture-share.test.js`](packages/runtime/test/slim-support-gpu-texture-share.test.js); 9 cases covering the success paths, missing-data branches, diagnostics counters, bind-group invalidation, and error forwarding.
[`packages/runtime/src/slim-support/compute-sync.js`](packages/runtime/src/slim-support/compute-sync.js) now owns compute-output synchronisation across renderers — `getComputeBindGroups`, `computeNodeUsesStorageTexture`, `syncComputeStorageOutputs` — for the case where the slim renderer borrows a full renderer to run a `ComputeNode` and needs its storage textures/buffers visible to its own draw call. Delegates storage-texture sharing to `shareShadowGPUTextureIntoSlim`; storage-buffer paths cover both "adopt full's GPUBuffer when slim has none" and "copyBufferToBuffer when slim already allocated its own". Unit-test coverage in [`packages/runtime/test/slim-support-compute-sync.test.js`](packages/runtime/test/slim-support-compute-sync.test.js); 8 cases covering bind-group detection, storage-texture sharing with mipmap regeneration, buffer adopt/copy paths, the `onStorageAttr` callback, missing-device gracefulness, and error forwarding.
[`packages/runtime/src/slim-support/full-renderer-fallback.js`](packages/runtime/src/slim-support/full-renderer-fallback.js) now owns the lazy bootstrap of a full `WebGPURenderer` on the slim renderer's shared `GPUDevice` — the productized version of `__getComputeRenderer`. Single-promise de-duplication, shared-device + `reversedDepthBuffer` forwarding, `shadowMap.enabled` toggle, optional `loadThreeFullModule()` async factory for non-bundler environments, `dispose()` + re-boot semantics. Unit-test coverage in [`packages/runtime/test/slim-support-full-renderer-fallback.test.js`](packages/runtime/test/slim-support-full-renderer-fallback.test.js); 9 cases covering boot/dedup/option-forwarding/error/dispose paths.
[`packages/runtime/src/slim-support/shadow-fallback.js`](packages/runtime/src/slim-support/shadow-fallback.js) now owns the standard Directional/Spot/Point depth-shadow fallback: it builds and refreshes a cached full-native proxy scene, performs the two lazy shadow warm-up renders, copies live map/matrix/camera state to the slim lights, and shares depth GPU textures. It preserves native `autoUpdate` behavior, validates shared-device/depth conventions, and fails closed for VSM/transmitted shadows, custom shadow nodes, skinned/batched/morphing casters, clipping shadows, and opaque node graphs unless the caller supplies `resolveShadowMaterial`; `createSlimSceneSupport().populateShadowMaps()` is the public orchestrator surface.
[`packages/runtime/src/slim-support/scene-support.js`](packages/runtime/src/slim-support/scene-support.js) is the public **`createSlimSceneSupport()`** orchestrator referenced at the top of this section — composes the focused support modules into a single opt-in entry point (`indexScene`, `getFullRenderer`, `generatePMREMAsync`, `syncComputeOutputs`, `populateShadowMaps`, pass fallback, texture sharing, and `dispose`), with a shared diagnostics bag and an `onError(err, where)` for non-fatal sub-module failures. Focused unit coverage exercises opt-in defaults, fallback boot, compute delegation, texture sharing, scene indexing, PMREM routing, pass fallback, and missing shadow-fallback configuration.

`run-e2e.mjs` imports the four primitive helpers through the runtime package; the GPU-share duplicates and the storage-sync duplicate there are now thin wrappers (~6–10 lines each, diagnostics / attribute-ledger callbacks forwarded through `opts`). The harness still owns the PMREM-generator scene cloning and the compute-node scene walk, but the GPU-data plumbing, compute-output sync, *and* full-renderer bootstrap are no longer harness-only — adopters compose them through `createSlimSceneSupport()`.

**Next step.** Migrate the harness's standard shadow call sites onto `support.populateShadowMaps(...)`, then add separate adapters for VSM blur textures, TileShadow/custom shadow nodes, and GPU/skinned caster proxies. Keep each unsupported family explicit so ordinary adopters do not inherit harness heuristics.

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

**Status (2026-05-14).** Hydrator down to **656 LOC** from a session-start of 1193 (-45%) — three fresh extractions: [`packages/runtime/src/hydrate/fallback-textures.js`](packages/runtime/src/hydrate/fallback-textures.js) owns the per-shape fallback singletons + `makeViewportFallback()`; [`packages/runtime/src/hydrate/clipping-planes.js`](packages/runtime/src/hydrate/clipping-planes.js) owns `collectClippingGroupsForObject` + `projectClippingPlanes` + `clippingPlaneSetsForFrame` + `selectClippingPlaneArray`; [`packages/runtime/src/hydrate/user-attributes.js`](packages/runtime/src/hydrate/user-attributes.js) owns `bindUserNodeAttributesToArtifact` + `bindUserStorageBuffersToArtifact` + `findInstancedObjectAttributeMatchingEntry` + `getInstancedMatrixColumnAttribute` + `findFirstAttributeMatchingEntry` + `hydrateNodeAttributes` + `itemSizeFromAttributeType` (~320 LOC of attribute/storage-buffer binding for compute-mesh and instanced paths). `Matrix3` / `Plane` / `InstancedBufferAttribute` / `StorageBufferAttribute` no longer imported into `hydrator.js`. All 278 runtime tests still green.

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
3. Evaluate replacing the riskiest text surgery with a **single upstreamed seam** — e.g. a `NodeManager` precompile hook or a `Renderer` extension point in three.js itself. One sanctioned hook beats nine fragile rewrites.
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
- **(A) "Slim + full-renderer fallback" as a first-class runtime mode** — bootstrap a full `WebGPURenderer`, swap to slim for the 95%, keep the full one for shadows/compute/complex passes on the shared device. Cheaper near-term; productizes what the harness already does.
- **(B) Extend the aux-artifact machinery** (already used for background / PMREM / post-processing) to also precompile the internal depth/shadow/clipping material *variants*, so pure slim can render them. The right end state; more work.

Likely (A) now, (B) later. Either way, document it as the policy.

### Decision (2026-05-13): Option (A) is the supported mode for v0.1+

**The supported `@tsl-precompile/runtime` mode is "slim + full-renderer fallback."** The slim bundle remains the primary renderer for the precompiled-PBR happy path; for the features that require live shader generation, an opt-in *full* `WebGPURenderer` boots on the **shared `GPUDevice`** and is asked to do that work. Outputs are copied back through the existing texture/buffer share primitives.

The full-renderer fallback covers:

| Feature | Why slim alone can't | Fallback responsibility |
|---|---|---|
| **Compute kernels** (`renderer.compute(node)`, `Fn(...).compute(N)`) | No node-graph compiler | Full renderer dispatches; `compute-sync.syncComputeStorageOutputs` copies storage outputs back to slim |
| **Shadow maps** | `ShadowBaseNode.generate()` returns `1.0`; no `MeshDepthNodeMaterial` build path | Full renderer renders the shadow scene; depth GPUTexture is shared into slim's data map (`gpu-texture-share.shareShadowGPUTextureIntoSlim`) |
| **PMREM generation** | `PMREMGenerator` requires the node-graph builder for its blur passes | Full renderer's `PMREMGenerator` produces the prefiltered cube; result is cached in `slim-support/pmrem` and wired via `attachPMREMRefsByOrder` |
| **Dynamic PassNode WGSL** (live `pass(scene, camera)` outputs not in the aux-manifest) | Slim can't emit new pass WGSL at render time | Full renderer renders the pass; result texture is shared back through the viewport/reflector rebinder path |
| **Clipping context** | `setupClipping()` reads `renderer.clippingContext`; slim can't rebuild a NodeMaterial with `clipShadows` semantics live | Captured per-material clipping planes are baked into the artifact; *runtime* `ClippingGroup` ancestry is honoured but discard logic is precompiled |

The fallback is **opt-in**. An adopter who only renders precompiled PBR materials never boots the full renderer (the slim bundle ships ~300 KB; the full bundle is roughly 6× larger). When the user enables `fullRendererFallback: true` on `createSlimSceneSupport`, the full renderer lazy-boots on first `await support.getFullRenderer()` and is then re-used for every fallback dispatch.

**Wiring:**

```js
import * as ThreeFull from 'three/webgpu';
import { createSlimSceneSupport } from '@tsl-precompile/runtime';

const support = createSlimSceneSupport( {
  renderer: slimRenderer,
  threeFullModule: ThreeFull,
  fullRendererFallback: true,
  pmremGenerator: ( _, src ) =>
    new ThreeFull.PMREMGenerator( fullRenderer ).fromEquirectangularAsync( src ),
} );
```

**Status (2026-05-14).** Productized and shipping. [`packages/runtime/src/slim-support/full-renderer-fallback.js`](packages/runtime/src/slim-support/full-renderer-fallback.js) owns the lazy-init + shared-device bootstrap + dispose. [`packages/runtime/src/slim-support/scene-support.js`](packages/runtime/src/slim-support/scene-support.js) composes it with `live-scene-index`, `pmrem`, `compute-sync`, and `gpu-texture-share` behind `createSlimSceneSupport`. [`packages/runtime/test/slim-support-full-renderer-fallback.test.js`](packages/runtime/test/slim-support-full-renderer-fallback.test.js) + [`slim-support-scene-support.test.js`](packages/runtime/test/slim-support-scene-support.test.js) cover the boot, dispose, device-sharing, and PMREM cache paths.

**Render-fallback dispatch (2026-05-14).** Slim mode now degrades gracefully on non-precompiled materials instead of hard-throwing. New [`packages/runtime/src/slim-support/render-fallback-registry.js`](packages/runtime/src/slim-support/render-fallback-registry.js) holds a module-level `(renderObject) => nodeBuilderState` handler. [`scene-support.js`](packages/runtime/src/slim-support/scene-support.js)'s new `ensureFallback()` async method eagerly boots the full renderer and registers a sync handler that proxies to `fullRenderer.nodes.getForRender(renderObject)`. The slim Nodes.js rewrite ([`packages/plugin/src/three-rewrite.js:791-803`](packages/plugin/src/three-rewrite.js#L791-L803)) now calls `getSlimRenderFallback()?.( renderObject )` before throwing; the fallback path is invisible to adopters until they configure it. New error copy points adopters at the configuration: "*Either call .precompile() on the material at capture time, or boot a full-renderer fallback via createSlimSceneSupport({ fullRendererFallback: true }) and call await support.ensureFallback() before rendering.*" Five-test suite locks the registry contract ([`packages/runtime/test/slim-support-render-fallback-registry.test.js`](packages/runtime/test/slim-support-render-fallback-registry.test.js)).

Adopter pattern for slim mode with non-precompiled materials (Inspector helpers, addon meshes, code paths the user doesn't own):

```js
import * as ThreeFull from 'three/webgpu';
import { createSlimSceneSupport } from '@tsl-precompile/runtime';

const support = createSlimSceneSupport( {
  renderer: slimRenderer,
  threeFullModule: ThreeFull,
  fullRendererFallback: true,
} );
await support.ensureFallback();   // boot full renderer + register slim getForRender handler
slimRenderer.setAnimationLoop( () => slimRenderer.render( scene, camera ) );
```

`run-e2e.mjs`'s `__getComputeRenderer` now delegates to the productized fallback so the harness exercises exactly the same code path adopters will.

Option (B) — precompiling the internal depth/shadow/clipping material variants as aux artifacts — remains the long-term direction; tracked as a deferred follow-up since it requires extending the aux-extractor pipeline (which already covers background / PMREM / post-processing) to depth and clipping variants.

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

**Status (2026-05-13).** Wedges landed: `run-e2e.mjs` and `run-coverage-summary.mjs` both use [`packages/examples/batch/psnr.mjs`](packages/examples/batch/psnr.mjs), and [`packages/examples/batch/coverage-config.json`](packages/examples/batch/coverage-config.json) now owns pixel-gate disabled reasons, ignore regions, and the first `tier1` subset. [`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs that configured `tier1` subset as a PR/push visual gate after a strict slim build, then uploads the tier report, coverage summary, and saved shots. The regenerated broad summary is 163 / 226, with shadows 8 / 8, lights 8 / 12, camera 2 / 3, PMREM scene green, and MRT/render-targets 4 / 4 after refreshing stale focused evidence into saved shots.

**Next step.** Watch CI stability on hosted WebGPU, then expand the tier-1 set only with examples that are deterministic enough to be a PR gate. Keep the full sweep as scheduled/manual coverage.

**Files.** [`packages/examples/batch/psnr.mjs`](packages/examples/batch/psnr.mjs); new `packages/examples/batch/coverage-config.json`; `packages/examples/batch/run-e2e.mjs`; `packages/examples/batch/run-coverage-summary.mjs`; `.github/workflows/*`.

---

### P2.10 — Dev/build extractor convergence guard

**Symptom.** Dev path = the in-browser extractor running on the live scene; build path = [`node-harness.js`](packages/plugin/src/node-harness.js) + [`mock-webgpu.js`](packages/plugin/src/mock-webgpu.js) re-extracting with a minimal scene. Scene differences (light count, fog, shadow casters) can change the artifact shape; `pnpm verify` catches *some* of this but doesn't systematically diff "what dev captured" against "what build re-extracts."

**Why it blocks evolution/fidelity.** Silent drift between the two extraction paths is a correctness hazard that can mask itself as a per-example bug.

**Change.** Have `pnpm verify` (or a dedicated check) diff dev-captured vs build-re-extracted artifacts across the example corpus and fail on shape divergence; document explicitly which scene properties are *allowed* to differ.

**Status.** First wedge landed (2026-07-10). [`packages/contract/src/artifact-shape.js`](packages/contract/src/artifact-shape.js) exports `fingerprintArtifactShape` / `diffArtifactShapes` (uniform-plan group/slot/texture/kind rows, ignoring WGSL). [`packages/plugin/test/unit/extractor-convergence.test.js`](packages/plugin/test/unit/extractor-convergence.test.js) asserts the Node harness is shape-stable across two extracts of the same factory. `pnpm verify` now fingerprints each checked artifact and reports empty-shape counts. Full browser-capture vs Node re-extract diffs across the example corpus are still outstanding.

**First step (done).** Shared shape fingerprint + Node stability guard + verify wiring.

**Next step.** Diff committed browser-captured example artifacts against Node re-extracts for a small fixture set inside `verify.js` (or a dedicated `pnpm verify:convergence`), documenting which scene properties are allowed to differ.

**Files.** [`packages/contract/src/artifact-shape.js`](packages/contract/src/artifact-shape.js); `packages/plugin/src/cli/verify.js`; `packages/plugin/src/node-harness.js`; `packages/plugin/test/unit/extractor-convergence.test.js`.

---

### P2.11 — Document & converge the aux artifact pipeline

**Symptom.** Two registration/loading systems: [`precompile-marker.js`](packages/runtime/src/precompile-marker.js) (992 LOC) → `apply-precompiled` for user materials, vs [`aux-marker.js`](packages/runtime/src/aux-marker.js) (1,045) → [`aux-loader.js`](packages/runtime/src/aux-loader.js) (951) + [`aux-capture.js`](packages/plugin/src/aux-capture.js) (476) for three.js internals. aux-loader carries its own texture-wiring predicates (`wireViewportTextureRefs`, `attachPostprocessTextureRefs`, `bindAuxConfig`) overlapping [`slim-support/artifact-texture-wiring.js`](packages/runtime/src/slim-support/artifact-texture-wiring.js) (262 LOC) and [`postprocess-wire.js`](packages/runtime/src/slim-support/postprocess-wire.js) (214 LOC). Neither aux file appeared in this document before 2026-06-09. Shape-fallback warnings fire once per `<shape>:<configHash>` then fall back silently.

**Why it blocks evolution/fidelity.** Two of the five largest runtime files have no documented architecture or review bar; verified genuine duplication is ~150–200 LOC of texture-wiring predicates (the split registration models are intentional), but wiring fixes can land in the wrong copy, and stale-hash bugs are invisible after the first warning.

**Change.** Keep the two registration models; document their contract here; make aux-loader consume the `artifact-texture-wiring` predicates; add an aux debug hook per §P3.12 (mirror `setTextureResolutionDebugHook`).

**First step.** Write the doc section + migrate one duplicated predicate cluster to the shared slim-support module behind existing tests.

**Files.** [aux-marker.js](packages/runtime/src/aux-marker.js), [aux-loader.js](packages/runtime/src/aux-loader.js), [aux-capture.js](packages/plugin/src/aux-capture.js), [artifact-texture-wiring.js](packages/runtime/src/slim-support/artifact-texture-wiring.js), [postprocess-wire.js](packages/runtime/src/slim-support/postprocess-wire.js).

---

### P2.12 — Startup hydration caching pass

**Symptom.** Hydration repeated work per material: WGSL source re-concatenated and regexes recompiled per binding probe; `uniformPlan` re-walked via `Array.find` per uniform-buffer binding; variant selection re-scanned `Object.values(artifact.variants)` per call; snapshot textures cached under a collision-prone shape key; LTC sources retained as boxed JSON arrays after texture build.

**Why it blocks evolution/fidelity.** 100ms-class time-to-first-frame overhead on texture-heavy materials and retained memory in long dev sessions; each future binding kind inherits the same uncached patterns.

**Status (2026-06-09).** Wedges landed with the audit: per-artifact shader-source + query memo ([`hydrate/texture-resolver.js`](packages/runtime/src/hydrate/texture-resolver.js) `cachedShaderQuery`), `(group,binding)→planEntry` memo + variant-view memo keyed on the registry's replace-on-grow `variants` object ([`hydrator.js`](packages/runtime/src/hydrator.js)), snapshot identity key ([`hydrate/texture-snapshot.js`](packages/runtime/src/hydrate/texture-snapshot.js)), LTC typed-array swap ([`hydrate/builtin-textures.js`](packages/runtime/src/hydrate/builtin-textures.js)).

**Next step.** A per-artifact hydration context object built once in `hydrateRuntimeBindings()` to carry these memos explicitly (instead of module-level WeakMaps) when the §P0.2 source/dynamic descriptor table work touches the same files; release/dedupe snapshot JSON arrays after GPU upload (blocked on the `Array.isArray(snapshot.data)` guards spread across hydrate/ and aux paths).

**Files.** [texture-resolver.js](packages/runtime/src/hydrate/texture-resolver.js), [hydrator.js](packages/runtime/src/hydrator.js), [texture-snapshot.js](packages/runtime/src/hydrate/texture-snapshot.js), [builtin-textures.js](packages/runtime/src/hydrate/builtin-textures.js).

---

## P3 — cleanup (low risk; do alongside the above)

### P3.11 — Stub & dead-code hygiene
- [`slim-stubs.js`](packages/runtime/src/slim-stubs.js): close the PassNode/Node coverage gaps (track via the "[tsl-precompile/slim] X is not available" load-smoke errors). Resolve `ShadowBaseNode`'s inert stub together with P1.6.
- [`mock-webgpu.js`](packages/plugin/src/mock-webgpu.js): document the no-readback limitation loudly (scenes doing `mapAsync` get zeros and are flagged for real-browser re-render).
- `emit-updater.js`: keep the default-last invariant in the `switch`-after-`default` case.
- The `frame.object.viewPosition` / `frame.object.direction` non-standard-property assumption — verify the slim render loop populates `frame.object` before the updater runs, or fix the source.
- Prune the many untracked `visual-*` / `debug-*` JSON files under `packages/examples/batch/results/`.

### P3.12 — Diagnostic-hook formalization
`__tslpHarnessDiagnostics`, `__TSLP_DEBUG_LIGHT_LINKAGE`, `__TSLP_DEBUG_SHADOW_BINDINGS`, `__TSLP_DEBUG_SHADOW_COVERAGE` etc. are ad-hoc globals with no schema. Fold them into the `slim-support` module's debug API (depends on P0.1) so they're documented, schema'd, and testable. Progress (2026-06-09): the `writeColor` harness probe is removed from [`writers.js`](packages/runtime/src/writers.js); shadow-depth rebinders now accept a `diagnosticsEnabled` predicate so payload construction (not just recording) is gated on `__TSLP_DEBUG_SHADOW_BINDINGS`. The `seedUniformBufferSnapshots` probe in `hydrator.js` still writes to the global bag.

### P3.13 — Bundle surface diet: stubs, core entry, artifact payloads

**Symptom (as found 2026-06-09).** The slim gzip gate had been relaxed 263 → 420 KB against a stale checked-in bundle; [`slim-stubs.js`](packages/runtime/src/slim-stubs.js) (1,430 LOC) always ships — Proxy chains, full Node protocol stub, stateful PassNode stub — via slim-entry; the main barrel [`index.js`](packages/runtime/src/index.js) re-exports dev-only modules (aux-marker, graph-hash) so root-import users pull them in; the runtime package declares no `sideEffects` field; on-disk artifacts are pretty-printed with inline WGSL although [`wgsl-optimize.js`](packages/plugin/src/wgsl-optimize.js) implements minify/dedupe for virtual modules.

**Status (2026-06-09).** The headline regression is resolved at the bundler: the `threeBareAlias` + `webglFallbackStub` rollup wedges (see the audit-refresh bullet at the top of this doc) cut the bundle ~407 → 238.8 KB gzip, and the gate is re-tightened to 250 KB with the stale comments fixed ([`slim-bundle.test.js`](packages/plugin/test/unit/slim-bundle.test.js)). The `TSLP_ANALYZE=1` rollup flag prints a per-module breakdown — use it before any future gate bump. Refuted during verification: lazy-importing aux-loader from slim-entry (it is exported slim API, not a one-call dependency).

**Remaining.** A minimal `core` subpath export (apply + loader + writers) for non-slim adopters importing the root barrel; `sideEffects` annotations in [`packages/runtime/package.json`](packages/runtime/package.json) (careful: `hydrator.js` has a real module-init side effect — `installLiveTextureRegistryPatches()`; list side-effectful files explicitly rather than `false`); lazy TSL/PassNode stub entries if the analyzer shows them dominating; opt-in on-disk artifact minification (low value — dev artifacts are gitignored test fixtures).

**Files.** [slim-stubs.js](packages/runtime/src/slim-stubs.js), [slim-entry.js](packages/runtime/src/slim-entry.js), [package.json](packages/runtime/package.json), [index.js](packages/runtime/src/index.js), [slim-bundle.test.js](packages/plugin/test/unit/slim-bundle.test.js).

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

Suggested order from here (revised 2026-06-09; P1.8 is resolved and the first P1.9/P2.12 wedges landed with the audit): **P0.2 hydrator-shape decision (orchestrator+variants vs `hydrate/variants/` extraction) + source/dynamic descriptor table + storage-texture decision**, then **P1.7 completion designed together with P1.9** (uniform-slot/storage descriptors + light-cache invalidation + extending the render-scoped memo — the largest verified per-frame payoff), then **P0.1 remaining pass/shadow productization + the §P2.11 aux convergence** (do alongside any aux bugfix, not standalone), then **P2.10 dev/build extractor convergence**, with P0.5 vendor diagnostics, P3.13 remaining bundle work, and P2/P3 cleanup folded in as touched areas stabilize.

## What "done" looks like

- Slim-bundle fidelity logic lives in `@tsl-precompile/runtime/slim-support` with unit tests; `run-e2e.mjs` is a thin caller and an adopter can get PMREM / texture rebinding / compute sync by importing the module.
- `hydrator.js` is < ~1k LOC of orchestration; binding kinds and texture-resolution strategies are individually testable; a full texture-resolution miss warns instead of binding white.
- There is one `KINDS` registry, one `TEXTURE_PROPS` list, one artifact schema; the build fails on an unknown kind; the runtime validates artifacts in dev.
- One `graph-normalize` module; a parity test guards plugin↔runtime hash agreement.
- A nightly job builds the slim bundle against `three@latest` and fails on any rewrite fallback; the slim-vs-full-renderer policy is written down.
- `vite build && vite preview` works end-to-end for the canonical examples (ocean + getting-started), with Inspector + RenderPipeline + bloom + PMREM env all rendering identically to dev mode; the four gaps in §P1.8 (precompileAuxiliary prod no-op, aux injection un-gated from slim, Inspector preview-mode behavior, slim Node method-chain fallback) are closed and covered by a Playwright smoke.
- Coverage is one deterministic number from one code path, with a checked-in tier-1 PR gate.
