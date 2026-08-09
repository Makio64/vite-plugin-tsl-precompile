# Architecture

## Mental model

- Author marks materials with `material.precompile('name')`.
- In dev, the marker waits for a real render, records the material's Scene/Camera/Object context, then fires the real three.js node builder and saves an artifact (shader + bindings + uniform plan).
- In prod, a Vite/Babel transform rewrites the marker to load the baked
  artifact and select the mode-owned apply path. Slim material/compute modules
  also carry generated updater code; full-Three material modules are passive
  metadata.
- Production may keep full Three (compatibility default) or opt into a slim
  build with no node builder. The full path validates and registers each
  artifact but returns the exact live NodeMaterial to Three's compiler. Slim
  runtime work includes material adoption, artifact hydration,
  topology/variant selection, replay adapters, bind-group setup, and generated
  typed-array writes per frame. The plugin selects that apply boundary at
  build time; setup timing and runtime module-copy order do not participate.

Inspired by Unreal's Material Compiler (`FMaterialUniformExpressionSet` generates C++ updaters at cook time) and Unity Shader Graph (HLSL variants compiled offline; SRP Batcher writes uniforms at runtime).

## Layers

```
┌─────────────────────────────────────────────┐
│ AUTHOR CODE (unchanged three.js + .precompile)
└─────────────────────────────────────────────┘
         │
         ▼  (dev)                           │
┌──────────────┐                   (build)  │
│ runtime:     │                            ▼
│ precompile-  │                   ┌───────────────┐
│ marker.js    │                   │ plugin:       │
│ runs real    │                   │ babel-trans-  │
│ extractor    │                   │ form rewrites │
│ on live mat, │                   │ .precompile() │
│ POSTs to     │                   │ → virtual mod │
│ dev server   │                   │ import        │
└──────┬───────┘                   └──────┬────────┘
       │                                  │
       ▼                                  ▼
┌──────────────┐                   ┌───────────────┐
│ plugin:      │                   │ plugin:       │
│ dev-capture  │                   │ node-harness  │
│ writes       │                   │ re-runs       │
│ artifacts/   │                   │ extractor in  │
│ <name>.<h>.  │                   │ Node +        │
│ json,        │                   │ mock WebGPU   │
│ manifest.json│                   │ (for CI       │
└──────┬───────┘                   │ verify)       │
       │                           └──────┬────────┘
       │                                  │
       ▼                                  ▼
┌─────────────────────────────────────────────┐
│ artifacts/<name>.<hash>.json
│   · wgsl (vertex + fragment)
│   · bindings (bind-group layout)
│   · uniformPlan (descriptor list)
│   · lightIdentities (variant-local shared light records)
│   · sourceGraphHash + exact Three/toolchain versions
│   · renderContextSignature (source/provenance topology)
│   · renderContextSelectors (replay-reproducible shader variants)
│   · __hash (artifact-content/module identity gate)
│   · source owners + project-local dependency-closure revisions
└─────────────────────────────────────────────┘
         │
         ▼  (codegen, phase 3)
┌─────────────────────────────────────────────┐
│ generated virtual modules — compact static artifact,
│ optional native-shader/raw numeric pools; slim material/compute
│ modules also carry updater.js writes via runtime/writers.js,
│ while full material modules stay passive metadata
└─────────────────────────────────────────────┘
         │
         ▼  (runtime, phase 4)
┌─────────────────────────────────────────────┐
│ __applyPrecompiled(material, artifact, expected)
│   · assert hash === expected
│   · register artifact
│   · full: retain exact live NodeMaterial + compiler
│   · slim: adopt PrecompiledMaterial + hydrate replay state
└─────────────────────────────────────────────┘
```

## Packages

### `@tsl-precompile/plugin`

The Vite plugin. Runs at build time.

