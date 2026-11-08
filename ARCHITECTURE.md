# Architecture

## Mental model

The plugin records real Three.js rendering during development and turns those
captures into production modules. The shared contract describes what a capture
means; runtime code binds it to live objects and GPU resources.

There are two production paths. Compatibility mode registers and validates the
artifact, then returns the original NodeMaterial to Three's compiler. Slim mode
adopts the material and replays captured shaders without the node builder.
The plugin selects the apply path at build time. Setup order must not select it.

## Layers

```text
Author: material.precompile('name')
  → dev marker observes a real render and extracts shader/binding state
  → dev server validates and atomically publishes artifacts + manifest
  → Vite/Babel transform resolves the artifact and emits a virtual module
  → compatibility: validate/register, preserve the live material
    slim: select captured topology, hydrate bindings, run generated writers
```

The Node extractor harness uses mock WebGPU for deterministic generation tests.
It does not replace browser capture of real lights, targets, shadows, and passes.
Its Node frame shim schedules through `setImmediate`, retaining an asynchronous
boundary and cancellation without a timer delay per compiled object.
`pnpm verify` validates stored artifacts without initializing a renderer.

## Packages

### `@tsl-precompile/plugin`

Published as `vite-plugin-tsl-precompile`; source lives in `packages/plugin`.

| Owner | Responsibility |
|---|---|
| `src/index.js`, `babel-transform.js` | Vite integration, marker transforms, mode selection |
| `src/dev-capture-request.js`, `dev-capture-server.js` | Same-origin JSON transport, bounded requests, validation, atomic publication |
| `src/vendor/`, `node-harness.js` | Version-specific extraction and deterministic Node fixtures |
| `src/emit-manifest.js`, `emit-updater.js`, `wgsl-optimize.js` | Static payloads, typed-array writers, shader/numeric pooling |
| `src/three-rewrite.js` | Strict version-locked rewrites of Three's private renderer seam |
| `src/cli/` | Verify, diagnose, recapture, and integration tooling |

Capture transport accepts at most 32 MiB, rejects aborted/rejected requests before
publication, and serializes user and auxiliary writes through one atomic queue.
Complete signed PMREM/VSM families become authoritative through one manifest
rename after every member is durable. Semantically identical recapture avoids
redundant writes and HMR. Preserve the legacy migration boundary without relaxing
validation of current signed captures.
Marked synthetic scenes own their temporary RenderObjects. The extractor releases
only exact scene/object pairs after artifact extraction, removing material listeners
that otherwise retain discarded scenes and renderers. Capture owners dispose only
geometries they allocated; caller materials, geometries, and live render state retain
their own lifetimes.

Production codegen packs schema-proven numeric snapshots using the smallest exact
scalar representation, and uses repeated-block runs when they save bytes including
the decoder. Large fallback texture arrays decode only when their `data` is read;
live texture resolution can therefore avoid allocating them. Generated accessors
preserve array identity, replacement, serialization and reads from frozen owners.
These are emitted JavaScript choices: captured JSON, hashes and ordinary runtime
Array values keep their existing contract.

Numeric encoding computes literal size during exact-value validation. Finite
numbers use the same decimal text conversion as JSON, avoiding a second numeric
serialization pass. Alias and reference discovery iterate arrays directly rather
than copying their contents with `Object.values`; the emitted representation and
its size gates stay unchanged.

Texture snapshots with 2–4 scalar components per pixel can use an exact palette
of up to 256 byte-distinct colors. Palette indices reuse the numeric run encoder;
the combined blob is selected only when its saving covers the decoder. Decoding
writes directly into the final ordinary Array without an intermediate index or
palette Array. Existing lazy access, alias identity and replacement semantics
apply to this representation too; captured JSON and texture precision stay intact.

The shader string pool shares repeated whole shaders and exact function/structure
text across different shaders. Generated string concatenation preserves every
post-minification shader byte. WGSL minification shortens generated private
`nodeVar` names only when the new name is absent throughout the shader and the
old name is absent from struct members and function signatures. Whole Unicode
identifiers are replaced; bindings, entry points, expressions and GLSL stay intact.
Separate mutable artifact records keep their own identity. Captured JSON and
content hashes remain unchanged.

Shared shader-pool discovery reads the capture graph in one pass, without cloning
its numeric snapshots. A pool-local map minifies each distinct shader once and is
discarded when that pool is built. Array scalars need no recursive candidate
visits; selector arrays retain their dedicated collector. Active-path tracking
rejects cycles while counting each occurrence of a shared artifact. Emission still
owns its separate mutable clone and schema alias restoration.

