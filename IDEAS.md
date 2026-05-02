# IDEAS — alternative approaches to TSL precompile

A wide brainstorm of other ways to solve the "ship a slim three.js + skip the runtime TSL builder" problem. Some are small variations of the current `.precompile('name')` interface, some replace the entire mental model. None are commitments; this file is a menu, not a plan.

Last updated: 2026-05-02.

---

## 0. What the current approach does (one-paragraph baseline)

Author writes `material.precompile('name')` once. In dev, the runtime marker borrows the active `WebGPURenderer` and runs the real TSL extractor on a synthetic scene; the artifact (WGSL + bindings + uniform plan + hash) is POSTed to a dev-server endpoint and written to `artifacts/<name>.<hash>.json`. In build, a Babel transform rewrites every `.precompile('name')` call to `__applyPrecompiled(material, import('virtual:tsl-precompile/<name>'), '<hash>')`, with the artifact JSON + an AOT-generated `update(frame, material, view, byteOffset)` updater served as a virtual module. The slim runtime ships a three.js without the node builder; `PrecompiledMaterial` wraps the user's material; the hydrator reconstructs `NodeBuilderState` from the artifact; per-frame UBO writes use direct `DataView` calls.

That is one specific point in a *very* large design space. The rest of this document explores other points.

---

## 1. Alternative author interfaces (replacing `.precompile('name')`)

### 1.1 Function wrapper instead of method-on-prototype

```js
import { precompile } from '@tsl-precompile/runtime';

const water = precompile('ocean-water', new MeshStandardNodeMaterial());
water.colorNode = mix(deepBlue, foamWhite, uv().y);
```

- **Pro**: no `Material.prototype` mutation. Plays nicer with TypeScript (the wrapper can return a branded type). Composable with other utilities.
- **Pro**: the order question disappears — `precompile()` returns the same instance and the user mutates it after, but the marker just records the name; the actual extraction still happens on first render.
- **Con**: less ergonomic at the call site (one extra import, one extra word).
- **Con**: every static analyzer needs to know what `precompile()` is — currently the marker is a dotted method name, easy to grep.

### 1.2 Constructor option

```js
const water = new MeshStandardNodeMaterial({ precompile: 'ocean-water' });
```

- **Pro**: zero runtime API surface. The plugin scans `new *NodeMaterial({ precompile: ... })` shapes statically.
- **Pro**: ships nothing on the runtime side at all (other than the artifact loader) if extraction lives entirely in the build step.
- **Con**: requires modifying or wrapping every `*NodeMaterial` constructor. Three.js doesn't accept arbitrary options on its node materials today, so the option is silently ignored without runtime support.
- **Con**: harder to opt-in for materials constructed inside loaders / async callbacks the user didn't write.

### 1.3 Tagged comment / JSDoc directive

```js
const water = /** @precompile ocean-water */ new MeshStandardNodeMaterial();
water.colorNode = mix(deepBlue, foamWhite, uv().y);
```

- **Pro**: zero runtime cost, zero method pollution. Pure build-time signal.
- **Pro**: works with arbitrary expression sites without changing the call shape.
- **Con**: comment-as-API is fragile (minifiers strip them, formatters move them, refactors lose them).
- **Con**: no runtime fallback if the plugin isn't active — code silently runs full TSL.

### 1.4 Module-level factory

```js
// materials/ocean-water.js
import { definePrecompiled } from '@tsl-precompile/runtime';

export const OceanWater = definePrecompiled('ocean-water', () => {
  const m = new MeshStandardNodeMaterial();
  m.colorNode = mix(deepBlue, foamWhite, uv().y);
  return m;
});
```

- **Pro**: factory pattern keeps the *definition* in one place. Tooling can statically resolve `definePrecompiled('name', factory)` and run `factory()` in the harness during build.
- **Pro**: dynamically-constructed materials become opt-in via the same factory entry point.
- **Con**: forces a refactor for code that builds materials inline near scene assembly.

### 1.5 Shader-as-asset import

```js
import oceanArtifact from './ocean-water.precompile?artifact';
```

- **Pro**: fits Vite/Rollup mental model (`?raw`, `?url`). Asset pipeline stays uniform.
- **Pro**: trivial to cache, version, content-hash through standard tooling.
- **Con**: still need a separate authoring step to *create* the artifact. The "single source of truth" then has to live somewhere — a WGSL file? A TSL file? A material module the loader executes?
- **Con**: forces moving material source out of inline scene code.

### 1.6 TypeScript-only declarative interface

```ts
import { precompile } from '@tsl-precompile/runtime';

interface MyMaterials {
  'ocean-water': MeshStandardNodeMaterial;
  'cloud-volumetric': VolumeNodeMaterial;
}
const reg = precompile.registry<MyMaterials>();
reg.set('ocean-water', water);
```

- **Pro**: typed names, IDE autocomplete, compile-time mismatch checks.
- **Pro**: interfaces / `.d.ts` generation could be a build-step output of the plugin (one row per captured artifact).
- **Con**: TypeScript-only sweetener; pure-JS users gain nothing.

