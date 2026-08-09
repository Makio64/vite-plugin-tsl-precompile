# Evolution archive — dated snapshots and completed work

Historical companion to [ROADMAP.md](./ROADMAP.md) (what is still open) and
[ARCHITECTURE.md](./ARCHITECTURE.md) (what the system is).

**Everything below is a dated record of what was true when it was written.** Figures here
are deliberately *not* maintained: they are evidence of a state the project passed through,
not claims about the current tree. For a current measurement run `pnpm analyze:modules`.
Sections are newest first.

This file split out of `ARCHITECTURE_EVOLUTION.md` on 2026-08-02, when that document had
grown to 1,417 lines mixing active roadmap with history — the 2026-08-02 architecture audit
found its active items quoting file sizes that were stale by dozens to hundreds of lines,
with no way for a reader to tell a deliberate historical figure from a forgotten one.

---

## 2026-08-02 compiler-free WebGL backend replay

`WebGPURenderer({ forceWebGL: true })` and its automatic WebGPU-unavailable
fallback now remain live in both slim profiles. The WebGL backend itself is
retained, while its `GLSLNodeBuilder` import and `createNodeBuilder()` path are
removed by the same fail-closed rewrite policy used for the WGSL compiler.

Capture labels native shader payloads as WGSL or GLSL. A backend-aware
`variantKey` namespaces the durable family map while preserving Three's raw
private `cacheKey`, so one material captured through both renderers cannot
overwrite one backend with the other. Runtime hydration validates the selected
shader language against the active backend before creating a pipeline. GLSL is
kept byte-for-byte during build emission, and output, texture, array-layer, and
skinning probes understand both native syntaxes.

The recapture client can now execute the full declared route matrix with
`--backends webgpu,webgl`. The WebGL leg triggers Three's own backend fallback
inside a fresh context while preserving `navigator.gpu`, and every leg is
gated against the renderer's observed post-init backend. Fully signed
auxiliary and renderer-owned family writes aggregate compatible backend
variants atomically too, so a later GLSL capture cannot shrink an existing
WGSL family (or vice versa).

This support is for compiler-free render/compute pipeline replay, not WebXR.
Slim still replaces Three's dynamic XR manager with an explicit unsupported
adapter; applications that need XR must use full Three with its WebGL backend.

## 2026-07-30 compiler-free PMREM and VSM internal passes

Realtime comparison separated two failures that previously looked alike.
PMREM extraction compiled a synthetic plane, so its WGSL hard-coded cube face
zero and its selector described the wrong target/vertex topology. Capture now
harvests Three r185's real unindexed LOD meshes (`position`, `uv`,
`faceIndex`) against the RGBA/HalfFloat atlas; direct live-render and extracted
WGSL hashes match for source conversion, blur, and GGX.

The second PMREM fault was inside Three's generator lifetime. r185 creates
`_equirectMaterial` or `_cubemapMaterial` around the first source texture and
reuses that private material. The source texture's sample/component type and
filterability can change WGSL texture declarations and sampling instructions,
so one generator cannot be used as a capture cache across heterogeneous source
topologies. Capture now creates a fresh generator per `pmrem-support@1`
topology, while equivalent inputs deliberately share the same durable family.

VSM's extracted vertical and horizontal WGSL already matched Three byte for
byte. Its failure was ownership: the private materials were discarded as
generic node materials and the transient depth/intermediate resources had no
durable replay schedule. Exact material-name classification plus
`AnalyticLightNode.shadowNode` ownership now emits semantic
`internal-pass@1` descriptors. The shared contract validates role addresses
without persisting runtime UUIDs; the slim binder overlays live uniforms,
textures, and the packed PMREM weights buffer.

The slim runtime now keeps Three's PMREM atlas geometry/schedule and resolves
complete `texture-equirect`, `texture-cubemap`, or `scene` program families by
`pmrem-support@1`; `pmrem-layout@1` remains the nested atlas replay metadata.
A VSM scheduler owns raw depth,
vertical, and horizontal targets and publishes the final moments texture to
normal shadow hydration. `createSlimSceneSupport()` selects both paths before
considering a full renderer, so captured PMREM and non-point VSM no longer
require the compiler-bearing fallback.