Replay modules reconstruct their public `dynamicBindings` arrays once through
the shared contract collector, with source references into `uniformPlan`.
Generated modules therefore omit both repeated source snapshots and derived
descriptor literals. Empty views remain literal arrays; passive compatibility
modules retain their capture metadata. Internal descriptor lookup reuses frozen
templates, while the public descriptor API preserves its independent frozen
prefix records. No binding topology is rediscovered per frame by this emission.

The same virtual string module also shares exact fields from render-context
selector strings. Only JSON text that survives parse/stringify byte for byte is
eligible; opaque or noncanonical selectors stay intact. Generated concatenation
restores the original selector without projecting away any matching axis or
adding a runtime decoder. Selector fragments use the ordinary string-size gate;
shader function fragments retain their larger gate.

The runtime build imports rewrites through the plugin's `build/slim-rewrite`
package export. Keep this dependency build-only; published code must not reach
through monorepo-relative paths. See [VENDORING.md](packages/plugin/src/vendor/VENDORING.md)
before changing the private Three seam. `pnpm vendor:probe` checks actual vendor
imports and shared rewrite targets, reporting all changed assumptions with source
locations against the installed/supported versions.

### `@tsl-precompile/contract`

This package owns vocabulary and pure interpretation shared by capture, codegen,
and replay. Start cross-package changes here rather than copying predicates.

- `kinds.js`, `dynamic-bindings.js`, `texture-props.js`: source kinds, validation,
  dynamic resource descriptors, and material texture properties.
- `graph-normalize.js`, `artifact-content.js`: source graph and durable payload
  identity. Auxiliary node/plain-config payload assembly also lives here; retain
  its pinned v1 bytes. Serialization excludes private runtime sidecars.
- `render-context.js`, `render-selector.js`, `artifact-variants.js`: topology,
  backend-aware variant families, source ownership, and merge rules.
- `material-compute.js`, `internal-pass.js`, `pmrem-config.js`, `vsm-config.js`:
  exact resource ownership and operation-family contracts.
- `artifact-traversal.js`, `variant-selector-adapter.js`: canonical family walk
  and build-generated selector adapters; runtime consumes their small sidecar.

Generated selector adapters can describe, project and encode a live render
object in one pass. The live factory and persisted-string projection share the
same contract policy. Older adapters retain the serialize/project path; the
prebuilt renderer calls the optional factory without importing that policy.
- `versions.js`, `slim-three-policy.js`, `diagnostic-globals.js`: toolchain,
  rewrite policy, and declared diagnostic interfaces.

Scene topology descriptors emit sanitized scalars in canonical key order, so the
frame path can serialize them directly without recursively copying and sorting
them. Texture-kind priority is a shared static table. Tests compare the fast scene
encoding against the general canonical serializer. Replay reads topology each
render call and reuses its numeric hash only when the resulting string is equal;
lighting, shadows, multiview, and custom-node identity checks keep their existing
invalidation rules.

Shader content, source provenance, and runtime resource identity are different
contracts. Do not replace one with another just because both contain hashes.

### `@tsl-precompile/runtime`

`setup` resolves to synchronous development installation and an inert production
entry. `apply` similarly separates development schema validation from production
application. Generated modules use narrow `/apply`, `/loader`, `/writers`, and
support entries; `/core` is the explicit small public AOT surface.

For slim markers with verified captured source owners, the transform selects the
internal call-site apply export. Shared artifact/hash/version gates remain active,
but the material graph hasher is only retained for the ordinary apply path. Mixed
modules retain that ordinary path for artifacts without a validated owner. The
call-site entry rejects a missing generated validation marker, and development
retains schema validation for both entries.

Generated slim auxiliary tables select a guarded direct registrar when none of
their entries needs the renderer-owned registry. Call-site material modules carry
a registration hook only for renderer-owned shapes, importing it from the same
slim singleton as the renderer. Together these boundaries let ordinary builds
discard the shadow-family merger. The shared contract owns the shape predicate;
manual registration and ordinary application retain the general registry. A
misrouted renderer-owned artifact fails before registration instead of silently
losing its renderer binding.

Generated aux-only tables defer viewport fallback preparation until lookup,
replay cloning or reading an entry's artifact. Metadata registration remains
eager; unused shapes retain their captured data without constructing textures.
Public registration remains eager. Deferred work retries if texture constructors
are not installed yet or preparation fails.