### 1.7 Decorator (TC39 stage-3)

```ts
class OceanScene {
  @PrecompileMaterial('ocean-water')
  water = new MeshStandardNodeMaterial();
}
```

- **Pro**: clean for OOP-heavy codebases; the decorator is the marker.
- **Con**: decorators still aren't universally available; double the spec churn over the project lifetime.

### 1.8 Tag in the constructor result via a Symbol

```js
const water = new MeshStandardNodeMaterial();
water[Symbol.for('tsl.precompile')] = 'ocean-water';
```

- **Pro**: zero method pollution; no global API.
- **Con**: not statically analyzable. Marker would need a runtime walk of every material before render.

### 1.9 Configuration file (no source markers at all)

```js
// tsl-precompile.config.js
export default {
  materials: [
    { name: 'ocean-water', from: 'src/scene.js', match: 'water' },
    { name: 'fog',         from: 'src/scene.js', match: /Fog/ },
  ],
};
```

- **Pro**: separate concerns. Source code stays unaware of precompile.
- **Pro**: easy to enable/disable per environment, per build target.
- **Con**: matchers diverge from the code; needs serious tooling to stay in sync.
- **Con**: hard to handle dynamically-constructed materials (loader callbacks, async, conditional code).

### 1.10 No marker at all — detect by construction site

The current `autoMark` mode does this: every `new *NodeMaterial()` is rewritten to chain `.precompile('auto-<file>-<n>')`. Make this the default.

- **Pro**: zero author work for the simple case.
- **Pro**: "if you used a NodeMaterial, you got a precompile" — easy mental model.
- **Con**: variant explosion when conditional code paths produce subtly different graphs at the same construction site.
- **Con**: harder to give individual artifacts meaningful, stable names without author intent.

### 1.11 Hash-the-graph-as-the-name (content-addressed)

```js
material.precompile();   // no name; the plugin uses the graph hash as the artifact id
```

- **Pro**: identical TSL graphs share one artifact regardless of where they're constructed.
- **Pro**: no name collisions, no rename pain, no "did the artifact name follow the variable rename" question.
- **Con**: artifact filenames lose human meaning; `artifacts/sha256-3a7f2c...json` reads worse in PRs than `artifacts/ocean-water.<hash>.json`.
- **Con**: a tiny TSL change generates a new artifact and the old one becomes orphaned; needs cleanup gating.

### 1.12 Multiple variants per name

```js
water.precompile('ocean-water', { variants: { lights: [1, 4], fog: [true, false] } });
```

- **Pro**: makes scene-state variant explosion explicit and bounded at the call site.
- **Pro**: build emits one artifact per (name × variant) cell; runtime picks based on current scene state.
- **Con**: doubles or quadruples the artifact set.
- **Con**: forces the author to reason about scene state per-material — scene-driven concerns leak into material code.

### 1.13 Marker as a dynamic capture trigger

```js
material.precompile('ocean-water').on('capture', (artifact) => uploadToCDN(artifact));
```

- Treat `.precompile()` as an event-emitter: capture happens lazily on first use, listeners can react.
- Could enable runtime-driven capture pipelines (capture once per session, ship to a remote cache, hydrate next session from there).

---

## 2. Alternative artifact formats

### 2.1 Pure WGSL files + JSON binding manifest

Drop the JS updater. Ship `artifacts/<name>.wgsl` plus `artifacts/<name>.bindings.json`. The runtime walks the bindings JSON each frame.

- **Pro**: artifact is human-readable, diff-friendly, copy-pasteable into a debugger.
- **Pro**: no JS codegen at all — the updater becomes a single generic interpreter at runtime.
- **Con**: that's exactly what the current hydrator does — and the project moved away from it for per-frame CPU reasons.

### 2.2 WebAssembly updater

Compile the per-frame UBO writes into a tiny WebAssembly module per artifact.

- **Pro**: zero JS dispatch overhead. Wasm bytecode is typically 10–20× smaller per slot than equivalent JS.
- **Pro**: linear memory makes UBO writes natural; no `DataView` indirection.
- **Con**: Wasm compile cost amortizes poorly for tiny modules; might not actually win for a few dozen writes.
- **Con**: more build complexity (need a tool to emit Wasm bytecode); harder to debug.

### 2.3 Single-blob binary artifact

Custom `.precompile-blob` format: header + WGSL chunk + bindings TLV + uniform plan TLV + (optional) thumbnail.

- **Pro**: one fetch per material. Smaller than JSON.
- **Pro**: extensible (versioned chunks, like glTF).
- **Con**: opaque to git (binary diffs are useless). Loses the source-control story that the current JSON has.

### 2.4 Embed artifact in the JS bundle (no separate fetch)

Already happens in build mode: the virtual module inlines the artifact JSON. Make this the only mode.