Internal-pass publication is transactional as well as family-valid. The
browser signs and posts one PMREM or VSM envelope; the dev server rejects
incomplete, duplicate, cross-config, or non-canonical members, writes every
full-digest content-addressed file, then publishes the generation with one
atomic manifest rename. Standalone internal stages cannot bypass that family
transaction, and the batch harness exposes family members through one
in-memory replacement. Recapture performs production builds and six
compiler-free PMREM/VSM preview receipts before committing its
artifact-directory transaction; each receipt proves the generated output is
installed in the downstream `scene.environment` or shadow `mapPass` binding,
not merely that an internal pass ran.

## 2026-07-30 Three r185.1 compatibility wedge

The locked baseline advances to exact `three@0.185.1`, with the guarded
plugin/runtime handshake at `slim-three-policy@12`. Compatibility is validated
against the official `r185` tag only: its package metadata must report
`0.185.1` and its exported `REVISION` must be `185`. A nearby development tree
with mismatched package metadata is not acceptable provenance.

The strict rewrite surface moved with the upstream implementation. The full
compact AST for `NodeUtils.js` is re-fingerprinted, while the unchanged
constants and Loader modules are re-gated against r185. The graph-free
constants surface adds `NodeUpdateType`. `WebGPUBackend` now declares
`bindingsData` inside the bind-group cache-miss branch and owns sampler updates
by binding rather than texture; the rewrite recognizes those exact transition
shapes and rejects unknown ownership or delegation.

Replay parity moved at the renderer boundary too. Hydrated builder state now
exposes `hardwareClipping` for `RenderObject`; object-update uniform groups
always refresh; array output passes have the r185 `setOutputLayerIndex()`
lifecycle; and replay lighting mirrors `enabled`,
`beginRender(scene)`, and `finishRender(scene)` with nested state restoration.
These are renderer contracts, not optional compatibility stubs.

Artifacts remain generated, revision-bound build inputs. Every material,
compute, and auxiliary example artifact must be recaptured after the bump,
including legacy versionless files, before all-example build and visual gates
are accepted. Browser auxiliary capture now persists the exact Three and
toolchain versions in both its artifact envelope and manifest entry; production
codegen rejects missing or mismatched provenance, and `pnpm verify` gates those
fields against the current exact baseline. Legacy versionless auxiliary files
therefore remain usable only long enough for dev mode to recapture them.
Artifact JSON and screenshots must never be hand-edited.

---

## Historical snapshot: 2026-07-11 capture/identity spike

This section records the state at that checkpoint. Later current-state
corrections are labeled explicitly rather than rewriting the historical
sequence of decisions and measurements.

The real-render observation added in July exposed a simpler target than
reconstructing every render context in a throwaway scene. A mock-WebGPU
generation test now harvests the `NodeBuilderState` produced by one ordinary
render and extracts complete WGSL plus light, shadow, depth-texture, and fog
sources without a second compile. The private Three seam is centralized in
[`packages/plugin/src/vendor/render-object-observer.js`](packages/plugin/src/vendor/render-object-observer.js), which uses a Symbol-backed subscriber registry; `compileTSL` consumes that adapter instead of replacing `NodeManager.getForRender` itself.

At that snapshot, `compileTSL` could consume a completed real-render harvest. The observer
freezes request-time target/face/mip/MRT state, joins cached or newly built
`NodeBuilderState` objects by material plus Three cache key, and exposes one
atomic family per material. Extraction prefers a supplied complete family and
falls back to the whole synthetic family when any requested sibling is
incomplete; it never mixes a partial real family with synthetic siblings.

