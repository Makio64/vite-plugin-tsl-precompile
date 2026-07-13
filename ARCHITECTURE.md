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
- `src/dev-capture-server.js` — POST endpoint for the runtime marker in dev mode.
- `src/node-harness.js` — headless three.js + mock WebGPU, for CI verify.
- `src/emit-updater.js` — descriptor → static updater.js codegen.
- `src/emit-manifest.js` — artifact JSON → virtual module source.
- `src/wgsl-optimize.js` — build-output-only WGSL minify/dedupe support, including the shared `virtual:tsl-precompile/__wgsl` pool.
- `src/hash.js` — artifact hash wrapper around the shared graph normalizer from `@tsl-precompile/contract`.
- `src/vendor/` — vendored files from the three.js fork (compileTSL, extractUniformPlan, …).

### `@tsl-precompile/contract`

Shared extractor/codegen/runtime contract helpers.

- `src/graph-normalize.js` — one graph-normalization implementation imported by plugin and runtime hashers.
- `src/render-context.js` — canonical shader-topology signature for renderer, scene, camera, object, geometry, clipping, and MRT state.
- `src/render-selector.js` — graph-free, canonical RenderObject topology used to select a captured variant in compiler-free replay.
- `src/artifact-variants.js` — the shared variant-local payload field list used by capture, registries, codegen, and runtime.
- `src/stable-json.js` — deterministic JSON encoding for persisted selectors and payload comparisons.
- `src/kinds.js` — shared `source.kind` registry, blocked-kind reasons, artifact payload/aggregate validation, and source-kind collection.
- `src/texture-props.js` — canonical material texture slots and node-graph texture keys.

### `@tsl-precompile/runtime`

Ships with the user's bundle. Runtime only.

- `src/precompile-marker.js` — `Material.prototype.precompile`. In dev, calls the extractor + POSTs artifact. In prod, replaced by transform.
- `src/apply-precompiled.js` — `__applyPrecompiled` helper injected by transform.
- `src/slim-replay-lighting.js` — graph-free per-scene light state used by RenderList and semantic variant selection.
- `src/hydrate/*` — runtime hydration modules: static binding allocation, texture/source resolution, built-in texture reconstruction, live texture registry, and per-frame texture rebinders.
- `src/hydrate/variants/artifact-variant-selector.js` — exact semantic variant selection; signed artifacts fail closed on an uncaptured topology while old unsigned artifacts retain cache-key/MRT compatibility.
- `src/slim-support/live-scene-index.js` — first productized slim-support helper for live texture indexing and null-image healing.
- `src/slim-support/pmrem.js` — productized PMREM support helpers for artifact/source detection, cache orchestration, and `_textureRefs` wiring; the harness still supplies the full-renderer generator.
- `src/writers.js` — `writeMat4 / writeVec4 / writeF32 / writeColor`.
- `src/artifact-loader.js` — manifest resolver.
- `build/three.webgpu.slim.js` — prebuilt slim three.js (no node builder).

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