- **Pro**: no separate HTTP request. Tree-shakable per material.
- **Pro**: one less moving part (no manifest resolver in the runtime).
- **Con**: artifact size adds to JS parse cost. Heavy materials with big WGSL strings inflate the main bundle.

### 2.5 Lazy-loaded artifact chunks

`__applyPrecompiled(material, () => import('virtual:tsl-precompile/<name>'), hash)` — the artifact is a code-split chunk, fetched on first use.

- **Pro**: main bundle stays tiny; per-material cost is paid only when the material is actually rendered.
- **Pro**: scales well to apps with many rare-use materials.
- **Con**: first-frame stutter on materials that weren't preloaded.

### 2.6 Compressed artifact (Brotli/Zstd)

Ship the WGSL strings + uniform plans as Brotli- or Zstd-compressed blobs, decompressed at first use.

- **Pro**: WGSL is highly compressible; PBR shaders typically shrink 5–10×.
- **Con**: pulls in a decompression library at runtime (defeats the slim story).
- **Mitigation**: rely on HTTP `Content-Encoding: br` instead.

### 2.7 Cross-renderer artifact (WebGPU + WebGL2)

Each artifact carries both WGSL and a Naga/Tint-compiled GLSL fallback. Runtime picks based on backend.

- **Pro**: future-proofs for the WebGL2 backend (still in heavy use on mobile Safari).
- **Con**: doubles the per-artifact storage cost. Naga in JS is ~600 KB.

### 2.8 SPIR-V intermediate

Emit SPIR-V from the build harness; downstream tools (Naga, Tint, custom) cross-compile to WGSL or GLSL.

- **Pro**: integrates with existing graphics-tooling ecosystems.
- **Con**: adds a layer with no obvious DX win for end users.

### 2.9 Artifact bundles per scene

One file per scene, not per material. `artifacts/scenes/scene-A.bundle.json` carries all materials referenced by that scene.

- **Pro**: fewer files; better HTTP/2 multiplexing on slow connections.
- **Pro**: lazy-load whole scenes naturally.
- **Con**: any change to one material invalidates the whole bundle (cache-busting all sibling materials).

### 2.10 Content-addressed artifacts (CDN-shareable)

Artifacts stored under their `__hash` — `artifacts/<sha256>.json`. Different apps that compute the same hash share the same artifact via a public CDN.

- **Pro**: community CDN of pre-extracted artifacts for stock three.js example scenes — instant offline development.
- **Pro**: hash-as-name aligns with the existing 5-layer staleness gate.
- **Con**: name <-> hash mapping has to live somewhere; manifest becomes the indirection.

---

## 3. Alternative update strategies (per-frame UBO writes)

### 3.1 GPU-resident updates via compute pass

Push a "scene state buffer" to the GPU once per frame; a tiny compute shader writes per-material UBOs from it.

- **Pro**: zero CPU updater cost. The CPU side is one buffer write per frame, regardless of material count.
- **Pro**: scales to thousands of materials.
- **Con**: every material needs its UBO-write logic translated to WGSL — a *bigger* AOT codegen target. Currently the AOT target is ~100 lines of JS per material.
- **Con**: WebGPU command-buffer overhead per dispatch dominates for small material counts.

### 3.2 Persistent-mapped buffers

Keep each material's UBO mapped (`mappedAtCreation` + persistent staging buffer). CPU writes go straight into mapped memory, no command-buffer round-trip.

- **Pro**: lower latency than `queue.writeBuffer`; no per-frame command-buffer copy.
- **Con**: WebGPU's persistent-mapped path has narrower browser support; many drivers fall back to a copy anyway.

### 3.3 Dirty-flag tracking

Mark each slot with a "source-changed?" predicate; per frame, only re-write slots whose source value changed.

- **Pro**: huge win for static or slowly-changing materials. Most uniforms in real scenes don't change every frame.
- **Pro**: composable with the current generated `update()` — emit a `updateDirty()` next to it.
- **Con**: change-detection adds CPU work per slot. Wins only if materials are mostly static, loses when most slots change every frame.

### 3.4 Reactive/signal bindings

Bind each slot to a "signal" object (Solid-style). Writes happen on signal change, not in a per-frame pass.

- **Pro**: clear data-flow story; updates only happen exactly when sources change.
- **Pro**: fits naturally with reactive frameworks (Solid, Vue 3, MobX).
- **Con**: forces every uniform source through a signal wrapper. Three.js itself doesn't speak signals.

### 3.5 Pre-recorded WebGPU command bundles

Bake an entire material's draw call (bind group, pipeline, draw indexed) into a `GPURenderBundle` at app boot. Replay the bundle each frame with no command-buffer construction.

- **Pro**: command-buffer construction is a real cost — bundles eliminate it.
- **Pro**: Instances + materials precompiled together — even tighter.
- **Con**: bundles can't change bind groups dynamically; per-frame uniform updates have to happen via `queue.writeBuffer` outside the bundle anyway.

### 3.6 Coalesced writes via `queue.writeBuffer`