**Current handoff (2026-07-30).** The production marker now brackets the
application's real `renderer.render(scene, camera)` calls with the plugin-owned
observer. Synchronous multi-call bursts share one bounded epoch, asynchronous
renders keep that epoch open until settlement, and the finished immutable
harvest is handed to both marked-material extraction and the exact
renderer/scene auxiliary-capture slot. Complete real families are preferred
atomically; incomplete families still fall back atomically to synthetic
extraction. CubeCamera-style multi-call coverage remains bounded by the
observer epoch rather than being reconstructed from a throwaway scene.

Identity is now split in the first useful way: `__hash` is derived from runtime
artifact content (shaders, binding/layout data, uniform plans, render state, and
variants), while `sourceGraphHash` remains source provenance. Dev captures also
record stable call-site owners and a conservative transformed-owner revision.
That revision now includes the deterministic transitive closure of statically
resolved project-local imports. Capture and production both use Vite resolution
(including aliases); the server persists the canonical dependency proof without
adding it to the runtime marker API, and the source-aware verify scan recomputes
it directly. Virtual modules, `node_modules`, linked workspaces outside the
configured root, and unrelated application files are excluded. A changed,
removed, newly resolved, or retargeted local helper therefore fails closed
before artifact emission. `autoMark` relies on this build-time gate because it
rewrites the constructor before later `*Node` assignments, making an
adoption-time graph comparison inherently too early. Render-context fingerprints
remain live variant-selection evidence rather than source freshness.

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
PMREM implementation are hard build failures when they contribute rendered bytes;
`NodeBuilderState` was initially retained as a renderer data carrier; the
replay-native manager described below now replaces it with runtime-owned
hydrated state. Two dead paths were removed immediately:
NodeManager no longer catches hydration failure by constructing a generic
NodeMaterial after the backend builder has already been stripped, and the
initial slim PMREM export was a constructible compatibility shell. It has
since become a compiler-free replay generator backed by captured
`internal-pass@1` source/blur/GGX programs. Together the original cuts moved the
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

**Replay-owned renderer context and precision topology (2026-07-13).** The
slim renderer no longer constructs its default context-cache carrier through
Three's `ContextNode`; `slim-replay-renderer-context.js` owns the stable node
identity, versioning, flow-context compatibility, and high-precision state
that `RenderObject` actually consumes. `renderer.highPrecision` is now an
explicit captured selector/signature axis for ordinary, background,
post-process, and shadow-depth profiles, rather than a graph mutation that
replay could silently ignore. The shared contract also names the complete CPU-derived matrix family:
`object.modelViewMatrix`, `object.modelNormalViewMatrix`, and
`light.shadowModelMatrix`. Extraction classifies those callback-backed inputs,
generated and hydrated updaters refresh them from the live object/camera/light,
and a real mock-WebGPU directional-shadow fixture guards the full capture path.
The strict closure still contains 65 Node/TSL modules because other retained
Three paths reference `ContextNode`; this wedge reduces `ModelNode` from 3,493
to 2,218 rendered bytes and retained Node/TSL bytes from 303,515 to 302,240.
The next material reduction is the shadow ownership seam: removing the stock
renderer shadow-node construction path experimentally drops the closure to 51
Node/TSL modules / 239,415 rendered bytes, but it must land only with exact
per-caster binding ownership and artifact-family coverage.

**Exact shadow-caster ownership capture (2026-07-13).** The extractor now
distinguishes the renderer-owned shadow material that owns captured WGSL from
the exact pre-override caster material that owns its live bindings. The shared
render-object observer keeps one Symbol-scoped, nested `renderer.renderObject`
dispatch stack because `RenderObjects.get()` sees the shadow override before
it sees the current geometry group. Request snapshots copy exact object,
selected material, geometry, and group scalars; stale or mismatched dispatches
remain explicitly inexact. Only exact shadow requests may serialize the
variant-local `bindingOwner: "shadow-caster"` contract. Caster UUIDs and live
object/material/group references remain non-enumerable harvest evidence and
never enter artifact JSON. Exact requests also replace synthetic selector
evidence for the same cache pair, so stale cached groups cannot split shadow
topology. This wedge intentionally stops before runtime hydration: the next
stages classify `material.*` bindings against that owner, install owner-local
replay overlays, and preserve every shadow artifact family through aux
serialization and registry merging before the stock shadow-node construction
closure can be removed. The strict graph remains 393 modules with 65 retained
Node/TSL modules / 302,240 rendered bytes; the added contract and selector
logic moves the bundle from 828,280 raw / 226,734 gzip-9 bytes to 829,290 raw /
227,045 gzip-9 bytes.