Precompiled WGSL removes TSL graph construction, not native WebGPU pipeline
compilation or Three's render-object/resource setup. The slim Renderer hydrates
directly and yields CPU preparation on a four millisecond budget. In verified
r186/r187 source, `slim-pipeline-preparation.js` batches at most 16 independent
WebGPU pipelines for precompiled objects with empty before/after callback lists.
Dependent objects and WebGL retain native pipeline/callback barriers; progress
reports completed objects in order. Async validation scopes close in submission
order before pipeline completion, keeping errors local when requests overlap.
Preparation must target the actual render passes: compiling a scene for
the default target does not prepare PMREM or the complete postprocessing chain.
Cold measurements include preparation and first queue completion, not just the
draw after preparation; queue completion is not a presentation timestamp.
Selector-backed color, depth and sampler bindings resolve in the late rebinding
phase, after live producer passes publish their render targets. This prevents
the first consumer draw from retaining a pending placeholder. The performance
lab validates first-frame pixels before any warm-up can repair missing inputs;
`compare --cold-only` runs this gate without steady-frame benchmark loops.

| Owner | Responsibility |
|---|---|
| `precompile-marker.js`, `aux-marker.js`, `dev-capture-outcome.js` | Dev installation, extraction lifecycle, capture settlement |
| `apply-precompiled-*.js`, `_vendor-PrecompiledMaterial.js` | Mode-specific application and live material adoption |
| `hydrator.js`, `hydrate/*` | Allocation, source resolution, variants, dynamic rebinding |
| `slim-replay-*.js` | Graph-free adapters for Three renderer-owned state |
| `slim-support/scene-support.js` | Product orchestration of PMREM, compute, shadows, passes, disposal |
| `slim-support/internal-pass.js`, `precompiled-shadows.js` | Captured operation scheduling |
| `slim-support/full-renderer-fallback.js`, `compute-sync.js` | Explicit shared-device delegation and exact resource transfer |
| `writers.js`, `generated/light-writer.js` | Per-frame writes into already allocated buffers |

Artifact templates are shared; mutable uniform/attribute/storage state belongs to
a hydrated owner. Camera/render-scoped resources must not leak between objects or
variants. A cache must name its owner and invalidation lifetime, especially when
lights, targets, graphs, or devices change.

`hydrate/uniform-plan.js` indexes the state-local artifact view once after attaching
live sidecars. The allocator, texture owner, dispatcher, and UBO seeder share that
index. Cached texture binding records distinguish the ordered alias used for owner
selection from dispatch's exact group match; paired samplers reuse the group's
texture map. Records retain live entries and sidecars, and resolution memos include
the record's identity to isolate hydrated owners. Plan layout is fixed for that
hydration. Compact texture descriptors use contract's `texturesOnly` projection.
Writable textures are sampled-texture bindings with `store: true`, owned by their
existing source resolver.
Storage-buffer entries preserve their live references and ordered-plan fallback.

Replay UBOs deduplicate shared frame/render writes by binding, frame/render ID,
renderer, scene, camera, light context and backing array. Live uniform groups keep
per-draw writes because callbacks and pass sidecars can change inside one render
ID. Each binding compares shader-visible bytes before upload; cloned GPU bindings
have independent upload history. Texture resolution keeps separate group/binding
keys and renderer/render/frame identities, avoiding per-draw string allocation
and cross-renderer cache hits. Post-process preparation shares one texture
discovery snapshot across its sub-passes; later resource refresh collects again.
Hydration also selects uniform overlay slots and generated material ownership
once. Update plans retain live slot references so pass-local values can still
change between draws with the same frame and render IDs.

Generated replay modules also identify exact camera/light-only uniform groups
that can share a GPU binding. Codegen hashes the full plan, binding layout and
light identities; a nonserialized contract symbol carries that proof to hydration.
The sharing cache belongs to a renderer and render context, and replaces released
buffers. Allocation checks this cache first, skipping duplicate CPU arrays,
snapshot seeding and binding setup without a second traversal. Material/object
groups, live sidecars and unproven artifacts stay local.
The WebGPU draw cache compares native `GPUBindGroup` identities: unchanged groups
avoid redundant commands, and replacing GPU resources invalidates the cache even
when the CPU binding id is unchanged. ArrayCamera overrides last for one draw.

Generated PMREM writers allocate frozen source descriptors once at module load.
Atlas lookup still reads the live texture registry each draw. Environment and
background rotation writers share one matrix cached by Euler values, order and
enablement; this retains no scene/material and invalidates within the same frame,
including signed-zero changes.