Instead of per-slot `setFloat32` on a `DataView` (and one `queue.writeBuffer` per UBO), build a single mega-buffer per render pass and submit one `writeBuffer` for the whole pass.

- **Pro**: dramatically fewer driver calls.
- **Con**: requires the runtime to know all materials in a pass at write time. Adds a pass-level coordinator.

### 3.7 Bind group templates with bindless pointers

If the WebGPU `bindless` extension lands, store per-material UBOs in one big buffer and bind by integer index — same bind group for every draw, just pass the index.

- **Pro**: one bind group per scene, not per material. Minimum overhead.
- **Con**: bindless isn't in the WebGPU spec yet; hypothetical.

### 3.8 Updater on a Web Worker

The per-frame updater runs on a worker; UBO buffers are SharedArrayBuffer. Renderer reads from shared memory each frame.

- **Pro**: keeps the main thread render-only; long materials don't stall layout.
- **Con**: SharedArrayBuffer requires COOP/COEP headers; not always controllable.
- **Con**: cross-thread synchronization adds latency that often exceeds the saved CPU time.

---

## 4. Alternative capture / extraction strategies

### 4.1 Real WebGPU in Node (dawn-node, wgpu-native)

Replace the mock WebGPU device with a real one (Google's `dawn-node`, Mozilla's `wgpu` via NAPI).

- **Pro**: 100% extraction fidelity. Anything three.js does in a browser, the harness does too.
- **Pro**: no "browser baseline" parity test needed.
- **Con**: native bindings — heavier install; not every CI env has working GPU passthrough.
- **Con**: still doesn't capture browser-specific behaviour (texture formats, validation rules).

### 4.2 Headless browser (Puppeteer/Playwright) capture

Drive a real Chrome with the user's app, intercept `compileTSL` calls, save artifacts.

- **Pro**: maximum fidelity. Same bytes the user sees.
- **Pro**: covers loader-driven, async, dynamic materials with no source-level hooks.
- **Con**: heavy install; CI cost; hard to reason about determinism (animations, rAF timing).
- **Con**: how does the harness *find* the materials? Either author marks them or the harness watches all material constructions.

### 4.3 Capture as part of CI

Existing test suite already runs the app under Playwright. Hook into those runs to capture artifacts.

- **Pro**: zero net infrastructure cost for projects that already have visual-regression tests.
- **Pro**: capture coverage maps onto test coverage — if the test suite reaches a material, the artifact is captured.
- **Con**: requires a test suite. Not every project has one.

### 4.4 Capture during user's local dev session

Today's design: dev mode captures on first render; artifact lives in `artifacts/`. Refine: turn the artifact dir into a *cache*, and let the slim runtime fall back to live extraction when an artifact is missing.

- **Pro**: no sharp "must run dev once before build" cliff. First production load extracts and caches.
- **Pro**: turns precompile from a build-step into a runtime-cache pattern.
- **Con**: production now needs the full TSL bundle as a fallback — defeats the slim-runtime story.
- **Mitigation**: ship full bundle on first load, slim bundle thereafter via service-worker swap. (See §5.7.)

### 4.5 LLM-based static extractor

Ask a model to read the TSL graph source and emit WGSL + bindings JSON.

- **Pro**: in principle, no harness or device required.
- **Con**: TSL produces non-trivial WGSL via the node builder (e.g. tonemapping, tangent-space transforms). LLM output isn't byte-deterministic — kills the staleness hash.
- **Use case**: useful as a *suggestion engine* when extraction fails or for human-readable artifact diffs, not as the source of truth.

### 4.6 Snapshot from an offline scene runner

Instead of running the user's full app, ship a `tsl-precompile.scene.js` per material that constructs it in isolation. The harness runs each scene file, captures one artifact each.

- **Pro**: tiny harness; deterministic; runs in pure Node + JSDOM + dawn-node.
- **Pro**: each scene file is reproducible; PR review story improves.
- **Con**: forces materials into per-file scenes — significant refactor for inline-scene-construction code.

### 4.7 Hybrid AST + live capture

Static AST scan resolves the easy cases (literal `MeshStandardNodeMaterial` with literal `.colorNode = color('#fff')`); falls back to live capture only for unresolved nodes (`Fn`, dynamic, async).

- **Pro**: most materials don't need a live pass. Smaller surface for the harness.
- **Con**: dual-path complexity; the partial-static-resolution code is its own bug surface.

### 4.8 Continuous capture / soft-online precompile

The plugin runs the dev server in CI on every PR and refreshes artifacts. Stale artifacts auto-rebake.

- **Pro**: no manual `pnpm dev` step; artifacts always fresh.
- **Pro**: works for orgs that already run heavy CI.
- **Con**: needs a Vite dev server with WebGPU access in CI, which currently means Playwright + headed Chrome.

---

## 5. Alternative runtime architectures

### 5.1 Patch `getNodeBuilderState` directly (no PrecompiledMaterial wrapper)