**Owner-qualified shadow binding extraction (2026-07-13).** Exact dispatch
evidence now reaches uniform-plan extraction as a process-local Set of every
source material that shares the harvested shadow state. Three r184's explicit
caster `ReferenceNode( "map" )` becomes `material.map`, including its texture
matrix, only when the node's stable `.object` belongs to that Set; direct graph
textures remain `artifact.texture`, and mutable `.reference` values never
prove ownership. The shared contract also records that r184 copies `alphaMap`
and `alphaTest`, but not `opacity`, onto its shadow override. Artifact-level
`bindingOwner: "shadow-caster"` is the compact default, while mixed inputs use
the canonical `source.bindingOwner ?? artifact.bindingOwner ??
"render-material"` precedence; shadow-material opacity therefore carries an
explicit `render-material` exception. Caster identities remain process-local,
and stale shared-override values are not promoted into caster defaults. A real
mock-WebGPU fixture covers map, alpha-map/test, direct custom shadow texture,
and plain caster branches. Runtime owner-local hydration is the next wedge;
this extraction commit deliberately does not redirect live bindings yet. The
strict graph remains 393 modules with zero compiler/stock-adapter residue and
65 retained Node/TSL modules / 302,240 rendered bytes; contract and provenance
metadata move the bundle to 830,311 raw / 227,181 gzip-9 bytes.

**Owner-local shadow replay hydration (2026-07-13).** Slim Renderer rewriting
now intercepts the exact `material = overrideMaterial` handoff after Three has
copied the current caster's alpha/render state. A stable replay material per
`(shadow override, exact caster)` gives `RenderObjects` distinct material
identity for different casters and carries the caster on a non-serializable
contract Symbol; `onAfterRender` still observes Three's original shared
override. A shared contract topology projection advances the stable overlay's
program key when one caster changes map/custom shadow/depth/position branches;
normalizing the base revision excludes the shared override's expected
alpha-test setter churn. Hydration constructs one named owner context only after semantic
variant selection. Generic UBO writers resolve each material source through
`source.bindingOwner ?? artifact.bindingOwner`, sampled textures and samplers
memoize against the actual owner, and custom `artifact.texture` graph probes,
user attributes/storage, material-depth inputs, and reflectors walk the caster
graph. Mutable attribute/storage entries, `uniform.live` slots, and graph
update-phase lists are descriptor-preserving per-hydration views; exact caster
node paths replace artifact-global in-process sidecars without mutating the
shared variant. Capture records caster-owned uniform, attribute, and storage
paths only when every exact caster proves the same compatible public path;
frozen state-local light sources are relinked after cloning, and unscoped
process-global closure uniforms fail closed to snapshots for signed shadow
artifacts. Mixed caster/render-material live uniforms are wired separately and
their update phases are unioned. Generated updaters keep their AOT path through a read-only owner overlay
and fall back to per-slot generic writes only if the same property has
conflicting owners. Newly signed shadow artifacts fail closed without an exact
caster; unsigned artifacts unwrap to Three's temporary shared override for the
old graph/material behavior. Overlay, base, and caster identities all receive
the live frame so skeleton/instance buffer resolvers remain valid. The
plugin/runtime guarded-source handshake advances to `slim-three-policy@5`.
Stock `_getShadowNodes()` construction deliberately remains until every shadow
artifact family survives aux registration and selection; removing that graph
closure is the next independent wedge. The final strict build is 841,535 raw /
230,502 gzip-9 bytes; the graph grows from 393 to 395 modules while retaining
zero compiler/stock-adapter residue and 65 Node/TSL modules / 302,240 rendered
bytes. The production budget therefore moves only the crossed raw
ceiling from 840,000 to 843,000 bytes and the minimal source gzip ceiling from
158,000 to 161,000 bytes (measured 159,878); prebuilt gzip, advanced-source,
compiler, adapter, identity, and graph ceilings stay fixed.