Texture shape probes share one description per artifact/binding, covering WGSL
texture declarations and GLSL combined samplers. Hot lookups allocate no query
keys or callbacks. Replacing any shader stage invalidates the descriptions;
texture shape validation and sampler comparison remain separate predicates.
Resource tracking keeps a snapshot per binding in each rebinder's WeakMap. It
reuses unchanged snapshots without allocating or rewriting the map, but reads the
live texture, GPU resource and version on every check, including for clones.

Hydration clones binding records from their own descriptors, so lazy accessors
are not evaluated. Ordinary writable data records use direct assignments after
descriptor validation; inherited keys use property definition. Custom prototypes,
accessors and restricted descriptors retain the general descriptor clone. Aliases
share one clone within a hydration, while mutable buffers remain object-owned.

Render-target resolution builds full descriptors only for textures at the captured
attachment address, including aliases of that texture. It still checks live target
topology, replacement, renderer ownership, ambiguity and active writes on every
lookup. Scalar counters replace match arrays; dimension and extent validation
avoid temporary collections. No target topology or attachment snapshot is cached.

Texture dispatch prepares inert render-target fallbacks only after a retryable
pending result. Successful material bindings bypass shader-hint and builtin setup;
successful artifact bindings build diagnostic details only when a listener exists.
Strategy records, strict misses and listener changes remain observable. Graph
discovery rejects scalar roots before resource probes and reads absent members
without throwing; custom object getters still use the guarded discovery path.

Direct material uniform types are shared by contract validation and codegen
in `contract/dynamic-bindings.js`.

Built-in postprocess handlers initialize through a pure factory that owns its
registry. Unused root exports can therefore drop the handler graph and its replay
helpers. Used handlers retain eager initialization, insertion order, replacement
and removal semantics; no lookup-time initialization or package-wide purity flag
is needed.

PMREM scene cloning is exposed through `slim-support/pmrem`; it shares CPU geometry
allocation with shadow fallback in `full-renderer-scene.js`. Each transaction owns
its cloned geometry/material/texture resources and rolls back unsupported nested
objects. `withMappedSceneMaterials` in `pass-render-fallback.js` restores arrays and
overrides after a synchronous render or mapper failure. Harness code supplies source
material mapping and diagnostics; these runtime helpers own cleanup.

Slim replay uses exact Three source constructors to preserve module identity.
Prebuilt consumers resolve generated helpers and shared root-runtime exports to
the same singleton. The plugin derives the root/prebuilt export intersection from
the checked installation. Two export-only virtual modules forward shared helpers
to the bundle and remaining root exports to their source owners, preserving the
root namespace without retaining the broad source barrel. Only those generated
facades declare themselves free of side effects; used source providers retain
their own initialization. Guarded
source mode permits application tree shaking while enforcing the same rewrite
policy. Bundle gates reject compiler, stock-adapter, retained Node/TSL, and split
Three identity residue. Do not add package-wide `sideEffects: false`; required
bootstrap effects make that unsafe.

Source builds can explicitly require WebGPU with `webgpuOnly: true`, removing
the native WebGL fallback module graph and rejecting `forceWebGL` before backend
allocation. The default source and checked prebuilt surfaces keep native WebGL 2
fallback. Development still captures through full Three in either configuration.

Pure slim cannot compile an uncaptured graph. Supported replay requires a captured
topology; bounded hybrid operations require explicit support and resource ownership.
A missing proof must produce an actionable error rather than guessed GPU bindings.

Bound auxiliary inputs resolve directly through the registry before capture
enumeration. Successful binding/hash resolution creates one result record; it
does not cache that record, so replacement and registry reset remain visible.
Viewport fallback wiring copies shared texture references only when a missing
binding needs a fallback. It inspects the separate shader modules directly and
leaves shader text and reference maps untouched when all bindings are already
wired.

### `packages/examples/*`

Examples exercise real applications. `batch` owns browser execution, corpus
selection, source/network evidence, screenshots, and coverage reporting. Behavior
an adopter needs belongs in runtime `slim-support`, not in replay source strings.
The inspector is a diagnostic consumer; the site publishes independently verified
evidence rather than trusting a stored `pass` field.
Each batch case owns its visits and payload bucket through success and failure.
Setup failures close partial contexts; network disposal releases bodies, request
records and loader closures. Capture POSTs share the plugin's bounded transport
reader and publish only into the bucket generation active when the request began.
The stock, E2E, slim-load and ocean smoke drivers keep Playwright's direct connection and track their own
fresh Chromium child through Node's public `child_process` diagnostic channel,
matched to the browser's CDP process identity. After contexts close, native browser
shutdown gets 250 ms. On macOS/Linux, a still-live owned child can be stopped only
after its current parent and detached process group are verified; child lifetime
and empty contexts are checked again immediately before signaling that group.
Cleanup awaits both actual child closure and Playwright's original close promise,
which includes temporary-profile cleanup. Failures abort recycling and still close
the HTTP server. Unknown ownership, unsupported platforms and active contexts keep
ordinary graceful shutdown. Observation is bounded and removed after launch/close;
no private Playwright fields, shared Chrome session or global process lookup is used.
Local diagnostic captures default to the installed matching Three package;
upstream and canonical runs keep their official-checkout requirement.
The browser harness preserves native monotonic Object3D ids across Three module
copies. Call-stack hashes reordered cloned lights and changed shader binding
order. Fatal page errors now abort pending visit waits while resource cleanup and
GPU/network evidence still complete; recoverable warnings retain their policy.