- `src/index.js` — plugin entry; exports `tslPrecompile(options)`.
- `src/babel-transform.js` — finds `.precompile('name')` call sites; rewrites them.
- `src/dev-capture-server.js` — POST endpoint for the runtime marker in dev mode. This is a browser-to-local-dev-server boundary, not a general ingestion API: requests must be same-origin (`Origin`/`Host` and protocol agree), use `application/json`, and stay within the 32 MiB declared and streamed body limit. Aborted or rejected bodies cannot publish partial artifacts. User and auxiliary writes share one atomic queue; semantically identical recaptures preserve artifact/manifest bytes and skip redundant HMR invalidation. Current fully signed user and auxiliary captures aggregate compatible WGSL/WebGPU and GLSL/WebGL variants instead of letting the later backend replace the earlier one. Current content-addressed user artifacts are contract-validated before their first durable write. PMREM/VSM members arrive as one signed family envelope, are validated against one canonical semantic config hash, and become authoritative through one manifest rename only after every member file is durable. Unsigned legacy user-material payloads are accepted only as migration input inside this trusted local boundary; they do not weaken signed-family validation.
- `src/node-harness.js` — headless three.js + mock WebGPU, for CI verify.
- `src/emit-updater.js` — descriptor → static updater.js codegen.
- `src/emit-manifest.js` — artifact JSON → virtual module source.
- `src/wgsl-optimize.js` — build-output-only shader pooling and WGSL minification, including the shared `virtual:tsl-precompile/__wgsl` pool. Native GLSL is pooled byte-for-byte so directives such as `#version` retain their required line structure. It also restores schema-known uniform-plan aliases before emission, hoists profitable shared records, and replaces sufficiently large exact typed-array snapshots with raw little-endian base64 constants. The generated decoder performs synchronous byte materialization, not decompression, and preserves ordinary `Array` runtime contracts.
- `src/hash.js` — artifact hash wrapper around the shared graph normalizer from `@tsl-precompile/contract`.
- `src/three-rewrite.js` — strict, version-locked AST rewrites for the compiler-free Three closure. The r185 Renderer rewrite installs exact-caster replay, graph-free `ReplayNodeLibrary`, and removes the stock shadow-node graph. The exact `CubeRenderTarget.fromEquirectangularTexture()` lifecycle is replaced by a preflighted replay adapter. Complete comment-free AST fingerprints replace Three's last `NodeUtils` / node-constants owners and add lazy texture-loader tracking to Three's exact `Loader` constructor; loader-free source builds therefore retain no concrete loader/fetch/cache closure. Any upstream semantic drift fails the slim build instead of partially applying a cut.
- `build/slim-rewrite` — narrow, build-only package boundary exposing the rewrite dispatcher and virtual-runtime owner lookup to the runtime's checked Rollup recipe. The runtime declares this tool as a development dependency; its published recipe never reaches through a monorepo-relative plugin path.
- `src/vendor/` — vendored files from the three.js fork (compileTSL, extractUniformPlan, …), plus the centralized private RenderObject observer. A bounded observer epoch snapshots reused render contexts and supplies complete real-render variant families to extraction; incomplete families fall back atomically to synthetic compilation.

### `@tsl-precompile/contract`

Shared extractor/codegen/runtime contract helpers.