**Complete shadow artifact-family preservation (2026-07-13).** Aux capture
no longer sorts shadow-depth artifacts and serializes only the largest
renderer-owned material family. A real directional + point-light fixture
proved the old path retained only 2 of 6 semantic selectors and dropped every
point-shadow cube-face topology. The shared artifact-variant contract now
flattens nested families and treats Three cache keys as family-local: when the
same key identifies an equivalent shader/binding payload, capture and the
runtime registry canonical-union every render-context selector while keeping
the original root identity stable; a divergent same-key payload throws the
typed `TSLP_ARTIFACT_VARIANT_CACHE_KEY_COLLISION` error instead of overwriting
one family. Browser aux capture emits one JSON-safe aggregate, persistence
keeps the existing `<shape>:<configHash>` model, and semantic replay selection
uses the same authoritative candidate helper as contract validation. The
strict bundle is 842,964 raw / 230,884 gzip-9 bytes with the graph unchanged at
395 modules, zero compiler/stock-adapter residue, and 65 retained Node/TSL
modules / 302,240 rendered bytes. All production budgets pass unchanged. With
every observed shadow family now durable, removing stock
`Renderer._getShadowNodes()` construction is the next independent wedge.

**Graph-free Renderer shadow dispatch (2026-07-13).** The guarded r184
Renderer rewrite now removes the stock `_cacheShadowNodes` initializer,
`_getShadowNodes()` method, its single shadow-pass call, and the three
color/depth/position override assignments. Complete captured shadow families
and exact-caster replay materials now own those branches. The rewrite retains
Three's copied alpha/render state, VSM versus non-VSM side selection, the exact
replay-material handoff, and callback-visible shared-override identity. Its
`castShadowNode` / `shadowMap.transmitted` warning is relocated to the same
dispatch branch as a graph-free `warnOnce` condition. Exact method, cache,
call, assignment, and warning shapes are independently gated; drift rejects
the rewrite rather than leaving a partial graph path. The source/runtime
handshake advances to `slim-three-policy@6`.

The production closure falls from 395 to 381 modules and from 842,964 raw /
230,884 gzip-9 bytes to 825,688 raw / 226,395 gzip-9 bytes. Retained Three
Node/TSL runtime falls from 65 modules / 302,240 rendered bytes to 51 /
239,415. Minimal and advanced `slim: 'source'` fixtures measure 136,671 and
144,603 gzip-9 bytes respectively, each with only 2 retained Node modules /
1,190 rendered bytes. Production caps are tightened to 828,000 raw / 228,000
gzip, 51 prebuilt Node modules / 242,000 rendered bytes, 139,000 and 147,000
source gzip, and 2 source Node modules / 1,536 rendered bytes. The human budget
report now exposes retained-node count and size for every profile. Focused
standard-mask and point-alpha shadow canaries remain pixel-identical; the
custom/transmitted canary passes at 67.32 dB. All three replay the rebuilt
bundle with zero errors, captured shadow-depth artifacts, and one forced
shadow pass. The remaining closure is now dominated by reusable node protocol,
compute, and output/color-transform dependencies rather than shadow graph
construction.

**Graph-free CubeRenderTarget conversion (2026-07-13).** Closure analysis
showed that Three's fixed `CubeRenderTarget.fromEquirectangularTexture()`
material retained 49 of the remaining 51 Node/TSL modules. The shared
`cube-render-target@1` contract now signs the sampled 2D source, r184's
effective mipmap/pole-filter state, and the destination format, attachment,
MSAA, depth/stencil, and multiview topology. Capture supports matching custom
`targetOptions` / `cubeRenderTargetOptions`, rejects color-incompatible source
families, uses CubeCamera's exact perspective face camera, waits for the
renderer compile queue before temporarily mutating sampler state, and requires
the complete artifact family to retain exactly one source-texture identity. Offline
capture, browser capture, and replay share that evidence validator and the
exact `0.184.0` hash domain.