Today, `__applyPrecompiled` returns a *new* `PrecompiledMaterial` instance. Alternative: monkey-patch the original material's `getNodeBuilderState` to return the artifact-derived state, leaving `mesh.material` untouched.

- **Pro**: callers' references to the original material remain valid (`mat.color = ...` works as before).
- **Pro**: no `copyCommonMaterialProperties` boilerplate.
- **Con**: invasive — every code path that compares `material.constructor` or `material.isMeshStandardNodeMaterial` still sees the original class. Could trigger latent assumptions.

### 5.2 Render on a Web Worker (OffscreenCanvas)

Move the entire renderer to a worker; main thread sends only scene-state diffs.

- **Pro**: jank-free. UI thread free for input/animation.
- **Pro**: precompile model fits naturally — artifacts are static, scene state crosses via `postMessage`.
- **Con**: substantial three.js refactor; not all features (loaders, DOM-bound effects) work cleanly off-thread.

### 5.3 IndexedDB-cached artifacts

Slim runtime checks IndexedDB before loading bundled artifacts. Plugin doesn't need to bundle artifacts at all if a previous session cached them.

- **Pro**: smaller initial bundle for return visitors.
- **Pro**: turns artifacts into client-side state, not source.
- **Con**: artifact staleness across deploys becomes a runtime concern (need to invalidate the cache on version bump).
- **Con**: first-visit cost is unchanged.

### 5.4 Service-worker artifact cache

Service worker intercepts artifact fetches and caches them. Artifact updates use cache-busting URLs (the hash already in the filename works).

- **Pro**: zero extra runtime code; standard browser pattern.
- **Pro**: works across origins/sessions for shared artifacts.
- **Con**: requires service-worker registration; cuts off some hosting environments.

### 5.5 Opt-out / opt-in slim runtime

The current slim runtime is all-or-nothing. Alternative: keep the full TSL builder bundled, and have the runtime *prefer* artifacts when present. Materials without artifacts fall back to the live builder.

- **Pro**: drop-in for any three.js project. No "did I capture every material?" question.
- **Pro**: incremental adoption — start with one material, expand.
- **Con**: defeats the slim-bundle story unless coupled with smart bundle splitting (slim main + lazy-loaded full builder for missing artifacts).
- **Mitigation**: rollup splits the full builder into a separately-loaded chunk; only fetched when a material has no artifact.

### 5.6 "Sidecar" plugin: upstream the marker

`Material.prototype.precompile` lives in three.js itself; the plugin only handles dev capture and build rewriting.

- **Pro**: smaller runtime package; no `installPrecompileMarker` boilerplate.
- **Pro**: discoverable — anyone reading three.js docs sees the option.
- **Con**: requires upstream agreement. Sunag's existing `tsl-precompile` fork demonstrates that's not trivial.

### 5.7 Bootstrap full + swap to slim

First page load uses the full bundle (works for any material). The full bundle's runtime captures artifacts as it renders, ships them to a service worker cache. Subsequent loads use the slim bundle from the cache.

- **Pro**: zero "must precompile first" friction.
- **Pro**: production hosting is the precompile pipeline.
- **Con**: first-load is full-size; the slim bundle benefit only kicks in on second visit.
- **Use case**: best for content-heavy sites with returning visitors (FWA, dashboards). Worst for one-shot landing pages.

### 5.8 Renderer-agnostic runtime helper

The runtime exposes only `loadArtifact(name) -> { wgsl, bindings, update }`. Wiring those into a WebGPU pipeline is the *user's* problem.

- **Pro**: unblocks experiments — custom renderers, alternative bind systems, scratch tools.
- **Con**: most users want the wiring done; this is the wrong abstraction layer for them.

---

## 6. Alternative mental models / paradigms

### 6.1 "Shader components" (Web Components-style)

Each precompiled material is a custom element class, registered via `customElements.define(...)` analogue.

```js
import { OceanWaterMaterial } from '@my-app/materials/ocean-water';
const water = new OceanWaterMaterial();   // already precompiled internally
```

- **Pro**: natural OOP idiom; encapsulates artifact lifecycle.
- **Pro**: maps cleanly to per-package ergonomics ("@some/material" packages).
- **Con**: hides the staleness gate — users don't see the hash check happen.
- **Con**: harder to share artifacts across class instances with subtle TSL differences.

### 6.2 "Effect" pattern (CSS-in-JS analogue)

Author writes WGSL directly + named bindings; TSL is *not* the source of truth. The plugin just emits a runtime adapter.

```js
const oceanFX = createEffect({
  vertex: WGSL_VERT_STRING,
  fragment: WGSL_FRAG_STRING,
  bindings: { time: 'f32', color: 'vec4f', map: 'texture_2d<f32>' },
});
material.applyEffect(oceanFX);
```

- **Pro**: skips TSL entirely. No extractor, no node builder. Tiny runtime.
- **Pro**: bypasses *every* TSL coverage gap.
- **Con**: throws away the JS-built shader-graph DX that drew people to TSL in the first place.
- **Con**: re-invents what three.js's `RawShaderMaterial` already does.

