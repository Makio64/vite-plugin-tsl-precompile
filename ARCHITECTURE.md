# Architecture

## Mental model

- Author marks materials with `material.precompile('name')`.
- In dev, the marker waits for a real render, records the material's Scene/Camera/Object context, then fires the real three.js node builder and saves an artifact (shader + bindings + uniform plan).
- In prod, a Vite/Babel transform rewrites the marker to load the baked artifact + a generated updater function.
- Runtime is a slim three.js build with no node builder — just bind-group setup + typed-array writes per frame.

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
│   · source owners + conservative module revisions
└─────────────────────────────────────────────┘
         │
         ▼  (codegen, phase 3)
┌─────────────────────────────────────────────┐
│ generated virtual modules — static artifact,
│ optional WGSL pool, and updater.js writes via
│ runtime/writers.js
└─────────────────────────────────────────────┘
         │
         ▼  (runtime, phase 4)
┌─────────────────────────────────────────────┐
│ __applyPrecompiled(material, artifact, expected)
│   · assert hash === expected
│   · wrap material in PrecompiledMaterial
│   · register artifact
└─────────────────────────────────────────────┘
```

## Packages

### `@tsl-precompile/plugin`

The Vite plugin. Runs at build time.

- `src/index.js` — plugin entry; exports `tslPrecompile(options)`.
- `src/babel-transform.js` — finds `.precompile('name')` call sites; rewrites them.
- `src/dev-capture-server.js` — POST endpoint for the runtime marker in dev mode. User and auxiliary writes share one atomic queue; semantically identical recaptures preserve artifact/manifest bytes and skip redundant HMR invalidation. Current content-addressed user artifacts are contract-validated before their first durable write, and represented signed families are merged and revalidated inside that same queue.
- `src/node-harness.js` — headless three.js + mock WebGPU, for CI verify.
- `src/emit-updater.js` — descriptor → static updater.js codegen.
- `src/emit-manifest.js` — artifact JSON → virtual module source.
- `src/wgsl-optimize.js` — build-output-only WGSL minify/dedupe support, including the shared `virtual:tsl-precompile/__wgsl` pool.
- `src/hash.js` — artifact hash wrapper around the shared graph normalizer from `@tsl-precompile/contract`.
- `src/three-rewrite.js` — strict, version-locked AST rewrites for the compiler-free Three closure. The r184 Renderer rewrite installs exact-caster replay, graph-free `ReplayNodeLibrary`, and removes the stock shadow-node graph. The exact `CubeRenderTarget.fromEquirectangularTexture()` lifecycle is replaced by a preflighted replay adapter. Complete comment-free AST fingerprints replace Three's last `NodeUtils` / node-constants owners and add lazy texture-loader tracking to Three's exact `Loader` constructor; loader-free source builds therefore retain no concrete loader/fetch/cache closure. Any upstream semantic drift fails the slim build instead of partially applying a cut.
- `src/vendor/` — vendored files from the three.js fork (compileTSL, extractUniformPlan, …), plus the centralized private RenderObject observer. A bounded observer epoch snapshots reused render contexts and supplies complete real-render variant families to extraction; incomplete families fall back atomically to synthetic compilation.

### `@tsl-precompile/contract`

Shared extractor/codegen/runtime contract helpers.

- `src/graph-normalize.js` — one graph-normalization implementation imported by plugin and runtime hashers.
- `src/render-context.js` — canonical shader-topology signature for renderer, scene, camera, object, geometry, clipping, and MRT state.
- `src/render-selector.js` — graph-free, canonical RenderObject topology used to select a captured variant in compiler-free replay; its exported scene descriptor is also the sole environment/fog invalidation vocabulary. Target topology distinguishes the default/output/intermediate and 2D/cube/array/3D surfaces, snapshots active face/mip and effective samples, and signs replayable attachment/MRT state while excluding resize dimensions. Shadow-depth selectors describe the effective source-caster branches (map/color/mask, depth, position, and alpha) rather than the shared override material alone. The same contract owns render-binding identities and the source-over-artifact precedence used when a renderer-owned pass mixes caster and override-material inputs.
- `src/output-config.js` — versioned renderer-output and RenderPipeline topology descriptors shared by capture, rewrites, and replay; live exposure is intentionally excluded.
- `src/cube-render-target.js` — canonical source-texture and destination-target topology for equirectangular cube conversion, including r184's effective pole filter/mipmap state and custom format/MSAA/depth attachments. It also owns the exact single-texture binding-evidence invariant shared by Node capture, browser capture, and replay.
- `src/artifact-variants.js` — the shared variant-local payload field list and family merge contract used by capture, registries, codegen, and runtime. A family map's represented root payload is authoritative and is projected back onto the durable root while root-only metadata is preserved; private cache keys are only family-local, equivalent cross-family collisions canonical-union semantic selectors, divergent payload collisions fail closed instead of overwriting a shader family, and emitted family keys are ordered independently of capture arrival.
- `src/material-compute.js` — the versioned material-global compute ownership contract. It validates embedded precompiled kernels, exact resource and render-binding identities, initial state, lifecycle paths/cadence, and schedule order across every represented render variant.
- `src/light-identities.js` — shared capture normalization and validation for variant-local light identity tables; slots retain legacy fields but resolve through one complete record per light.
- `src/stable-json.js` — deterministic JSON encoding for persisted selectors and payload comparisons.
- `src/kinds.js` — shared `source.kind` registry, blocked-kind reasons, artifact payload/aggregate validation, and source-kind collection.
- `src/texture-props.js` — canonical material texture slots and node-graph texture keys.

### `@tsl-precompile/runtime`

Ships with the user's bundle. Runtime only.

- `src/precompile-marker.js` — `Material.prototype.precompile`. In dev, calls the extractor + POSTs artifact. In prod, replaced by transform.
- `src/auxiliary/cube-render-target-capture.js` — isolated dev-only owner for CubeRenderTarget's temporary graph, exact face camera, compile-lock coordination, source-state restoration, and capture-resource disposal; `aux-marker.js` remains discovery/registration/persistence orchestration.
- `src/apply-precompiled.js` / `src/apply-precompiled-development.js` — conditional `__applyPrecompiled` boundary injected by the transform. Production keeps hash and live source-graph freshness gates; development additionally loads the shared artifact-schema validator.
- `src/slim-replay-renderer-context.js` — graph-free renderer context/cache identity and explicit high-precision state for replay; it preserves the narrow `RenderObject` invalidation protocol without constructing a TSL `ContextNode`.
- `src/slim-replay-lighting.js` — graph-free per-scene light state used by RenderList and semantic variant selection.
- `src/slim-replay-node-manager.js` — compiler-free render/compute state manager; hydrates artifacts directly and caches by material identity plus semantic topology.
- `src/slim-replay-node-library.js` — graph-free owner for the private renderer library registry. Both Renderer construction paths use this exact compatibility surface, and the stock Three `NodeLibrary` is forbidden replay residue.
- `src/slim-replay-node-core-primitives.js` — exact r184 `hash`, `hashArray`, `hashString`, and `NodeAccess` owner used by renderer replay and the safe public `NodeUtils` compatibility surface. Strict whole-module rewrites keep Three's Node-core owners at zero rendered bytes.
- `src/slim-node-compat.js` / `src/slim-replay-lights-node.js` — shared graph-free Node compatibility and the small replay `LightsNode`; lighting replay no longer imports the broad TSL/PassNode stub module.
- `src/slim-replay-shadow-material.js` — graph-free, per-caster shadow replay identity created at Renderer’s exact override handoff. It keeps the shared captured shadow artifact, carries the exact caster through a non-serializable contract sidecar, mirrors Three’s per-draw alpha/render state, unwraps callback-visible material identity, and turns canonical caster-topology changes into Three-compatible material/program invalidation without inheriting shared alpha-test version churn. Because complete shadow families are registered before replay, the slim Renderer never constructs Three's stock color/depth/position shadow-node graph.
- `src/slim-replay-background.js` — compiler-free background pass; selects a captured artifact from the raw scene input, isolates texture refs per scene, and preserves Three's clear/XR/sky-mesh behavior.
- `src/slim-replay-output.js` — graph-free renderer-output and RenderPipeline material adapter; selects exact topology, isolates texture refs per owner, validates 2D/array sampling, and disposes replacements safely.
- `src/slim-replay-cube-render-target.js` — graph-free equirectangular conversion adapter. It selects an exact source/destination capture, validates one sampled-texture identity across the complete artifact family, clones the registry template, and wires the live source without retaining CubeRenderTarget's TSL graph.
- `src/slim-replay-scene-nodes.js` — graph-free environment/fog topology state; hashes the shared semantic descriptor, preserves Three's invalidation axes, and fails closed when an opaque custom scene graph is replaced.
- `src/slim-source-entry.js` / `src/slim-source-common.js` — guarded application-tree-shaken slim mode. The Vite plugin routes Three internals through the same replay adapters as the checked prebuilt build, preserves one exact Three source identity, validates a plugin/runtime policy handshake, and rejects compiler or classified stock-adapter residue in final chunks. In prebuilt mode, generated `/apply`, `/writers`, `/generated/light-writer`, and `/slim-support/node-dependencies` imports alias to helpers exported by the same prebuilt singleton. Loader tracking is installed lazily on the exact Three `Loader` subclass only when constructed, while allocation-only compatibility stubs are marked pure so selective applications do not pay for unused Node-material shells.
- `src/hydrate/*` — runtime hydration modules: static binding allocation, texture/source resolution, built-in texture reconstruction, live texture registry, shared light identity resolution, per-frame texture rebinders, and source-qualified material binding ownership. Signed shadow artifacts resolve caster-owned scalar/texture/graph inputs from the exact caster while source-local render-material exceptions remain on the renderer-owned override. Each hydrated state owns cloned mutable attribute/storage/uniform-live records and exact graph update phases, so shared artifact families cannot leak the first caster’s GPU resource or live node; legacy shadow graphs read the temporary renderer-owned override as before.
- Slim-replay hydration imports exact `three/src/**` constructors/constants instead of the bare Three barrel. This preserves module identity for the prebuilt build and is the tree-shaking prerequisite for the guarded slim source entry.
- `src/hydrate/variants/artifact-variant-selector.js` — exact semantic variant selection; signed artifacts fail closed on an uncaptured topology while old unsigned artifacts retain cache-key/MRT compatibility.
- `src/slim-support/live-scene-index.js` — first productized slim-support helper for live texture indexing and null-image healing.
- `src/slim-support/pmrem.js` — productized PMREM support helpers for artifact/source detection, cache orchestration, and `_textureRefs` wiring; the harness still supplies the full-renderer generator.
- `src/hydrate/material-compute.js` / `src/hydrate/material-compute-ownership.js` — hydrate the signed material-global compute contract before draw-variant state. `precompiled` mode replays embedded storage-buffer kernel artifacts and exact lifecycle/schedule paths without a live graph. Storage textures and other unsupported proofs remain explicit `hybrid-required` descriptors, which fail closed until the configured support instance completes one exact delegated transaction for that material.
- `src/slim-support/auto-compute.js` / `src/slim-support/compute-sync.js` — compatibility discovery for retained raw `ComputeNode` graphs plus exact shared-device resource transfer. `hybrid-required` dispatch pre-shares sampled/read-only inputs, invalidates replaced full-renderer bind groups, synchronizes only contracted writable outputs, aligns the full renderer's logical NodeFrame without disturbing its render cadence, initializes once per renderer/device generation, and revokes all prior support-owned leases before each serialized transaction. Owner-local assignments are applied only after exact render-variant selection.
- `src/slim-support/shadow-fallback.js` — fail-closed standard Directional/Spot/Point depth-shadow population through a shared-device full renderer, including proxy-scene caching, depth-texture sharing, and lifecycle-safe disposal. The cache owns only its cloned geometry, stand-in materials, cloned shadows, and internal discard targets; public disposal restores source shadow references by identity and serializes cleanup with in-flight GPU work. Transmitted/VSM/custom/skinned/morph families remain explicit adapters rather than silent approximations.
- `src/slim-support/postprocess-frame-scheduler.js` — owner-scoped once-per-logical-frame claims for pass producers, context effects, consumers, and terminal effects. Separate renderer scopes share work through the explicit `(frameId, renderId)` identity; failed work releases its claim and downstream dependencies fail closed.
- `src/writers.js` — `writeMat4 / writeVec4 / writeF32 / writeColor`.
- `src/artifact-loader.js` — manifest resolver.
- `build/three.webgpu.slim.js` — prebuilt slim three.js (no node builder).
- `build-tools/slim-bundle-analysis.js` / `slim-budget.json` — deterministic Rollup graph metrics and reviewable caps shared by the prebuilt, generated-helper consumer, minimal-source, and advanced-source production gates. Every profile enforces compiler/stock-adapter absence and retained Node/TSL module count plus rendered bytes; source profiles additionally reject split bare-Three identity, while the helper profile requires exactly one prebuilt runtime and zero `runtime/src` copies. Run `pnpm test:slim:budget`; use `pnpm analyze:slim` for JSON output.

### `packages/examples/*`

Integration testbeds: ocean, bloom, compute, background, shadow-debug, compute-debug, batch, and the docs site.

## Staleness gates

Layered so payload drift, ordinary source edits, and toolchain drift fail loudly:

1. Artifact content hash over emitted shaders, bindings, uniform plan, render state, and variants (`__hash`).
2. Stable call-site ownership + conservative whole-module revision check at build time.
3. Hot re-extract in dev on file save.
4. Build-time exact Three/toolchain metadata mismatch → hard error.
5. Virtual-module content-identity mismatch → hard error.
6. Runtime source-graph recomputation before manual material adoption (`autoMark` uses the call-site gate because it rewrites the constructor before later graph assignments).
7. `pnpm verify` CI gate: committed artifact metadata, schema, and source-kind validation.

## Evolution / structural debt

For the structural changes that make the plugins easier to evolve and 100% visual
fidelity reachable (extracting the slim-support runtime module, splitting the hydrator,
a shared extractor↔codegen↔runtime contract, de-duplicating the graph hasher, hardening
the three.js fork seam, …), see [ARCHITECTURE_EVOLUTION.md](./ARCHITECTURE_EVOLUTION.md) —
the prioritized P0→P3 audit.