- `src/graph-normalize.js` — one graph-normalization implementation imported by plugin and runtime hashers.
- `src/render-context.js` — canonical shader-topology signature for renderer, scene, camera, object, geometry, clipping, and MRT state.
- `src/render-selector.js` — graph-free, canonical RenderObject topology used to select a captured variant in compiler-free replay; its exported scene descriptor is also the sole environment/fog invalidation vocabulary. Target topology distinguishes the default/output/intermediate and 2D/cube/array/3D surfaces, snapshots active face/mip and effective samples, and signs replayable attachment/MRT state while excluding resize dimensions. Shadow-depth selectors describe the effective source-caster branches (map/color/mask, depth, position, and alpha) rather than the shared override material alone. The same contract owns render-binding identities and the source-over-artifact precedence used when a renderer-owned pass mixes caster and override-material inputs.
- `src/output-config.js` — versioned renderer-output and RenderPipeline topology descriptors shared by capture, rewrites, and replay; live exposure is intentionally excluded.
- `src/cube-render-target.js` — canonical source-texture and destination-target topology for equirectangular cube conversion, including r185's effective pole filter/mipmap state and custom format/MSAA/depth attachments. It also owns the exact single-texture binding-evidence invariant shared by Node capture, browser capture, and replay.
- `src/pmrem-config.js` — `pmrem-support@1`: exact operation profile, atlas layout, source sample/component type, sampling branch, sampler presence, wrap behavior, capability, and sample-count identity. It intentionally excludes texture metadata that cannot change WGSL or the binding layout.
- `src/vsm-config.js` / `src/internal-pass.js` — `shadow-vsm-support@1` plus the shared renderer-owned pass graph. VSM selection distinguishes native depth from compatibility-mode unfilterable-float input, but keeps map size, light type, radius, and blur samples as live values rather than artifact-family identity.
- `src/artifact-variants.js` / `src/shader-language.js` — the shared variant-local payload field list, native shader-language identity, and family merge contract used by capture, registries, codegen, and runtime. The raw private Three cache key remains available for live routing, while a backend-aware variant key keeps WGSL and GLSL payloads distinct. A family map's represented root payload is authoritative and is projected back onto the durable root while root-only metadata is preserved; equivalent cross-family collisions canonical-union semantic selectors, divergent payload collisions fail closed instead of overwriting a shader family, and emitted family keys are ordered independently of capture arrival.
- `src/material-compute.js` — the versioned material-global compute ownership contract. It validates embedded precompiled kernels, exact resource and render-binding identities, initial state, lifecycle paths/cadence, and schedule order across every represented render variant.
- `src/light-identities.js` — shared capture normalization and validation for variant-local light identity tables; slots retain legacy fields but resolve through one complete record per light.
- `src/stable-json.js` — deterministic JSON encoding for persisted selectors and payload comparisons.
- `src/artifact-content.js` — canonical artifact-content identity plus the shared durable-data boundary. Capture serialization skips private `_...` sidecars before reading their values (so a live object's `toJSON()` cannot expand into artifact data), while the server strips any stale private fields before validation and persistence.
- `src/artifact-traversal.js` / `src/variant-selector-adapter.js` — one canonical walk over generated user, auxiliary, variant, and material-compute payloads plus the generated selector projection/matching adapter. Generated modules attach the adapter as a non-serializable sidecar; the checked renderer consumes its tiny interface and fails closed when manually registered signed JSON was not materialized.
- `src/attribute-generators.js` — canonical captured-attribute vocabulary shared by dev capture, extraction, validation, and replay. `range@1` is accepted only after capture and extraction both verify exact live Float32 output; `instance-matrix@1` records proven object-owned columns. Runtime fills recipe storage directly and exposes matrix columns as live shared views.
- `src/kinds.js` — shared `source.kind` registry, blocked-kind reasons, artifact payload/aggregate validation, and source-kind collection.
- `src/texture-props.js` — canonical material texture slots and node-graph texture keys.

### `@tsl-precompile/runtime`

Ships with the user's bundle. Runtime only.

- `src/precompile-marker.js` — `Material.prototype.precompile`. In dev, calls the extractor + POSTs artifact. In prod, replaced by transform.
- `src/range-attribute-capture.js` — development-only RangeNode instrumentation for Three's above-uniform-limit attribute branch. For the version-checked r185 shape it replaces only that physical branch with a local deterministic generator, never reads or replaces `Math.random`, verifies the live attribute byte-for-byte, and attaches the private recipe sidecar consumed and reverified by the extractor; scalar, buffer, frozen, and unsupported shapes retain stock behavior/snapshots.
- `src/auxiliary/cube-render-target-capture.js` — isolated dev-only owner for CubeRenderTarget's temporary graph, exact face camera, compile-lock coordination, source-state restoration, and capture-resource disposal; `aux-marker.js` remains discovery/registration/persistence orchestration.
- `src/apply-precompiled-common.js` / `src/apply-precompiled-full.js` — full-Three apply boundary selected deterministically by the production transform. Marker-owned material modules remain passive (metadata, diagnostic kinds, and WGSL; no updater/light-helper closure), keep artifact hash/source-freshness gates and narrow diagnostic registration, and return the original live NodeMaterial. Standalone compute modules retain `updateGroup`. The narrow module graph does not import replay-only Three source constructors.
- `src/aux-registry.js` — generated full-mode aux registration subpath. It targets the direct aux-loader registry instead of the broad runtime barrel, so a stock `three/build/three.webgpu.js` build retains zero separate `three/src/**` modules. Slim source/prebuilt virtual aux modules continue to target their exact replay singleton.
- `src/apply-precompiled.js` / `src/apply-precompiled-development.js` — replay apply boundary used by both slim modes. It shares the production gates above, then adopts `PrecompiledMaterial`; development additionally loads the shared artifact-schema validator.
- `src/slim-replay-renderer-context.js` — graph-free renderer context/cache identity and explicit high-precision state for replay; it preserves the narrow `RenderObject` invalidation protocol without constructing a TSL `ContextNode`.
- `src/slim-replay-lighting.js` — graph-free per-scene light state used by RenderList and semantic variant selection.
- `src/slim-replay-node-manager.js` — compiler-free render/compute state manager; hydrates artifacts directly and caches by material identity plus semantic topology.
- `src/slim-replay-node-library.js` — graph-free owner for the private renderer library registry. Both Renderer construction paths use this exact compatibility surface, and the stock Three `NodeLibrary` is forbidden replay residue.
- `src/slim-replay-node-core-primitives.js` — exact r185 `hash`, `hashArray`, `hashString`, `NodeAccess`, and `NodeUpdateType` owner used by renderer replay and the safe public `NodeUtils` compatibility surface. Strict whole-module rewrites keep Three's Node-core owners at zero rendered bytes.
- `src/slim-node-compat.js` / `src/slim-replay-lights-node.js` — shared graph-free Node compatibility and the small replay `LightsNode`; lighting replay no longer imports the broad TSL/PassNode stub module.
- `src/slim-replay-shadow-material.js` — graph-free, per-caster shadow replay identity created at Renderer’s exact override handoff. It keeps the shared captured shadow artifact, carries the exact caster through a non-serializable contract sidecar, mirrors Three’s per-draw alpha/render state, unwraps callback-visible material identity, and turns canonical caster-topology changes into Three-compatible material/program invalidation without inheriting shared alpha-test version churn. Because complete shadow families are registered before replay, the slim Renderer never constructs Three's stock color/depth/position shadow-node graph.
- `src/slim-replay-background.js` — compiler-free background pass; selects a captured artifact from the raw scene input, isolates texture refs per scene, and preserves Three's clear/XR/sky-mesh behavior.
- `src/slim-replay-output.js` — graph-free renderer-output and RenderPipeline material adapter; selects exact topology, isolates texture refs per owner, validates 2D/array sampling, and disposes replacements safely.
- `src/slim-replay-cube-render-target.js` — graph-free equirectangular conversion adapter. It selects an exact source/destination capture, validates one sampled-texture identity across the complete artifact family, clones the registry template, and wires the live source without retaining CubeRenderTarget's TSL graph.
- `src/slim-replay-scene-nodes.js` — graph-free environment/fog topology state; hashes the shared semantic descriptor, preserves Three's invalidation axes, and fails closed when an opaque custom scene graph is replaced.
- `src/slim-source-entry.js` / `src/slim-source-common.js` — guarded application-tree-shaken slim mode. The Vite plugin routes Three internals through the same replay adapters as the checked prebuilt build, preserves one exact Three source identity, validates a plugin/runtime policy handshake, and rejects compiler, classified stock-adapter, retained Three Node/TSL, or split bare-Three identity residue in final chunks. In prebuilt mode, generated `/apply`, `/writers`, `/generated/light-writer`, and `/slim-support/node-dependencies` imports alias to helpers exported by the same prebuilt singleton. Loader tracking is installed lazily on the exact Three `Loader` subclass only when constructed, while allocation-only compatibility stubs are marked pure so selective applications do not pay for unused Node-material shells.
- `src/hydrate/*` — runtime hydration modules: static binding allocation, texture/source resolution, built-in texture reconstruction, live texture registry, shared light identity resolution, per-frame texture rebinders, and source-qualified material binding ownership. Signed shadow artifacts resolve caster-owned scalar/texture/graph inputs from the exact caster while source-local render-material exceptions remain on the renderer-owned override. Each hydrated state owns cloned mutable attribute/storage/uniform-live records and exact graph update phases, so shared artifact families cannot leak the first caster’s GPU resource or live node; legacy shadow graphs read the temporary renderer-owned override as before.
- Slim-replay hydration imports exact `three/src/**` constructors/constants instead of the bare Three barrel. This preserves module identity for the prebuilt build and is the tree-shaking prerequisite for the guarded slim source entry.
- `src/hydrate/variants/artifact-variant-selector.js` — small runtime dispatcher over the generated selector adapter. Signed artifacts fail closed on an uncaptured topology or missing materialization sidecar; old unsigned artifacts retain cache-key/MRT compatibility.
- `src/slim-support/live-scene-index.js` — first productized slim-support helper for live texture indexing and null-image healing.
- `src/slim-support/internal-pass.js` / `@tsl-precompile/contract/internal-pass` — shared `internal-pass@1` system for renderer-owned programs. Capture retains exact native shader source, pipeline selectors, and UUID evidence; the durable descriptor exposes only stable PMREM/VSM roles. A complete operation family is signed and POSTed as one transaction: every content-addressed member is written before one atomic manifest rename publishes the generation, and the loader rejects partial or cross-config families. Replay clones the artifact and binds live uniforms, textures, and packed buffers through non-serializable sidecars.
- `src/slim-stub-pmrem-generator.js` / `src/slim-support/pmrem.js` — compiler-free PMREM replay plus artifact/source caching. The replacement keeps Three r185's unindexed `faceIndex` atlas geometry and source → GGX/blur schedule, selects atomic operation families by `pmrem-support@1` (profile, source topology, and nested `pmrem-layout@1`), and never constructs `NodeMaterial`.
- `src/hydrate/material-compute.js` / `src/hydrate/material-compute-ownership.js` — hydrate the signed material-global compute contract before draw-variant state. `precompiled` mode replays embedded storage-buffer kernel artifacts and exact lifecycle/schedule paths without a live graph. Storage textures and other unsupported proofs remain explicit `hybrid-required` descriptors, which fail closed until the configured support instance completes one exact delegated transaction for that material.
- `src/slim-support/auto-compute.js` / `src/slim-support/compute-sync.js` — compatibility discovery for retained raw `ComputeNode` graphs plus exact shared-device resource transfer. `hybrid-required` dispatch pre-shares sampled/read-only inputs, invalidates replaced full-renderer bind groups, synchronizes only contracted writable outputs, aligns the full renderer's logical NodeFrame without disturbing its render cadence, initializes once per renderer/device generation, and revokes all prior support-owned leases before each serialized transaction. Owner-local assignments are applied only after exact render-variant selection.
- `src/slim-support/precompiled-shadows.js` — compiler-free Directional/Spot VSM scheduler. Selection uses `shadow-vsm-support@1`, whose identity is the source/moments binding topology observed in Three r185 rather than mutable light, map-size, radius, or blur-sample values. The scheduler owns raw depth and vertical/horizontal moments targets, renders the captured shadow-depth family, replays the exact VSM filters, and publishes the final live moments texture for ordinary artifact hydration.
- `src/slim-support/shadow-fallback.js` — fail-closed standard Directional/Spot/Point depth-shadow population through a shared-device full renderer for families not covered by precompiled scheduling, including proxy-scene caching, depth-texture sharing, and lifecycle-safe disposal.
- `src/slim-support/postprocess-frame-scheduler.js` — owner-scoped once-per-logical-frame claims for pass producers, context effects, consumers, and terminal effects. Separate renderer scopes share work through the explicit `(frameId, renderId)` identity; failed work releases its claim and downstream dependencies fail closed.
- `src/writers.js` — `writeMat4 / writeVec4 / writeF32 / writeColor`.
- `src/artifact-loader.js` — manifest resolver.
- `build/three.webgpu.slim.js` — prebuilt slim three.js (no node builder).
- `rollup.config.js` — the publishable checked-bundle recipe. It resolves the plugin-owned rewrite through `vite-plugin-tsl-precompile/build/slim-rewrite`; provenance hashes that boundary, the rewrite dispatcher/runtime-owner registry, vendor inputs, and the recipe itself.
- `build-tools/slim-bundle-analysis.js` / `slim-budget.json` — deterministic Rollup graph metrics and reviewable caps shared by the prebuilt, generated-helper consumer, minimal-source, and advanced-source production gates. Every profile enforces compiler/stock-adapter absence and retained Node/TSL module count plus rendered bytes; source profiles additionally reject split bare-Three identity, while the helper profile requires exactly one prebuilt runtime and zero `runtime/src` copies. Run `pnpm test:slim:budget`; use `pnpm analyze:slim` for JSON output.

### `packages/examples/*`

Integration testbeds: ocean, bloom, compute, background, shadow-debug, compute-debug, batch, and the docs site.

The batch harness stores every campaign under one run-scoped evidence
directory. Screenshots remain PNG; complete user and auxiliary artifact graphs
are compact JSON encoded as deterministic gzip (`.json.gz`, level 1, zero
mtime). Their descriptors hash and count the compressed bytes and explicitly
record `contentEncoding: "gzip"` plus the exact uncompressed byte count.
Replay verifies run identity, path containment, stored size, and stored hash
before it validates this metadata, performs bounded decompression, and parses
strict UTF-8 JSON. Encoding/suffix drift, corrupt streams, and oversized
expansion fail closed. Schema-2 evidence captured before this storage change is
read only through the narrow legacy form: an unencoded `.json` descriptor with
both compression fields absent.

Visual and semantic grading are separate gates. PSNR compares the selected
capture/replay frames; `webgpu_storage_buffer.html` is the sole configured
volatile-compute pixel diagnostic, and every other canonical row remains
pixel-gated. The independent `tslp-e2e-semantic-evidence-gate@3` requires
stock, capture, and replay to be observed and to explicitly complete their
deterministic freeze boundary. Missing phases, incomplete freezes, timeouts,
unexpected browser/runtime or GPU errors, and `[tslp*]` or
`[tsl-precompile*]` warnings block the row.
Each phase must also publish a versioned positive GPU observation: the
`requestAdapter` hook ran, at least one device received uncaptured-error and
device-loss observers, and every observed queue completed a submitted-work
fence.

The gate also validates a complete `tslp-e2e-operation-registry@1`. Its closed
policy recognizes the required replay operations for material compute, direct
`NodeMaterial` replacement, `RenderPipeline` passes, and Bloom; a missing or
unknown outcome, duplicate outcome, incomplete registry, or requiredness
downgrade fails closed. Only auxiliary-capture outcomes may be optional. Their
failures remain structured evidence but are non-blocking. A required failure is
accepted only when every selector-class failure has an ordered identity/error
record bound to its exact operation and effect, and one-to-one counter deltas
prove a later render and presentation for each failure:
`FSR1Node` full-pass rendering with no downstream failure, or `BloomNode`
rendering. Matching pixels alone cannot prove that recovery.

Coverage aggregation revalidates the semantic gate instead of trusting a stored
`status: "pass"`. The cohort manifest also binds the fingerprinted repository
source snapshot, harness sources, configuration, toolchain, artifacts, and
shots. A source-fingerprint change makes prior evidence stale; regenerate an
exact campaign before treating its coverage as current. For local cohorts,
validators rediscover the current manifest/options, HTML inventory, route
mapping, and route bytes and require that exact catalogue to match the recorded
source snapshot.

Canonical Three-source provenance is file-exact rather than a summary
attestation. `threeCheckout.sourceVerification.files` lists every served path
with its byte count, SHA-256, Git blob, mode, object format, official r185
commit, and official tree. Its count must be nonzero and exact, and
`verifiedSourcesSha256` is recomputed from the sorted
`path\0gitCommit\0gitTree\0gitObjectFormat\0gitBlob\0gitMode\0sha256\0bytes\n`
records. Visual cohort manifests add the `three` domain to the same records
under `sources.three`; validators require that snapshot's `fileCount` and JSON
fingerprint, the checkout `sourceFingerprint`, and the self-contained proof
list to agree exactly. The stock report carries and validates the same
self-contained proof list. Its independent harness fingerprint is the recursive
static-import closure plus workspace package/lock inputs; it also records the
actual browser/WebGPU environment and requires positive device, error-observer,
and submitted-work-fence proof with zero captured GPU errors for every route.

Artifact descriptors bind the exact stored bytes. Replay first verifies run
identity, path containment, stored size, and SHA-256, then checks the declared
gzip encoding and exact uncompressed length while performing bounded
decompression and strict UTF-8/schema validation. The v2 gate and its
fingerprinted harness changes require a fresh exact campaign; this architecture
description does not claim a final 254-route result from pre-v2 evidence.

## Staleness gates

Layered so payload drift, ordinary source edits, and toolchain drift fail loudly:

1. Artifact content hash over emitted shaders, bindings, uniform plan, render state, and variants (`__hash`).
2. Stable call-site ownership + a conservative transformed-owner and transitive
   project-local static-import closure revision at build time. Dev and build use
   Vite's resolver, so aliases resolve identically; the durable owner records
   canonical root-relative dependency identities so the source-aware
   `pnpm verify -- --source ...` scan can recompute the same revision. Virtual
   modules, `node_modules`, and linked sources outside the configured root stay
   on their own toolchain/package provenance planes.
3. Hot re-extract in dev on file save.
4. Build-time exact Three/toolchain metadata mismatch → hard error.
5. Virtual-module content-identity mismatch → hard error.
6. Runtime source-graph recomputation before either full-material retention or slim material adoption (`autoMark` uses the call-site gate because it rewrites the constructor before later graph assignments).
7. `pnpm verify` CI gate: committed artifact metadata, schema, and source-kind validation.

## Evolution / structural debt

For the structural changes that make the plugins easier to evolve and 100% visual
fidelity reachable (extracting the slim-support runtime module, splitting the hydrator,
a shared extractor↔codegen↔runtime contract, de-duplicating the graph hasher, hardening
the three.js fork seam, …), see [ROADMAP.md](./ROADMAP.md) —
the prioritized P0→P3 audit.
