# Vendoring

Files in this directory are copies of code from the three.js fork branch `tsl-precompile` (at github.com/Makio64/three.js/tree/tsl-precompile).

We vendor instead of depending on the fork as an npm package because the plugin's stated goal is "works with any three.js project" — users install stock `three` + this plugin, not a forked three.

The published plugin carries the complete upstream Three MIT license and
pinned source provenance in `THIRD_PARTY_NOTICES.md`. Keep that notice in the
package allowlist and its tarball regression whenever vendored Three-derived
code is present.

## Current vendored files

Local r185 MRT identity assumption: Three's private context IDs can repeat in
independent page loads with different attachment layouts. `compileTSL` stamps
backend-aware family keys after extracting MRT names/count/blend modes so the
shared contract can disambiguate these layouts. Legacy keys remain readable;
render-selector collisions still reject conflicting shader/binding payloads.

Three r185 clears its WebGPU sampler cache in `backend.dispose()` before it
disposes NodeManager. Replay-owned PMREM targets must be released before that
cache is cleared. The Renderer rewrite inserts `disposeRendererResources()`
at this exact boundary; NodeManager's later disposal is idempotent.

Renderer.render() schedules renderer-owned captured shadow maps immediately
before its one `_renderScene(scene, camera)` call. The initialized-backend check
stays first. The scheduler guards nested shadow draws and currently handles
ordinary 2D directional/spot Basic, PCF, PCFSoft, and VSM targets. Generated aux
tables supply this capability only when shadow-depth artifacts are present.

Three's standalone `UniformBuffer_<id>` labels are allocation-local metadata;
PMREM blur shaders use their binding positions instead. Both PMREM extractors
give these labels a stable group/binding address before constructing the shared
internal-pass descriptor or signing the artifact. Shader bytes and buffer values
remain untouched, and every represented variant retains matching descriptors.

Local r185 storage assumption: `StorageBufferNode.bufferCount === 0` emits a
WGSL array with no compile-time length. Capture carries `runtimeSized: true`
on that binding and its uniform-plan record; public compute descriptors retain
the same flag. Allocation count/bytes may vary at replay, while element type,
access, and exact resource ownership remain checked. Fixed arrays retain their
captured count/byte checks. This flag does not make a fixed shader array dynamic.

Standalone compute capture uses `computeOnly` to read already-dispatched
kernel states without compiling or traversing the host scene. Uncached explicit
kernels retain the compute dispatch fallback. Material markers pass their
exact owner in `materials`, so unrelated auxiliary programs accumulated in the
renderer cache cannot invalidate an otherwise valid material capture. Ordinary
scene/auxiliary extraction retains the full family checks. Auxiliary callers
can narrow extraction with `materials` or `materialShapes`. Shadow capture
requests flat depth candidates with `deferShadowFamilyMerge`, then performs
the existing exact-selector cache-key disambiguation and strict family merge
over the complete caster batch before writing any artifact.

Authored marker names are carried through the contract's
`MATERIAL_SHADER_FAMILY` sidecar into shadow-caster selectors. This distinguishes
different custom shadow graphs with identical node-presence flags without
retaining live graph structure in compiler-free replay. The dev marker and both
production apply paths must preserve the same identity.

| File | Upstream | Version tag | Reason to vendor |
|---|---|---|---|
| `compileTSL.js` | `src/nodes/precompile/compileTSL.js` | tsl-precompile @ dc09e30 | Extractor core — walks `renderer._nodes.nodeBuilderCache` and emits JSON artifacts. |
| `extractUniformPlan.js` | `src/nodes/precompile/extractUniformPlan.js` | tsl-precompile @ dc09e30 | Classifies every TSL update node into a serializable `source` descriptor. |

`render-object-observer.js` is a local dev-only adapter, not an upstream copy.
It is the single owner of the private `renderer._nodes.getForRender` build tap
and `renderer._objects.get` cached-request tap used by extraction. Keep new
live-capture subscribers on that adapter so HMR and duplicate plugin copies
cannot stack independent wrappers.

`capture-render-object-lifecycle.js` subscribes through that same cached-request
tap for scenes explicitly marked `__tslpSyntheticCaptureScene`. It releases only
RenderObjects whose scene and mesh identities belong to the throwaway capture,
after all artifact extraction and before the renderer compile lock is released.
Three r185's RenderObject registers material/geometry disposal listeners which
retain its scene; Renderer.dispose() does not remove those material listeners.
RenderObject.dispose() removes its own listeners and calls RenderObjects' owning
cleanup callback, preserving NodeManager's reference counts for shared shader
states. Caller materials/geometries, real-scene RenderObjects and borrowed harvest
families remain live. Keep these identity and reference-count assumptions covered
when upgrading Three.

The adapter also owns the direct-harvest compatibility seam. The installed
Three revision reuses each `RenderContext` and mutates its `renderTarget`,
`activeCubeFace`, `activeMipmapLevel`, attachment, sample, and MRT fields
between requests, so the adapter copies those fields and creates the canonical
render-object selector synchronously when `RenderObjects.get()` returns. A
cached RenderObject may skip `NodeManager.getForRender`; in that case the
adapter reads `renderer._nodes.nodeBuilderCache.get(cacheKey)`. New/async
states are correlated later by the pair `(renderObject.material, cacheKey)`.
`beginRenderObjectHarvest(renderer)` exposes one bounded epoch whose completed
families can be passed to `compileTSL(..., { renderObjectHarvest })`. Consumers
must adopt a complete family atomically; an unavailable state or selector makes
the whole material family fall back to synthetic extraction.