Full-resolution canvas brightness probes reuse one scratch surface per source
canvas and clear it before each draw, including transparent and resized frames.
The optional initial brightness poll can finish after a deterministically frozen,
idle frame's GPU queue completes. This requires exactly one observed WebGPU
device, matching the initialized renderer, and a case configured for one animation
owner. Unknown, WebGL, multi-device and special-timer cases retain ordinary polling. The same
poll deadline bounds freeze observation and queue completion; final loader/freeze,
presentation, screenshot brightness, pixel and GPU-error gates still run.

The canonical campaign covers the exact checked catalogue. Validation binds source
snapshots, official Three provenance, configuration, semantic operation completion,
GPU diagnostics, artifacts, and screenshot bytes. Source changes make old evidence
stale. Run-scoped artifact files may be gzip-encoded; replay checks stored hashes,
encoding, declared size, and bounded decompression before parsing them.

Site verification checks every screenshot file before reusing a pixel comparison.
Its comparison cache keys both verified content hashes and ignore regions; repository
snapshot reuse keys the complete snapshot. Both caches live for one validation call,
so a later invocation rechecks the current files.

Release benchmarks expand any selected PMREM route into complete real captures
of the shared module's three routes before building. Their workspace catalogue
includes those routes, and capture verifies the loaded case identity. Build and
measurement still select only requested workloads; reports distinguish requested,
expanded and successfully captured scope. No artifact is synthesized for an
unvisited branch.

## Staleness gates

1. Contract validation and content hashes cover shaders, bindings, plans, and variants.
2. Build-time call-site ownership binds transformed source and transitive local imports.
3. Dev recaptures on changes; build rejects exact Three/toolchain mismatches.
4. Virtual modules enforce content identity; runtime checks expected identity and the
   live source graph before applying either mode (`autoMark` uses its call-site gate).
5. Structural `pnpm verify` audits stored artifacts/manifests. Generation tests compare
   real extraction paths; browser tests prove rendering and GPU behavior.

## Verification ownership

[`scripts/test.mjs`](scripts/test.mjs) owns Node suite discovery, plugin tiers,
worker limits, and file selection. Package scripts delegate to it. Each file retains
Node process isolation and its package working directory. Compiler/rewrite/pack
fixtures remain serial; ordinary plugin tests keep bounded parallelism in full runs.
The site campaign fixture runs in full; quick retains the smaller site contracts.
Negative site evidence checks use an 18-case boundary catalogue with one complete
local cohort. The integration check still validates all 272 cases and nine cohorts;
the public validator enforces the current release catalogue's cardinality.

The compact reporter prints counts, failures, and slow files. Node also writes the
complete spec report to the printed temporary directory. `--verbose` streams it.
File timings include imports and setup. `--low-memory` selects one ordinary worker;
repeatable `--match` options select several affected file groups. Each suite group
owns its worker process tree, with cancellation cleanup and a five-minute watchdog.
Timeouts fail the run and terminate descendants instead of leaving hung fixtures.
Selection is explicit, never inferred from a partial import graph or a stale result
cache. Empty selections and unknown options fail. Browser evidence is never reused
as proof that changed product source passed.
Explicit filename matches are applied before opening unrelated plugin tests for
classification. Full plans still audit every heavy fixture, and selected heavy
fixtures retain their serial execution and classification checks.

See [CONTRIBUTING.md](CONTRIBUTING.md) for commands and [AGENTS.md](AGENTS.md) for the
required gates. CI runs package/site suites once and keeps the existing Node status
name as a dependent success check. Browser, budget, packed-consumer, and artifact
gates remain independent.

## Evolution / structural debt

[ROADMAP.md](ROADMAP.md) holds current decisions and sequencing.
[evolution-archive.md](evolution-archive.md) holds implementation history and dated
measurements. Read the active guides first; load historical detail only for the
subsystem being changed.