The guarded r184 rewrite verifies the complete conversion lifecycle, removes
the equirect UV/texture graph and all four graph imports, and preflights the
exact replay material before Three mutates the caller texture or allocates its
box geometry. Replay clones the selected registry template, wires only the
validated sampled-texture domain, and fails closed on uncaptured source or
destination topology. Cube selector projection removes scene/lights,
compatibility mode, target debug labels, mutable face, and mip identity while
retaining shader/pipeline target axes; ReplayNodeManager applies that
projection before its cache key so all six faces share one hydrated state.
The source/runtime handshake advances to `slim-three-policy@7`.

The strict prebuilt falls from 825,688 raw / 226,395 gzip-9 bytes, 381 modules,
and 51 retained Node modules / 239,415 rendered bytes to 768,161 raw / 209,773
gzip-9 bytes, 333 modules, and 2 retained Node modules / 2,293 rendered bytes.
Minimal and advanced `slim: 'source'` fixtures measure 490,030 raw / 136,793
gzip and 519,550 raw / 144,719 gzip respectively; both retain 2 Node modules /
1,190 rendered bytes. Production caps are tightened to 770,000 raw / 212,000
gzip, 2 prebuilt Node modules / 2,500 rendered bytes, 139,000 and 147,000 source
gzip, and 2 source Node modules / 1,536 rendered bytes. Compiler, stock-adapter,
and duplicate bare-Three identity counts remain zero. The direct
`webgpu_materials_envmaps_groundprojected` capture/replay canary is
pixel-identical (infinite PSNR, 20 material plus 2 auxiliary artifacts).

The canary also exposed two independent harness faults, fixed separately: the
hash domain is now read from the signed slim provenance stamp rather than an
incidental minified object literal, and replay's wrapper forwards exports from
the same cache-busted bundle URL it imports, preserving one ESM module and one
aux registry identity.

**Zero stock Node/TSL runtime (2026-07-13).** The final retained Three Node
owners were `nodes/core/NodeUtils.js` (only `hash`, `hashArray`, and
`hashString` remained live) and `nodes/core/constants.js` (only `NodeAccess`).
The private runtime owner `slim-replay-node-core-primitives.js` now preserves
the exact r184 cyrb53 arithmetic and access strings. Runtime-owned consumers
import it directly; complete comment-free compact-AST SHA gates rewrite the
two Three modules to pure four-symbol re-export shells. Both modules are also
classified as forbidden stock-adapter residue, so semantic drift rejects the
rewrite and any rendered stock byte fails the build. A new consumer of an
omitted export fails at ESM link time instead of silently expanding the shim.

At that checkpoint, the safe primitives remained useful to developers:
`NodeUtils.hash*`, the named
`NodeAccess` export, and `TSL.NodeAccess` now work in slim mode, while compiler
and type-construction helpers still fail loudly. The source/runtime handshake
advanced to `slim-three-policy@8`, and retained-Node budgets were locked to zero
modules / zero bytes for every profile. The strict prebuilt measured 768,403
raw / 210,865 gzip-9 bytes, 332 modules, and zero retained Node/TSL modules.
Minimal and advanced `slim: 'source'` fixtures measured 490,175 raw / 137,680
gzip and 519,695 raw / 145,631 gzip respectively, also with zero Node/TSL,
compiler, stock-adapter, or duplicate bare-Three identity residue. The narrow
storage `webgpu_compute_reduce` canary passes with no replay errors; the
ordinary `webgpu_materials_envmaps_groundprojected` canary remains
pixel-identical (infinite PSNR, 20 material plus 2 auxiliary artifacts).

