# Vendoring

Files in this directory are copies of code from the three.js fork branch `tsl-precompile` (at github.com/Makio64/three.js/tree/tsl-precompile).

We vendor instead of depending on the fork as an npm package because the plugin's stated goal is "works with any three.js project" — users install stock `three` + this plugin, not a forked three.

The published plugin carries the complete upstream Three MIT license and
pinned source provenance in `THIRD_PARTY_NOTICES.md`. Keep that notice in the
package allowlist and its tarball regression whenever vendored Three-derived
code is present.

## Current vendored files

| File | Upstream | Version tag | Reason to vendor |
|---|---|---|---|
| `compileTSL.js` | `src/nodes/precompile/compileTSL.js` | tsl-precompile @ dc09e30 | Extractor core — walks `renderer._nodes.nodeBuilderCache` and emits JSON artifacts. |
| `extractUniformPlan.js` | `src/nodes/precompile/extractUniformPlan.js` | tsl-precompile @ dc09e30 | Classifies every TSL update node into a serializable `source` descriptor. |

`render-object-observer.js` is a local dev-only adapter, not an upstream copy.
It is the single owner of the private `renderer._nodes.getForRender` build tap
and `renderer._objects.get` cached-request tap used by extraction. Keep new
live-capture subscribers on that adapter so HMR and duplicate plugin copies
cannot stack independent wrappers.

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