Local assumption: Three r185's `compileAsync()` queues mutable material
references after selecting transparent back/front sides, restores DoubleSide,
and builds the queued work afterward. The local
`compile-async-double-pass.js` adapter temporarily routes only a matched
`backSide` request and its following front request through r185's own synchronous
`_createObjectPipeline` branch, while the selected side is still active. Keep
the pass ID, pair counting, private method restoration, and the focused
two-sided transmission regression together when upgrading Three.
The same module temporarily suppresses backend framebuffer copies during
`compileAsync`: r185 restores the previous render context before queued
`updateBefore` nodes run, so a transmission viewport copy otherwise ends and
finishes the prior frame's already-submitted encoder. Keep the renderer-level
copy method live for texture allocation/wiring, restore the backend method on
every settlement path, and apply both adapters together in capture and replay.

The slim Renderer rewrite shape-checks the complete queued compilation loop.
Replay hydration is synchronous, so it calls `getForRender` directly and replaces
the unconditional per-object scheduler/RAF yield with a four millisecond budget.
The legacy r185 fixture retains its original pipeline/callback barriers. Verified
r186/r187 source can overlap independent replay pipelines as described below.
Keep executed loop, callback-barrier, bounded-batch and drift tests with this gate.

Three r185's `NodeFrame` deduplicates a viewport node's `updateBefore()` by the
live texture returned from `updateReference()`, not by the viewport node or its
material. After the warm-up render, the extractor persists equality of those
non-default references as an ephemeral `viewportIdentity`; replay pools one
copy source per identity and schedules it by the new render target's live
reference. This preserves both shared and distinct copy cadence without trying
to resolve a dead capture texture. Keep the reference proof, identity remap,
live-reference schedule, and MaterialX multi-glass regression together when
upgrading Three's viewport-node lifecycle.

Three r185's `RangeNode.setup()` creates large-range outputs as a
`Float32Array(count * 4)` using one `Math.random()` call per physical lane and,
above the uniform-buffer limit, installs the exact `InstancedBufferAttribute`
at `builder.geometry.getAttribute('__range' + node.id)`. Development setup
replaces only that version-checked physical branch with the equivalent public
`InstancedBufferAttribute`/`TSL.instancedBufferAttribute` construction fed by
the local `range@1` generator. It never reads or replaces `Math.random`, then
verifies the installed array byte-for-byte before `compileTSL.js` accepts its
private recipe sidecar. Scalar and uniform-buffer paths keep the stock setup
and random call count; unsupported revisions/exports retain the stock snapshot
path. Extraction reverifies the current array in case it changed after setup.
If the key, storage type, interpolation formula, public factory, limit rule, or
setup timing changes, disable the replacement until this adapter is updated.
Keep the real r185 RangeNode integration and Math.random-isolation tests with
this assumption when upgrading Three.

Three r185's `InstanceNode._createInstanceMatrixNode()` exposes the live
`InstancedMesh.instanceMatrix.array` through one stride-16
`InstancedInterleavedBuffer` and four vec4 `InterleavedBufferAttribute` views
at offsets 0/4/8/12 with `meshPerAttribute === 1`. The extractor records the
`instance-matrix@1` reference only when the live Float32 array identity, stride,
step rate, item size, count, instancing flag, and offset all match. Replay uses
four interleaved views over the active array and delegates their buffer version
to `instanceMatrix.version`, so later `needsUpdate` changes remain live without
copies. Never replace that proof with identity-value or attribute-name
inference; unrelated application buffers can have the same values and shape.
Below Three's uniform-buffer limit, the same InstanceNode is lowered instead to
a fixed `array<mat4x4<f32>, N>` NodeUniformBuffer. Both the exact render-context
signature and the compiler-free selector therefore retain the physical
`instanceMatrix.count`; mutable `object.count` is only a draw limit and must not
select WGSL. Keep the multi-capacity instancing regression when either lowering
path changes.

`RenderObjects.get()` returns before Renderer assigns the current geometry
group to `renderObject.group`, and shadow rendering has already replaced the
caster material by then. The adapter therefore also owns one Symbol-shared
`renderer.renderObject(...)` wrapper. A nested synchronous dispatch stack lets
the inner `RenderObjects.get()` snapshot copy the exact pre-override object,
selected material, geometry, and group scalars. Requests emitted outside that
dispatch (including some synthetic compile paths) remain explicitly inexact;
they may preserve compatibility evidence but cannot stamp durable
`shadow-caster` binding ownership. Keep this as the only Renderer call-site
patch so duplicate plugin copies and HMR cannot stack competing wrappers.
An active legacy v1 request wrapper is reused rather than replaced during an
HMR handoff; its requests remain ownership-incomplete until that bounded
capture epoch finishes, which fails closed instead of creating a second
private-method wrapper or guessing caster ownership.

Local assumption: Three r185's `Renderer._getShadowNodes()` represents a
caster `map` with a plain `ReferenceNode` whose stable `.object` is the exact
source material. `Renderer.renderObject()` instead copies `alphaMap` and
`alphaTest` onto the shared shadow override before its implicit
`MaterialReferenceNode`s run; it does not copy `opacity`. Extraction therefore
uses the full exact-owner identity set, never texture UUIDs or the mutable
`.reference` field. The artifact's `shadow-caster` owner is the compact
default, while shader-owned material inputs such as opacity serialize a
source-local `render-material` exception. Update both the copied-property
contract and the real shadow fixture if an upstream Three bump changes this
call-site behavior.

