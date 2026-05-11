# Architecture

## Mental model

- Author marks materials with `material.precompile('name')`.
- In dev, the marker fires the real three.js node builder on the live material and saves an artifact (shader + bindings + uniform plan).
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
│   · __hash (content hash, 3-layer gated)
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
- `src/hash.js` — normalized TSL graph hasher.
- `src/vendor/` — vendored files from the three.js fork (compileTSL, extractUniformPlan, …).

### `@tsl-precompile/runtime`

Ships with the user's bundle. Runtime only.

- `src/precompile-marker.js` — `Material.prototype.precompile`. In dev, calls the extractor + POSTs artifact. In prod, replaced by transform.
- `src/apply-precompiled.js` — `__applyPrecompiled` helper injected by transform.
- `src/writers.js` — `writeMat4 / writeVec4 / writeF32 / writeColor`.
- `src/artifact-loader.js` — manifest resolver.
- `build/three.webgpu.slim.js` — prebuilt slim three.js (no node builder).

### `packages/examples/*`

Integration testbeds: ocean, bloom, compute, background, shadow-debug, compute-debug, batch, and the docs site.

## Staleness gates

Five layered; any single failure stops the build:

1. Content hash (sha256 over normalized TSL graph + three version + plugin version).
2. Hot re-extract in dev on file save.
3. Build-time hash mismatch → hard error.
4. Runtime hash assertion at app init.
5. `pnpm verify` CI gate: wipe + re-extract + diff.