### 6.3 TSL → JS macro at build time

Run TSL through a Babel/SWC macro that *generates* WGSL strings + uniform plans inline — no runtime extractor at all, no live capture step.

- **Pro**: pure compile-time. No dev server, no capture round-trip, no artifact files.
- **Con**: TSL is a JS-side EDSL whose evaluation depends on three.js's runtime (operator overloads, node graph, type promotion). Statically interpreting it as a macro is essentially reimplementing the TSL builder in a Babel plugin.
- **Use case**: works for the simplest TSL graphs; falls over fast.

### 6.4 Material kits (PBR, Toon, Cel, etc.)

Ship *pre-precompiled* material kits as packages: `@tsl-materials/pbr`, `@tsl-materials/toon`, etc. Users install only the kits they use; no per-app extraction.

- **Pro**: zero precompile pipeline for the consuming app. Just `pnpm add @tsl-materials/pbr`.
- **Pro**: maintainers of the kit handle three.js version bumps.
- **Con**: doesn't help users who write custom TSL.
- **Use case**: complementary to per-app precompile; covers the long tail of "I just want PBR fast".

### 6.5 Game-engine-style asset pipeline

Materials become asset-pipeline outputs alongside textures, meshes, audio. A `.tslmat` file is processed by the pipeline into an artifact + a thumbnail + dependency graph metadata.

- **Pro**: integrates with existing game-tooling thinking.
- **Pro**: enables hot-reload, asset browsers, dependency tracking.
- **Con**: huge tooling surface for a small benefit on web projects.

### 6.6 Profile-guided precompilation (PGO)

Ship a "tracer" runtime that records which materials get rendered in real user sessions. Periodically pull the trace into CI, regenerate artifacts only for the materials people actually use.

- **Pro**: bundle stays minimal; no precompile cost for never-rendered materials.
- **Pro**: aligns with how big games do it.
- **Con**: needs telemetry infrastructure.
- **Con**: "first user to hit a new material" pays the full TSL cost.

### 6.7 Material as content (CMS, GLB-embedded)

Bake materials into glTF/GLB extensions. The artifact lives next to the mesh, ships with the asset.

- **Pro**: one fetch buys mesh + materials + maps.
- **Pro**: traditional asset-management workflows apply (versioning, hashing, CDN cache).
- **Con**: requires a glTF extension nobody else implements; lock-in.

### 6.8 Materials as URL-routable assets

`fetch('/_three/materials/ocean-water?hash=<h>')` returns the artifact JSON. The runtime's job is just to fetch + apply.

- **Pro**: routes through any CDN; trivial to cache.
- **Pro**: shared artifacts across multiple apps via central server.
- **Con**: extra fetch per material; only wins if the cache hit rate is high.

---

## 7. Composition & DX ideas (orthogonal to architecture)

### 7.1 Generated `.d.ts` ambient declarations

Plugin emits `tsl-precompile.d.ts` with one entry per artifact name:

```ts
declare module 'virtual:tsl-precompile/ocean-water' {
  export const __hash: string;
  export const update: (frame, material, view, byteOffset) => void;
  export const artifact: { ... };
}
```

- IDE autocompletes available names; refactors update them; missing artifacts surface as TS errors before build.

### 7.2 VS Code extension

Hover over `.precompile('ocean-water')` to see: artifact size, WGSL preview, hash, capture timestamp, unsupported-kind warnings, and a "rebake" button.

- Reuses the inspector-panel data source. Trades implementation cost for serious DX wins.

### 7.3 Bundle-size visualizer integration

Plug into `rollup-plugin-visualizer` to display per-artifact byte cost in the bundle treemap — separate from the user's source.

### 7.4 Snapshot tests for artifacts

`expect(artifact).toMatchSnapshot()` with custom serializer; PRs that change a material's shader produce a visible diff in CI.

- Supplements the existing 5-layer hash gate with a *human-reviewable* artifact-content gate.

### 7.5 Hot-swap at runtime

Dev server pushes an updated artifact via WebSocket. The runtime swaps the bind group + WGSL on the fly without page reload.

- Already partially supported (HMR fires on artifact write); make the runtime side first-class.

### 7.6 Inspector panel power features

- Live UBO viewer: show every byte the updater writes, alongside the source-of-truth value.
- Manual per-uniform override: type a value, see it applied in the running scene.
- Artifact-vs-source diff: side-by-side WGSL of "what the artifact has" vs "what the current source would produce".

### 7.7 CLI mode

`tsl-precompile build` outside Vite. Webpack/esbuild/Rspack/Rollup users get the same artifact pipeline through a build-tool-agnostic CLI; the Vite plugin becomes a thin adapter.

### 7.8 Artifact-versioning convention

`artifacts/<name>@<version>.<hash>.json` — multiple versions in flight during major refactors. Runtime can pin a version explicitly or follow latest.

### 7.9 First-class variant selectors