Exact shadow ownership also qualifies serialized graph paths. A
caster-owned `uniform.live.nodePath`, node-attribute `userPath`, or storage
buffer `userPath` is recorded relative to the process-local exact caster Set,
never the shared shadow override. A path is serialized only when every caster
exposes a compatible resource at the same public node path; otherwise capture
omits it and replay uses its owner-local snapshot/shape fallback. Source-local
`render-material` live uniforms continue to resolve paths against the override.

Anonymous `uniform.live` values that exist only inside `Fn()` closures use a
plugin-owned call-site sidecar rather than an upstream Three field. The Vite
transform stamps each direct imported `uniform()` call with a stable module,
syntactic-call, and per-call occurrence identity; `compileTSL` reads that
non-enumerable Symbol and serializes it beside artifact-local `liveNodeId`.
Do not replace this with `Node.id`, generated uniform names, or registry-global
order: all three are process-local and can diverge across HMR or slim replay.

DOM-backed texture images expose same-document URLs as absolute strings. The
extractor canonicalizes only URLs proven to share the current HTTP(S) document
origin to `pathname + search + hash`; cross-origin URLs remain absolute. Keep
that capture rule aligned with the runtime live-texture alias index and exact
texture-wiring comparison. Otherwise changing a dev server port creates a
false artifact-family collision, while basename-only replay can silently bind
the wrong texture when two directories contain the same filename.

Shadow material cache keys are local to each renderer-owned per-light material
family; r185 can reuse the same numeric key for equivalent directional and
point-shadow payloads even though their render-target selectors differ. Aux
capture must merge every observed shadow family through the shared artifact
variant contract. Equivalent same-key payloads canonical-union their semantic
selectors; divergent same-key payloads fail closed because the serialized
`variants` map cannot represent both without a contract migration. Never use a
last-writer-wins cache-key assignment here: it silently drops cube-face point
shadow coverage.

VSM filtering is a separate captured renderer-owned family. Three r185 names
the two private materials exactly `VSMVertical` and `VSMHorizontal`; their WGSL
is harvested from the live render, not reconstructed. Ownership is recovered
through `AnalyticLightNode.shadowNode`, and the durable `internal-pass@1`
descriptor maps `blurSamples`, `radius`, `mapSize`, raw shadow depth, and the
vertical intermediate to semantic roles. Keep material-name classification,
cross-entry light ownership, and those source kinds covered together when
upgrading Three.

The family identity is `shadow-vsm-support@1`, not a scene/light signature.
For native r185 WebGPU the vertical pass loads a non-comparison, nearest
2D depth binding and both passes write RG/HalfFloat moments; compatibility
mode has a distinct unfilterable-float depth binding. Map size, light type,
blur radius, and blur sample count stay live uniforms. Capture rejects layered
or nonstandard resource evidence before stamping this 2D contract so an
upstream target-topology change cannot silently reuse the compiler-free
family.

Slim replay has a separate build-time AST seam at r185's direct
`material = overrideMaterial` assignment. At that expression the right-hand
`material` is still the exact selected caster (including an array/group
selection), while the override already holds Three's copied `alphaTest`,
`alphaMap`, `transparent`, and `side`. The rewrite replaces only that handoff
with `createReplayShadowMaterial( overrideMaterial, material )` and unwraps
only the `onAfterRender` material argument. Keep both shapes gated exactly
once; do not move ownership recovery into `_renderObjectDirect()`, where
`RenderObject` has already been keyed by the shared override.

The same Renderer rewrite removes r185's `_getShadowNodes()` method, its
constructor WeakMap, the one shadow-pass call, and the three override node
assignments. The precompiled shadow artifact already owns those color/depth/
position branches, and complete directional/point/custom families are merged
before registration. Preserve the VSM/non-VSM `side` selection, copied alpha
state, replay-material handoff, and the `castShadowNode` transmitted warning;
the warning is re-emitted as a graph-free material flag check at the removed
call site. All removal counts and the original method's TSL construction shape
are strict gates so an upstream Renderer drift cannot silently retain or skip
part of the stock graph closure.

`CubeRenderTarget.fromEquirectangularTexture()` is another exact r185 slim
rewrite seam. Capture builds the stock
`texture( source, equirectUV( positionWorldDirection ), 0 )` graph once and
keys it by the shared plain source-texture plus destination-target descriptor.
Replay preflights the private cube-render-target adapter before the method's
first source mutation/allocation, replaces the local `NodeMaterial` with that
validated result, then removes the now-unused UV declaration and all four graph
imports. The rewrite strictly verifies the entire method body: constructor,
texture/UV/level call, `BackSide`, `NoBlending`, CubeCamera's six renders, MRT
save/restore, temporary min-filter/mipmap changes, both disposals, and return.
Its selector profile deliberately ignores active cube face, mip, compatibility
mode, and attachment debug names because those do not change this helper
shader; format, samples, depth/stencil, and attachment topology remain signed.
Update the rewrite fixture, capture helper, descriptor contract, and direct
cubemap canary together if upstream changes this method.