**Material-owned compute contract and transactional replay (2026-07-15).**
The shared contract now emits and validates `materialCompute`: embedded kernel
artifacts, exact resource/render-binding identities, initial state,
lifecycle/cadence paths, and deterministic schedule order are material-global
rather than duplicated per render variant. `precompiled` mode hydrates proven
storage-buffer kernels without retaining a live Node graph. Storage textures
and other unsupported proofs remain `hybrid-required`; that mode retains exact
raw kernels only where required, pre-shares sampled/read-only inputs, synchronizes
only contracted writable outputs, invalidates replaced full-renderer bind
groups, and aligns the delegated renderer's logical `NodeFrame` without
advancing its render cadence. Dispatch is serialized and transactional: every
support-owned lease is revoked before the next scene walk, failed or incomplete
sync remains closed, and material initialization is cached per renderer plus
backend `GPUDevice` generation so device replacement cannot reuse stale state.

**Durable represented families and initial validation (2026-07-15).**
The represented root payload in an artifact family map is now authoritative and
is projected back onto the durable root while root-only metadata is preserved.
Private cache keys stay scoped to their family; equivalent cross-family
selectors are canonical-unioned and
divergent payload collisions fail closed. The dev capture server serializes
family merge, validation, content-addressed write, manifest replacement, old
artifact pruning, and HMR publication through one queue. That validation now
also covers the first signed user capture, so invalid initial families cannot
create an artifact, manifest entry, or HMR event.

**Runtime identity and source-surface diet (2026-07-15).** Production generated
helpers now alias their exact runtime subpaths into the same checked prebuilt
runtime; the consumer gate requires exactly one runtime, one prebuilt bundle,
and zero `runtime/src` copies. Replay lighting no longer pulls the broad stub
module, both renderer constructors use the graph-free `ReplayNodeLibrary`, and
strict policy `slim-three-policy@10` forbids the stock owner. The exact r184
`Loader` constructor installs texture tracking only when a concrete loader is
created, removing the eager fetch/cache/loader closure from loader-free source
builds while preserving Three constructor identity. Allocation-only compatibility
stubs are annotated pure so unused Node-material shells tree-shake; a broad
package `sideEffects: false` was tested and rejected because it removes required
bootstrap and policy effects.

The historical deterministic budget snapshot (2026-07-17, gzip-9) was: prebuilt
769,879 raw / 211,646 gzip bytes (341 modules); generated-helper consumer
582,641 raw / 164,168 gzip (3 modules); minimal source 494,053 raw / 138,279
gzip (182 modules); advanced source 522,700 raw / 145,910 gzip (192 modules). Every
profile reports zero compiler, stock-adapter, and retained Node/TSL residue;
the source profiles also report zero duplicate bare-Three identity residue,
and the helper consumer contains one prebuilt runtime with no runtime-source
copy.

---

## 2026-06-09 audit refresh — corrections to the map

A verified architecture+performance audit (56 findings raised, 26 confirmed after adversarial verification) re-measured this document against the tree. Its dated measurements are historical unless a bullet explicitly says it was rechecked; the current corrections below keep later sections readable:

- **Current metrics (rechecked 2026-07-30).** `hydrator.js` is **1,402 LOC**, backed by **36** focused JavaScript files under `hydrate/`; `aux-marker.js` is **2,688 LOC**; and `slim-support/scene-support.js` is **1,749 LOC** inside a **31**-module JavaScript support surface. [`run-e2e.mjs`](packages/examples/batch/run-e2e.mjs) is now **5,495 LOC**: its **13,269 LOC** injected browser replay factory lives in the separately fingerprinted and directly tested [`e2e-slim-replay-module.mjs`](packages/examples/batch/e2e-slim-replay-module.mjs). Reusable artifact metrics, compressed artifact output/replay, evidence/provenance, environment identity, selection, screenshot handling, settle policy, browser stabilization, workload policy, and output safety also live in focused modules with direct tests. Because active extraction changes these counts frequently, use `wc -l` when quoting them rather than treating this dated snapshot as an invariant.
- **The audited hydrator regrowth was feature work, not failed decomposition.** At the 2026-06-09 audit, the 656→1,008 growth came from Tier C MRT variant selection (`selectArtifactVariant` + merge views, commits `6a15d662`/`0858b65e`) and live-uniform sidecar/skeleton state (`2e1e32cf`). Focused `hydrate/variants`, `kinds`, writers, and rebinder modules have since landed; §P0.2 now tracks the remaining orchestration seam.
- **At the 2026-06-09 audit, §P0.1 omitted 11 of 17 slim-support modules** that had landed after its original status write-up. That historical count is not the current surface; the current status below names the product boundary, while its next step continues to track harness-only policy.
- **The slim bundle regression was fixed at the bundler, not by budget bumps.** The gate in [`slim-bundle.test.js`](packages/plugin/test/unit/slim-bundle.test.js) had been bumped 263 → 420 KB gzip; the checked-in bundle measured 1.59 MB raw / ~407 KB gzip. The audit's per-module analysis found the growth was **not** feature cost: (1) runtime modules importing from bare `'three'` resolved to the *prebuilt* `three.module.js`/`three.core.js`, bundling ~2 MB of three a second time on top of `three/src/**`; (2) `WebGPURenderer.js`'s static `WebGLBackend` import dragged the whole `webgl-fallback/**` subtree, including a second shader compiler, into the then-WebGPU-only bundle. The historical @11 fix redirected that backend to a throwing stub. Policy @12 deliberately retains the backend implementation for native GLSL replay while its `GLSLNodeBuilder` remains forbidden compiler residue, so its measured backend cost is now intentional. Lesson under §P0.5 still applies: run the analyzer before changing a budget and separate compiler residue from required backend runtime.
- **§P1.8's gap 2 is confirmed closed in code**: aux-artifact injection runs in any production build, not just slim ([`packages/plugin/src/index.js:392-397`](packages/plugin/src/index.js#L392-L397)).
- **`aux-marker.js` and `aux-loader.js` had no entry in this document** despite being two of the largest runtime files — now tracked as §P2.11 (currently **2,688** and **1,223 LOC**).
- **New items from the audit:** §P1.9 (per-render resolution caching — first wedge landed), §P2.11 (aux pipeline doc/convergence), §P2.12 (startup hydration caching — several wedges landed), §P3.13 (bundle surface diet — partially resolved by the gate fix above).
- **Performance quick wins landed with the audit (2026-06-09):** per-binding `DataView` cache + clipping change-detection + `(group,binding)→planEntry` memo + variant-view memo in [`hydrator.js`](packages/runtime/src/hydrator.js); per-artifact WGSL/regex query cache in [`hydrate/texture-resolver.js`](packages/runtime/src/hydrate/texture-resolver.js); snapshot identity-keyed cache in [`hydrate/texture-snapshot.js`](packages/runtime/src/hydrate/texture-snapshot.js) (fixes a same-shape collision hazard); LTC boxed-array release in [`hydrate/builtin-textures.js`](packages/runtime/src/hydrate/builtin-textures.js); gated shadow-diagnostic payload construction in [`hydrate/rebinders/shadow-depth-rebinder.js`](packages/runtime/src/hydrate/rebinders/shadow-depth-rebinder.js); harness diagnostic removed from `writeColor` in [`writers.js`](packages/runtime/src/writers.js); artifact-path watcher filter + HMR batch window in [`packages/plugin/src/index.js`](packages/plugin/src/index.js) / [`dev-capture-server.js`](packages/plugin/src/dev-capture-server.js).
- **Deliberate non-changes** (verified intentional; do not "fix"): the serial e2e loop and 2-runs-per-browser recycling (the parallel runner froze machines ~150 examples in — deleted in `ee4ae2e3`; documented next to `MAX_RUNS_PER_BROWSER` in `run-e2e.mjs`); `slim-entry.js`'s aux-loader import (it is exported slim API surface, not a one-call import).