Instead of `precompile('ocean-water')`, allow `precompile('ocean-water', () => isMobile ? 'lo' : 'hi')`. Plugin emits both, runtime picks the named variant.

### 7.10 "Loose mode" for development experiments

`precompile('ocean-water', { strict: false })` — accept hash mismatch with a warning instead of throw. Lets devs iterate on the source without re-running capture every save.

### 7.11 Normal-vs-precompile benchmark dashboard *(low priority)*

Extend the existing capture/replay harness ([`packages/examples/batch/run-e2e.mjs`](packages/examples/batch/run-e2e.mjs)) to record per-example perf and size metrics in both modes (capture phase = "normal" full `three.webgpu.js` + live TSL builder; replay phase = "precompile" slim bundle + injected artifacts). Surface results on a new standalone [`packages/site/benchmarks.html`](packages/site/benchmarks.html) dashboard.

**v1 metric set:**
- Bundle size (full vs slim three.webgpu, raw + gzip) — one-shot per harness run via `fs.statSync` + `zlib.gzipSync`.
- Per-example synthetic ship size (slim + that example's artifact JSON, gzipped together) — the headline "what would actually ship" number.
- Time-to-first-frame (capture vs replay) — wall time from `page.goto` to first non-empty rendered frame.
- Steady-state frame ms (median of last 60 rAF deltas), `performance.memory.usedJSHeapSize`, server-side capture-extraction wall time.

**Approach:**
- `performance.mark()` calls injected into `fullWebgpuAutoModule()` and `slimWebgpuReplayModule()` wrappers in `run-e2e.mjs`; harvest via `page.evaluate(() => performance.getEntriesByType('measure'))` after each phase.
- Add `--runs=N` flag (default 3) wrapping the per-example loop; record medians for noisy metrics.
- Extend `e2e-report.json` with top-level `bundles` block + per-example `metrics.capture` / `metrics.replay` sub-objects + `summary` medians (medianFirstFrameSpeedup, medianShipSizeReductionGzip).
- New `benchmarks.html` fetches the JSON at runtime; renders 3 hero numbers + sortable per-example table. Site's `vite.config.js` copies the report into static output.

**Why low priority:** the project's current Phase 7/8 gates are *correctness* (PSNR pass rate, slim-runtime smoke) — perf numbers are downstream marketing/validation work. Worth doing once the corpus is green, not before. The slim-bundle / first-frame win is already plausible from `STATUS.md` line 38 (≤300 KB gzip target) without measurement; this just makes it citable.

**Risks:** `performance.memory` is Chromium-only (fine, Playwright uses Chromium); `--runs=3` triples sweep cost (~5 min → ~17 min); machine-dependent numbers need a `summary.machine` fingerprint so site readers can contextualize.

---

## 8. Lateral / "crazy" ideas

### 8.1 ServiceWorker IS the extractor

The full TSL builder lives in a service worker. Main thread renders with the slim runtime. On cache miss, the slim runtime's loader posts a request to the SW, which compiles the artifact, returns it, and caches it.

- **Pro**: zero build step. Zero plugin. The runtime *is* the build tool.
- **Pro**: artifact cache is per-user, per-device.
- **Con**: full TSL builder ships to every user (just lives in the SW context). No bundle-size win unless the SW is itself lazy.
- **Use case**: "smart fallback" for missing artifacts in production; full-bundle baseline in dev.

### 8.2 Whole-scene RenderBundle

Precompile the entire render loop into a single `GPURenderBundle`. The CPU per-frame cost becomes one `executeBundles()` call.

- **Pro**: theoretical floor for per-frame CPU cost.
- **Con**: bundles are immutable — any scene-state change (camera, lights, transforms) invalidates them.
- **Use case**: static scenes (architectural visualizations, gallery viewers).

### 8.3 IPFS / content-addressed network of artifacts

Artifact hash *is* the lookup key on a public peer network. Anyone who's run the same TSL graph anywhere has already produced the artifact; we just fetch it.

- **Pro**: free precompile via the network effect.
- **Con**: cold-start trust model is hard. Hash collisions, poisoning, version churn.
- **Use case**: research curiosity, not production.

### 8.4 Browser-extension precompile assistant

A devtools extension that watches a running three.js app, captures artifacts on the fly, exports them as a downloadable `artifacts/` folder for the developer to commit.

- **Pro**: zero config in the user's app. Open devtools, run scene, save artifacts.
- **Con**: extension review pipelines, browser-specific implementations.

### 8.5 LLM-assisted artifact rebake on TSL change

When a TSL graph changes, instead of re-running the harness, ask a model to *patch* the existing artifact. Verify with a hash + visual diff.

- **Pro**: faster iteration loop.
- **Con**: non-deterministic; must verify against ground truth anyway. Probably saves nothing in practice.

### 8.6 Static-SVG-for-shaders companion

Plugin emits a per-material SVG diagram of the TSL graph next to the artifact. Documentation generators pick it up; PRs that change a material show a graph diff.

- **Pro**: graphic diff > text diff for shader review.
- **Con**: pure DX; doesn't move the perf needle.

### 8.7 "PGO-by-Playwright"

CI runs a Playwright suite that exercises the user's app. The harness records which artifacts get hit. Anything not hit gets stripped from the bundle. Hot path artifacts are inlined; cold ones are lazy-loaded.

- **Pro**: zero manual decisions about lazy vs eager.
- **Pro**: fits with existing visual-regression CI.
- **Con**: needs a healthy test suite to actually exercise the materials.

### 8.8 GPU-side material database

A persistent GPU buffer holds every material's UBO. CPU writes only update slots that changed. Renderer indexes into the buffer by material id.

- **Pro**: eliminates the "one writeBuffer call per material" overhead.
- **Con**: WebGPU buffer-binding restrictions limit how many materials can fit per buffer.

### 8.9 Materials as a remote service (RPC)

The author writes TSL; the build sends it to a hosted compile service that returns the artifact. No local harness needed.

- **Pro**: zero local install; zero `node_modules` for the precompile pipeline.
- **Con**: privacy/security: sending TSL graphs to a remote service.
- **Con**: requires hosting the service, which has cost.

### 8.10 Permission-driven bundle splitting

Three bundles: `tsl-min.js` (no TSL, no fallback — fastest), `tsl-fallback.js` (TSL builder loaded async on demand), `tsl-full.js` (full TSL, dev-only). Plugin picks the right one based on artifact coverage.

- **Pro**: every project gets the best bundle for its precompile coverage.
- **Con**: three build paths to maintain.

### 8.11 First-frame-skip mode

Render a black frame on first paint while the artifact compiles in the background; flip to actual content once ready.

- **Pro**: no janky compile-during-first-frame stall.
- **Con**: an explicit black-frame is worse UX than the current background-compile-with-fallback in many cases.

### 8.12 GPU-driven material switching

Instead of swapping `mesh.material` on the CPU, store an integer `materialId` per draw and have a fragment shader pick from a uniform array of compiled materials.

- **Pro**: removes one CPU-side branch per draw.
- **Con**: shader uniform-array size limits; not every material can coexist this way.

---

## 9. Combinations worth considering

Some ideas are weak alone but strong combined:

- **(1.1 function wrapper) + (5.1 patch in place)** — `precompile(material)` mutates the input rather than returning a new instance. Removes both prototype pollution and the wrapper-object copy-properties dance.
- **(1.10 auto-mark) + (1.11 hash-as-name) + (5.5 fallback to live)** — zero author markers, content-addressed artifacts, graceful degrade. The "smartest" option but also the most-magic, hardest-to-debug one.
- **(2.10 content-addressed) + (5.3 IndexedDB) + (5.4 service worker)** — a fully cache-driven distribution model for artifacts; no per-app precompile pipeline, ever.
- **(4.4 capture during dev) + (5.7 boot full + swap slim)** — turn precompile into a pure runtime cache; no build step.
- **(6.4 material kits) + (1.6 typed registry) + (7.1 generated d.ts)** — strongly-typed pre-baked materials; "PBR as an npm install".

---

## 10. What this list deliberately doesn't try to do

- **It doesn't pick a winner.** Each idea has tradeoffs. Several would conflict if implemented together.
- **It doesn't cost-estimate.** Some ideas are weeks of work; some are days. Read the surrounding code before scoping.
- **It doesn't predict community reception.** "Drop the marker entirely" sounds clean but might violate the project's "loud failure / explicit author intent" principle the README leads with.

The *best* next step is probably: pick 2–3 ideas that sound complementary, sketch their diffs against the current code, see which one moves the most-blocking item out of [STATUS.md](./STATUS.md) §"What's left to do".

---

## 11. Quick reference — current pain points each idea addresses

| Pain point | Ideas that address it |
|---|---|
| Author has to add markers everywhere | 1.10 auto-mark, 1.9 config file, 5.5 fallback, 6.6 PGO, 8.1 SW extractor |
| Variant explosion (light count, fog, etc.) | 1.12 variants, 6.6 PGO, 8.7 Playwright PGO |
| Per-frame CPU dispatch | 2.2 Wasm, 3.1 GPU compute pass, 3.3 dirty flags, 3.5 RenderBundle |
| Bundle size still has hydrator | 2.1 pure WGSL artifact, 5.8 renderer-agnostic, 8.10 permission-driven splits |
| Live-uniform freeze (unnamed UniformNode) | 3.4 reactive, 6.5 game-engine pipeline (signal-driven materials) |
| Artifact freshness in production | 4.4 first-render cache, 5.3 IndexedDB, 5.4 SW cache |
| "Did the rewrite skip my material?" debug | 7.1 .d.ts, 7.2 VS Code, 7.6 inspector live UBO |
| Cross-project artifact reuse | 2.10 content-addressed, 6.4 kits, 8.3 IPFS |
| Build step required at all | 5.5 runtime fallback, 5.7 boot-full-swap-slim, 8.1 SW extractor |