The last retained Three Node-core owners have exact whole-module r185 seams.
`nodes/core/NodeUtils.js` is replaced by pure named re-exports of only `hash`,
`hashArray`, and `hashString`; `nodes/core/constants.js` is replaced by only
`NodeAccess` and `NodeUpdateType`. Their implementation lives in the private
`node-core-primitives` rewrite runtime module so the slim graph does not retain
the stock modules' unused math, stack-trace, type-construction, and node-stage
exports. Each gate fingerprints the complete comment-free compact AST, not raw
source formatting. Any import, declaration, expression, or export drift rejects
the rewrite. If a future retained Three path consumes one of the deliberately
omitted exports, ESM linking must fail; do not grow the private primitive
surface until the new consumer and its slim-runtime need are reviewed. Update
both fingerprints, the five-export fixture, the residue policy, and focused
bundle metrics together when upgrading Three.

Three r185's `loaders/Loader.js` is also an exact whole-module slim seam. Its
constructor is preserved as the same public class and receives one final
`installTextureLoaderTracking( this.constructor )` call. The call patches the
concrete subclass only when it is instantiated, so loader-free source builds
do not retain TextureLoader/CubeTextureLoader/DataTextureLoader plus their
image, file, fetch, and cache closure. This is intentionally a base-constructor
rewrite rather than wrapper subclasses: wrapper exports would split constructor
identity, while a generic Texture update hook loses the loader URL needed to
relink unnamed artifact textures. The complete comment-free compact Loader AST
is fingerprinted; update its focused rewrite fixture and source bundle metrics
with the fingerprint when Three changes any Loader behavior or export.

Local assumption: `Object3DNode` instances with an explicit `object3d.isCamera`
target are serialized as `object3d.*` sources with `target: "camera"`. This
preserves TSL like `objectPosition(camera)` in post-processing passes, where
replay's draw object and render camera are the fullscreen quad rather than the
source scene camera.

Local assumption: Three r185's TRAA pass assigns its unjittered current
projection object to each `VelocityNode.projectionMatrix` while the render
object is requested, then clears that field after the pass. The generated
anonymous projection `UniformNode` retains the same object in the cached
`NodeBuilderState`. The render-object observer therefore records only that
exact object identity before the clear. The bounded request snapshot and its
completed material-family harvest retain that identity alongside the selected
builder state, so deferred extraction can still classify the matching value as
`velocity.currentProjectionMatrix` if Three replaces or clears the live
VelocityNode first. Never infer this source from matrix contents, generated
uniform names, or lifecycle ordering. Keep the observer/extractor exact-identity
tests and SSGI velocity-buffer canary together when upgrading Three's TRAA or
VelocityNode lifecycle.

Local assumption: Three r185's `NodeStorageBuffer` keeps the authored
`StorageBufferNode` on `binding.nodeUniform`, and an explicit `setName()` value
survives on `binding.nodeUniform.name`. The binding's own `name` is a generated
`StorageBuffer_<id>` token, so extraction serializes only the non-empty authored
node name as the stable storage-attribute identity. Update the focused storage
extractor fixture if an upstream Three bump changes this ownership seam.
Anonymous same-shape resources instead carry a signed resource ordinal and
cardinality derived from exact capture-time attribute identity ranked by
`BufferAttribute.id`. The complete selected `compileTSL()` artifact batch is
signed together because one material may consume `instanceWorld` while another
consumes the same-shaped `instanceMvp`; per-plan ranking cannot see that family.
Replay independently ranks the complete live family by the same monotonic
construction identity, so compute dispatch/discovery order cannot exchange
resources. Entries with an exact non-empty `userPath` are outside anonymous
cardinality unless the same live attribute also has a pathless alias; replay
resolves those entries through the path before anonymous ranking. Missing,
duplicate, or incomplete identity evidence fails closed; never weaken that
gate to shape-only first-match.

Local assumption: a storage attribute can be render-only and anonymous. It
therefore has neither an authored `userPath` nor a compute bind group through
which replay can recover its initial data. After the complete selected render
and compute batch is extracted, `compileTSL()` snapshots only those exact
compute-invisible live attributes. Aliases of one capture-time attribute share
one typed snapshot/checksum object; compute-owned attributes remain generated
runtime outputs and must never be serialized merely because a render artifact
also consumes them. The contract verifies typed length and checksum before the
hydrator seeds a fallback `StorageBufferAttribute`.

Local assumption: analytic-light sources carry a Symbol-keyed capture record
from `@tsl-precompile/contract/light-identities` until `extractArtifact()`
normalizes them into one variant-local `lightIdentities` table. The public
`Light`, `LightShadow`, and shadow-camera properties are read for matching
evidence; process-local `Object3D.id` is never persisted as durable identity.

Local assumption: stock Three exports `UniformNode` from `three/webgpu`, and
the high-precision model-view, normal-view, and shadow-model UniformNodes are
created lazily after `extractUniformPlan.js` loads. The extractor installs one
identity-scoped `UniformNode.onUpdate` wrapper that retains original callbacks
in a WeakMap. It classifies only exact r185 callback shapes; it never executes
arbitrary object-update callbacks. The exact stock shadow callback may be
evaluated once against a detached result matrix to recover its closed-over
light-shadow matrix identity. Update the callback-shape fixtures whenever an
upstream Three bump changes these bodies.

Local assumption: Three r185 exports `materialEnvIntensity` and
`materialEnvRotation` from `three/tsl`; the compiled PBR state retains those
exact singleton UniformNodes. `PMREMNode` remains a render-update-before node
with private `_texture`, `_width`, `_height`, and `_maxMip` fields, where
`_width`/`_height` hold CubeUV texel width/height. Extraction binds all three
scalar uniforms to `_texture.value.uuid`. Replay recomputes them from the
wired PMREM atlas using r185's exact formula:
`maxMip = log2(image.height) - 2`, `texelHeight = 1 / image.height`, and
`texelWidth = 1 / (3 * max(2 ** maxMip, 7 * 16))`. If any field, lifecycle
phase, singleton export, or formula changes, fail the focused extractor tests
and update the contract/runtime writers together; do not fall back to
route-specific frozen snapshots.

The r185 `fromScene()` scheduler mutates its output target to
`depthBuffer = true`, while the shared ping-pong target is constructed with
`depthBuffer: false`. WebGPU render-object harvesting can omit the false
`RenderContext.depth` field even though the target topology is known.
PMREM-family capture canonicalizes only that exact omitted/null-depth-texture
case to `depth: false`; the depth-owning selector remains separately signed.
Do not generalize this normalization to arbitrary material targets.

## Import rewrites

The vendored files originally imported from relative paths inside `three/src/nodes/**`. Those paths don't exist in the stock `three` package the plugin depends on. Rewrites:

| Vendored file | Original import | Rewritten to |
|---|---|---|
| `extractUniformPlan.js` | `'../accessors/ModelNode.js'` (`modelNormalMatrix`, `modelWorldMatrixInverse`) | `'three/tsl'` |
| `extractUniformPlan.js` | `'../accessors/MaterialProperties.js'` (`materialEnvIntensity`, `materialEnvRotation`) | `'three/tsl'` |
| `extractUniformPlan.js` | `'../utils/Timer.js'` (`time`, `deltaTime`, `frameId`) | `'three/tsl'` |

If a future `three` release drops any of these exports from `three/tsl`, bump the version row above and add a compat shim in `_shared/three-compat.js`.

## Upgrade procedure

When bumping to a newer three.js version:

1. Run `pnpm verify` BEFORE re-vendoring to snapshot current artifact hashes.
2. Copy the newer source files into `src/vendor/`.
3. Re-apply the import rewrites above.
4. Run `pnpm test:three-rewrite` — every rewrite shape probe must stay green.
5. Run `TSLP_FAIL_ON_REWRITE_WARNING=1 pnpm --filter @tsl-precompile/runtime build:slim`.
6. Run `pnpm test:coverage` — every covered source.kind must still pass its fixture.
7. Run `pnpm verify` AFTER — artifact hashes WILL change because the three-version is part of the hash. Expected. Update the "Version tag" column above.
8. Recapture example artifacts (`pnpm` example recapture / `packages/plugin/src/cli/recapture-all.js`) and refresh visual baselines only when intentionally updating evidence.

### Supported baseline: `three@0.185.1` / `slim-three-policy@12` (2026-08-02)

The workspace, public peer dependencies, examples, lockfile, and guarded slim
source policy now use exact `three@0.185.1`. Validate compatibility work
against the official `r185` tag: that checkout must report package version
`0.185.1` and `REVISION === '185'`. Do not probe a nearby development checkout
or a directory whose package metadata and source revision disagree.

The r185.1 compatibility wedge includes these coupled changes:

- `WebGPURenderer` retains r185's real `WebGLBackend` selection and automatic
  fallback. The slim rewrite removes `GLSLNodeBuilder.createNodeBuilder()` but
  preserves the backend pipeline/resource implementation. `compileTSL`
  therefore records the detected native `shaderLanguage` plus a backend-aware
  `variantKey`; the raw private cache key remains untouched for Three routing.
- Artifact emission may pool both languages, but `minifyWgsl` compacts WGSL
  only. GLSL stays byte-for-byte intact because its `#version` directive is
  line-oriented.
- `NodeUtils.js` has the exact compact-AST fingerprint
  `aa735f703cc42fb24da1a6398d4c2946f1be36ff07fead14f52becb8f4f60edd`.
  The constants and Loader fingerprints are unchanged from r184, but are
  re-gated as r185 inputs. The graph-free constants surface now includes
  `NodeUpdateType` beside `NodeAccess`.
- `WebGPUBackend` moved its `bindingsData` declaration inside the bind-group
  cache-miss branch and changed `updateSampler(texture)` to
  `updateSampler(binding)`. The rewrite recognizes only the exact old/new
  ownership shapes and initializes replay samplers through the installed
  signature; any third shape fails closed.
  The draw cache stores the native `GPUBindGroup`, since replacing a texture or
  buffer can replace that resource while retaining the CPU `BindGroup.id`.
  Unchanged groups remain cached across draws; Three resets the cache for each
  new render pass or bundle. ArrayCamera's manual `indexesGPU[i]` binding uses
  the same native identity cache, with a one-draw override keyed by the camera
  binding id. Both cache writes and the old/new lookup placement are gated.
- r185 `NodeBuilderState` carries `hardwareClipping`, and `RenderObject`
  consults it when exposing hardware clipping planes. Replay hydration carries
  the field, `ReplayNodeManager.updateGroup()` always updates
  `NodeUpdateType.OBJECT` groups, and array-output replay implements
  `setOutputLayerIndex()` for Renderer’s per-layer output pass.
- r185 lighting calls `beginRender(scene)` / `finishRender(scene)` around
  mutable per-scene light state. Replay lighting is enabled by default and
  restores a nested render stack rather than leaking an inner render’s lights.
- r185 `compileAsync()` uploads the final bind groups after
  `NodeManager.updateForRender()` initializes object/camera matrix uniforms.
  Synthetic RenderPipeline captures suppress only `updateBefore` and
  `updateAfter` for their private final-quad material; suppressing the ordinary
  update phase leaves matrix uniforms null and fails in
  `NodeUniformsGroup.updateMatrix4()`.

Generated artifacts are not portable across this revision boundary. Recapture
every example material, compute, and auxiliary artifact—including legacy
versionless files whose native shader source was produced by r184—then refresh visual evidence
through the capture tools. Never hand-edit artifact JSON or screenshots.
Fresh browser auxiliary captures sign both their envelope and manifest entry
with exact Three/toolchain versions. Production codegen fails closed on absent
or mismatched provenance, while `pnpm verify` compares those stamps with the
locked baseline. Legacy versionless files are accepted by dev loading only so
the capture route can replace them.

Keep the landing evidence together: exact-tag provenance, one resolved Three
identity, `pnpm test:three-rewrite`, a strict slim build with
`TSLP_FAIL_ON_REWRITE_WARNING=1`, generation/coverage tests, `pnpm verify`, all
example production builds, and the configured visual gate. The locked r185.1
matrix is the shipping baseline; the latest-version matrix remains the
early-warning signal for the next upstream drift.

## Why not publish `@tsl-precompile/three-core`?

We considered publishing a forked three as an npm package and depending on it. Rejected because:

- Users would need to install a custom three, breaking ecosystem tools (glTFLoader, addons, other plugins) that pin on `three` peer-deps.
- Version drift with upstream becomes a sustained maintenance burden.
- Vendoring isolates the plugin's "dangerous" imports from the user's stock
  Three package; the plugin advances its exact supported revision deliberately.

Trade-off: a three.js internal API change (e.g. `renderer._nodes.nodeBuilderCache` renamed) silently breaks the plugin until we re-vendor. Mitigation: CI runs the Node harness against three.js's current `latest` tag nightly; regressions are caught before users hit them.

## Compatibility diagnostics

### Verified r186 and pinned r187dev source seams

Stable source is Three `0.186.1`, revision `186`, commit
`9b4a2ac29c63ccb43fd51c5661f2f873ac2c39b8`. Development source is revision
`187dev`, nominal package `0.186.0`, commit
`3995acf2a9e79ebd2b02c0e9e7f820fa2a4838fb`. The shared
`THREE_RELEASE_PROFILES` records the complete source fingerprints, Git trees and
exact identities. A package version alone does not identify development source.
Current-source tests import `src/Three.WebGPU.js` directly, so an older generated
development bundle cannot substitute for the pinned source.

`three-rewrite-compilation-loop.js` pins the complete semantic work-loop AST for
each supported source shape. Stable r186 brackets synchronous binding updates
with `_isPreCompiling` and calls `updateAfter` after native pipeline completion.
The pinned development source uses `_beginPreCompile`/`_finishPreCompile`, passes
a yield callback into async graph construction, and calls `updateAfter` before
the pipeline wait. Replay replaces graph construction with synchronous hydration
and retains each source's callback and native pipeline barriers for dependent
objects. Proven precompiled WebGPU objects with empty `updateBeforeNodes` and
`updateAfterNodes` submit batches of at most 16 asynchronous pipelines. Each batch
finishes before dependent preparation or method completion; ordered progress
events report completed objects. WebGL and unproven states retain the native
ordered path. Precompilation state is cleared before every await, including setup
failures. The four millisecond yield budget remains. Unknown work-loop changes
reject the rewrite.

Development hydration uses one native begin/finish bracket which closes before
the batch gate. Independent preparation owns its own brackets; dependent work
begins again only after earlier pipelines finish. This preserves `_callDepth`
balance and prevents framebuffer/precompilation state from leaking across an
await. Regression tests execute the pinned native begin/finish method bodies,
including mixed independent/dependent objects and rejected hydration.

`three-rewrite-pipeline-async-scope.js` validates native render and compute async
submission shapes. It pops each WebGPU validation scope immediately after API
submission, before waiting for that pipeline, so reverse completion order cannot
assign another request's scope to the wrong pipeline. Native error reports,
shader diagnostics and completion handling remain in place.

`three-rewrite-webgpu-only.js` specializes the exact native backend-selection AST
only for explicit `webgpuOnly: true` source builds. It drops the WebGL import,
rejects `forceWebGL` before resource allocation and disables fallback. Default
builds preserve native automatic and explicit WebGL selection. Both helpers are
fingerprinted and tested against the stable and pinned development constructors.

The private rewrite implementation is split by semantic owner:
`three-rewrite-ast.js` owns complete AST guards, `three-rewrite-node-primitives.js`
owns graph-free core/quad bridges, `three-rewrite-webgpu-bindings.js` owns native
GPU group preparation, and `three-rewrite-renderer-lifecycle.js` owns disposal
ordering. Each source file is included in the shared slim fingerprint so a
helper edit cannot leave a checked prebuilt apparently current.

Native r186/r187 ScreenNode no longer stores its generated `_output` uniform.
`capture-screen-uniform.js` calls only its known size/viewport update seam with
a stub renderer whose getters return the passed vector untouched and whose
pixel ratio is one. This reveals Three's exact module-owned Vector2/Vector4
without changing its values or real renderer state. Extraction seeds the
existing value-identity map; equal snapshots on unrelated authored uniforms
remain anonymous, and conflicting provenance still fails the ambiguity guard.
This restores renderer.size/viewport ownership for resized output passes and
shadow arrays without widening variant-family equality.
Numeric renderer callbacks are classified by three independent logical-height
and DPR probes. `getSize` returns detached dimensions, leaving private size
targets untouched; the captured scalar is restored even after an update throws.
This recognizes precreated native screenDPR and PointsNodeMaterial scale despite
private bound-callback ownership. Exact renderer.dpr/halfHeight behavior replaces
the former points-only relabeling of every anonymous number uniform. Constants
and unrelated numeric updates remain anonymous.
The pinned development Renderer also keys `_quadCache` by RenderTarget, whereas
r186 keys it by the target's color Texture. Output capture checks these exact
active identities and rejects distinct conflicting entries; it never selects
an unrelated cached quad. Both native source profiles exercise resize capture
and shader/binding family merge through this seam.

The complete graph-free `nodes/core/constants.js` export surface is forwarded,
including `vectorComponents`: new SplitNode source reads that array at module
initialization before tree shaking. Replay values and mutable array ownership
match the native source; forwarding these constants retains no TSL graph.

NodeUtils gained texture-type and parameter helpers without changing the retained
hash functions. Its exact compact AST SHA-256 for both new sources is
`1d61ad5f6ea78d6e941a094c0a98bf1de66bc025dfcf9a3237dcdbc8f178e33c`.
Its omitted compiler helpers retain syntax-only named throwing placeholders so
Rollup can link native graph imports before proving them dead. They implement no
graph behavior, and the zero-node/compiler-residue gates must still pass.
RenderPipeline now creates a context graph on its sentinel material immediately
before replay replaces that whole material. The rewrite checks this exact
adjacent ownership and removes the discarded assignment; plain `_contextData`
and its native callback arrays remain available to the replay adapter.
QuadMesh also gained a singleton vertexIndex-based graph and temporarily sets
it on every material during render. Native capture already bakes this triangle
vertex program. The `quad-mesh` target pins the complete module at compact AST
SHA-256 `fcc507b5d483fae86aa34c3e7746a7991f27e631e2b8fe29b465eafbae97cabe`,
removes only this live graph and restores the plain renderer draw. Native
geometry, UV attributes, camera and asynchronous draw path stay intact. The
historical graph-free r185 module is an exact-hash no-op; unknown geometry or
vertex-program changes reject before a checked slim build can be published.
Shadow material ownership moved from ShadowFilterNode to ShadowBaseNode; the
filter-only ShadowFilterNode is accepted unchanged only at compact AST SHA-256
`b51a991d948491b8b2012891351cfc8910aca73c71f7bd8de6396d92e165dd3a`.
The compiler-residue gate still prevents these TSL graphs from surviving a slim
bundle. Historical r185 whole-module hashes remain guarded for test fixtures.

The new WebGPU `_draw` loop already compares native bind-group identities and
skips `cameraIndexSlot`; its ArrayCamera caller binds the native per-camera group.
The rewrite validates those complete loop/guard shapes and adds only lazy replay
resource preparation before reading a GPU group. It does not duplicate the old
CPU-id cache patch. Executed tests cover repeated groups, replaced GPU resources,
released groups and per-camera slot ownership.

Renderer disposal is asynchronous in both new sources. They tear down NodeManager
before awaiting the backend, so replay targets are released immediately before
that earlier node teardown. The Node harness awaits backend disposal. Native
RenderObject now also listens to object disposal; its own `dispose()` removes
object, geometry and material listeners while retaining the native shader-state
reference-count lifecycle used by synthetic capture cleanup.
The `bindings` rewrite target pins the complete `Bindings.deleteForRender`
method body: native `RenderObject._bindings === null` means no binding array was
created. Deletion in that state removes only the binding-manager cache entry;
it never calls `getBindings()` to create shader state solely for disposal. This
lets rejected cold compiles release their RenderObjects and resource listeners.
Every non-null array retains native destruction and reference-count behavior.
Executed tests cover both source profiles, failed cold compilation, cache and
listener release, and allocated uniform-buffer/group destruction. Unknown
deletion shapes fail closed before a slim build can be stamped.

The Node GPU mock provides GPURenderBundleEncoder for the new native `instanceof`
check, without replacing an existing host constructor. Test-only r185 source
copies, their MIT license and byte fingerprints live in
`test/fixtures/three-r185`; generated capture JSON remains unchanged.

Native r186 QuadMesh.render() installs its fullscreen vertex node and passes
the quad itself to Renderer.render(). That renderer path sets fullscreenPass,
making default-screen output single-sampled even when the renderer uses MSAA.
compileAsync(Scene) does not set this flag. Isolated final-pipeline capture uses
the exact native QuadMesh draw under suppressed isolated material update phases;
it does not run the owning RenderPipeline or its live effect graph. Capture tests
compare native shader bytes and selectors, retain explicit offscreen target MSAA,
and prove cleanup on draw failure. Direct quad cleanup owns only that exact
isolated object/material pair and never marks Three's shared dummy scene.
Repeated captures retain no object/material disposal listeners. Strict
sample-count selection is unchanged.
The isolated native draw derives its framebuffer after the captured tone/color
state override. It must not borrow the host's earlier MSAA output-intermediate
warm-up target; explicitly supplied offscreen targets still preserve their MSAA.

Pinned r187 development PMREM changed from a CubeUV atlas to CubeRenderTarget
mipmaps and adds `PMREM_integration` alongside the equirect/cubemap and GGX
stages. Its GGX uniforms use roughness/lodBias; integration uses
roughness/sourceSize/sourceLod, and PMREMNode uses `_maxLod`/`_size` instead of
the atlas scalar fields. The additive `pmrem-cube-layout@1` layout separates
cube families from unchanged `pmrem-layout@1` atlases inside `pmrem-support@1`.
It fixes a power-of-two face size of at least 256, a final 8-pixel face mip,
256 GGX samples, and three integration levels with 16-pixel source integration.
Cube scene blur uses the native two-pass 20-sample spherical kernel. Shared
generator checks require the verified 187dev revision and actual private
cube-camera/box/integration ownership before draws; output validation checks
every allocated mip extent. An atlas-only call still rejects cube output.
Required stages and uniform roles depend on the explicit layout schema:
cube GGX addresses roughness/lod-bias, integration addresses roughness,
source-size (an actual int UBO field), and source-lod. The native PMREM private
UniformNodes retain exact sampled-texture identity as `pmrem.maxLod` and
`pmrem.size`; generated modules call the shared live PMREM writer for both.
Actual generated textures carry `isPMREMTexture: true` on `artifact.texture`,
so renaming preserves ownership. Scalar validation requires matching atlas or
cube texture topology in the same variant. Cube pass inputs are owned by their
declared internal-pass texture roles: capture removes a generic producer target
selector only at those exact texture/sampler addresses, preserving real texture
references, all shader bytes and unrelated bindings. This prevents the source
cube target from preempting the PMREM binder. Actual source capture tests exercise
fromEquirectangular, fromCubemap and fromScene on both pinned source profiles;
the development tests resolve every Three import to its real src graph.

The development package's nominal `0.186.0` version is insufficient emitter
identity. Verified source configuration supplies the pinned `187dev` revision
and commit to capture and all material/config/content hashes, then stamps
`sourceThreeRevision` and `sourceThreeCommit` on the artifact. Auxiliary envelopes
and registrations carry the corresponding `threeRevision`/`threeCommit` pair.
Development capture and build reject older version-only records and request a
real recapture. Stable `0.186.1` adds no fields or hash bytes. Canonical release
data lives in the inert shared release module so browser hashing does not retain
build-time rewrite policy tables.

The runtime's `slim-support/reflector.js` derives its camera math, target
allocation, clipping and render lifecycle from r185 `ReflectorNode.js`
(Three.js authors, MIT). It replaces compiler nodes with graph-free live
texture carriers, preserves color/depth sharing and restores renderer state
when nested rendering throws. The existing reflector hydrator owns bindings;
the adapter does not build shaders. Recheck upstream lifecycle changes when
advancing the pinned Three revision.

Development observation spans an application's `compileAsync()` and its nested
reflector renders as one epoch. Synthetic extractor compiles raise the existing
synthetic-render guard across their await so they cannot start another capture.
This relies on r185 `compileAsync()` issuing RenderObject requests through the
same renderer managers as real draws.

Addon Object3D uniforms also exposed through exact, own material `*Node` aliases
use material-relative live provenance in both real and synthetic mesh captures.
Object-only uniforms retain `object3d.nodeUniform`; matching values alone never
establish an alias.

Three r185 sorts analytic lights by creation id before emitting shader functions.
Capture clones preserve that relative creation order, and selectors persist the
ordered semantic light descriptors without persisting process-local ids.
Shadow-pass families retain the private override as their program owner; caster
materials are borrowed binding owners and must not collide with beauty families
when merging a supplied real-render harvest with newly captured shadow draws.

An explicit `materials` extraction filter selects program owners. A material
borrowed by Three's shared shadow override is not the owner of that auxiliary
program. Shadow capture performs its own selection and family merge; a beauty
marker must not merge cached shadow states that still reference a previous
caster after a material replacement.

`pnpm vendor:probe` reads the actual Three imports of every local vendor module,
checks their named/default exports, imports each module, and exercises every target
in the shared slim rewrite policy. Failures include the installed and supported
versions, source location, and missing export or changed rewrite assumption.
`--json` on `scripts/probe-vendor.mjs` emits the same complete report for tooling.
There is no separate hand-maintained export allowlist. The locked/latest CI lanes
continue collecting rewrite and build diagnostics after a probe failure; a failed
probe still fails the job. Latest remains an upgrade warning, not supported input.
Vendored provenance is unchanged by this diagnostic consolidation.

### Capture attachment pipeline identity (Three r185)

`compileTSL` temporarily extends WebGPU backend pipeline keys with all color
attachment formats while holding its renderer lock. Upstream r185
`WebGPUBackend.getRenderCacheKey()` includes only attachment zero, which can
collide when a synthetic RGBA8 MRT and the real mixed-format MRT emit the same
fragment interface. The adapter uses `utils.getCurrentColorFormats()` and
restores the original method after success or failure. It changes capture
scheduling only; generated shaders and production backend methods are intact.

Shadow-only auxiliary extraction requests a synchronous private frame stamp
for its warm-up draw. Three r185 `ShadowNode.updateBefore()` suppresses a second
draw with the same frame ID even when `shadow.needsUpdate` is true. The scoped
negative stamp makes repeated capture deterministic and restores the original
frame ID before returning; it never advances the application's clock.
