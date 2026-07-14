# vite-plugin-tsl-precompile

AOT precompile for three.js TSL materials. You mark each material with
`.precompile('name')` in your source; the plugin extracts it to a static WGSL
shader plus a generated per-frame UBO updater at build time. The slim runtime
mode optionally swaps `three/webgpu` for a node-builder-stripped bundle so the
TSL→WGSL compiler doesn't ship to production at all.

Inspired by Unreal's Material Compiler and Unity's Shader Graph — explicit
author markers, offline shader compilation, dumb runtime.

**What you get:** predictable cold start (no TSL→WGSL compile blocking first
frame), lower per-frame CPU (AOT updater writes UBO bytes directly — no node
graph traversal, no closure dispatch), and a layered staleness gate that
fails loudly instead of regressing visuals silently.

**Bundle size.** The slim runtime bundle ships **~240 kB gzip (~200 kB
brotli)** versus **~280 kB gzip** for stock `three.webgpu` + `three.core` —
so slim is modestly *smaller* on the wire, not larger. But the bundle is not
the headline: the win is *what runs at runtime* (no TSL→WGSL compile on the
first frame, no node-graph traversal per draw), not *what's downloaded*. The
download delta widens on apps that pull in many TSL helpers / postprocessing
chains, where stock three.js drags the whole node-builder + TSL function
library in while slim ships only stubs. **Run the numbers on your own scene.**

**Site:** https://makio64.github.io/vite-plugin-tsl-precompile/

> **Status — experimental.** The beta target is ordinary PBR app rendering
> (`Mesh{Standard,Physical}NodeMaterial` + texture maps + env/PMREM + direct
> lights + shadows + material uniforms). Focused MRT/render-target guards are
> green, while compute/storage and broad postprocessing remain deferred.
> The latest generated coverage table is at [packages/examples/batch/results/coverage-summary.md](packages/examples/batch/results/coverage-summary.md).

## Requirements

| | Minimum |
|---|---|
| **Renderer** | `WebGPURenderer` only — no WebGL fallback |
| **Browser** | WebGPU-capable: Chrome/Edge 113+, Safari 18+ (or Safari Technology Preview) |
| **three.js** | `>= 0.184.0`, **pinned to an exact patch** in `package.json` (e.g. `"three": "0.184.0"`, not `"^0.184.0"`). Artifacts are versioned against the exact WGSL-emitter package. The checked-in slim bundle currently requires exactly `0.184.0`. See [MIGRATION.md](MIGRATION.md) for the re-capture workflow when bumping deliberately. |
| **Vite** | `>= 6.4.3` |
| **Node** | `>= 20.19` (build tooling only; not a runtime requirement) |

> **Adopting this on your own project?** Start at [BYO.md](BYO.md) — a 5-minute walkthrough covering install, first capture, day-2 workflow, and the common pitfalls.

## Quickstart

```sh
pnpm add -D vite-plugin-tsl-precompile
pnpm add @tsl-precompile/runtime
```

**`vite.config.js`:**

```js
import { defineConfig } from 'vite';
import tslPrecompile from 'vite-plugin-tsl-precompile';

export default defineConfig( {
	plugins: [ tslPrecompile() ],
	// `WebGPURenderer.init()` is async; the recommended app-entry pattern
	// uses top-level `await`. Vite's default browser target is `modules`
	// (ES2020) which does not allow that, so we bump to `esnext`.
	build: { target: 'esnext' },
	optimizeDeps: {
		// three.js's WebGPU entry pulls a lot of node-graph code via dynamic
		// imports — pre-bundling keeps first paint snappy.
		include: [ 'three', 'three/webgpu', 'three/tsl' ],
	},
} );
```

**App entry:**

```js
import { WebGPURenderer, MeshStandardNodeMaterial, Scene, PerspectiveCamera, Mesh, SphereGeometry } from 'three/webgpu';
import { color, mix, uv } from 'three/tsl';
import { setupPrecompile } from '@tsl-precompile/runtime/setup';

const renderer = new WebGPURenderer();
const setup = setupPrecompile( { renderer } );
await renderer.init();
await setup.ready;          // ← registers this renderer with the marker

const material = new MeshStandardNodeMaterial();
material.colorNode = mix( color( '#224' ), color( '#88c' ), uv().y );
material.precompile( 'my-material' );    // ← the one line you add

const scene = new Scene();
const camera = new PerspectiveCamera( 45, innerWidth / innerHeight, 0.1, 100 );
camera.position.z = 3;
scene.add( new Mesh( new SphereGeometry(), material ) );
renderer.setAnimationLoop( () => renderer.render( scene, camera ) );
```

Run `vite` once. The plugin captures the live material and writes
`./artifacts/my-material.<hash>.json`. Commit the artifact, then `vite build`
ships precompiled WGSL plus a generated UBO updater — no TSL builder at
runtime. Capture begins only after the marker is observed in a real render,
so lights, shadows, fog, camera type, geometry attributes, instancing/skinning,
clipping, and MRT state select the correct shader variant.

A full runnable copy lives in
[packages/examples/getting-started](packages/examples/getting-started).

For MRT / `RenderPipeline` projects, enable aux capture and pass the live
PassNode after you build the pass graph:

```js
const setup = setupPrecompile( { renderer, scene, camera, aux: true } );
await setup.ready;

const scenePass = pass( scene, camera ).setMRT( mrt( { output, normal } ) );
await setup.captureAux( { passNode: scenePass, renderPipeline } );
```

## How it works

1. **Dev capture.** `material.precompile('name')` queues the material in your
   browser. On its first real `renderer.render(scene, camera)`, the runtime
   records the owning object and render context, then borrows that renderer for
   an isolated extraction pass and POSTs the resulting WGSL + uniform plan to
   the plugin's dev-only capture endpoint.
   The plugin writes `./artifacts/<name>.<hash>.json`.
2. **Build rewrite.** A Babel pass replaces `material.precompile('name')` with
   `__applyPrecompiled(material, virtualArtifactModule, expectedHash)` and
   hoists `import * as __tsl_art_<name> from 'virtual:tsl-precompile/<name>'`.
   The plugin's `load()` hook resolves that virtual module to the captured
   artifact JSON + a generated `updater.js` that writes UBOs per frame.
3. **Slim runtime (optional).** Production builds can use the checked prebuilt
   runtime (`slim: true`) or the guarded application-tree-shaken entry
   (`slim: 'source'`). Both strip the node builder; dev/serve deliberately
   keeps full Three so capture can generate WGSL. Only paths represented by
   precompiled artifacts or explicit replay/fallback adapters work in slim.

## Adoption modes

### 1. Explicit `.precompile()` markers (recommended)

You add one line per material:

```js
material.precompile( 'water' );
```

Predictable, reviewable, names survive refactors.
Names are project-global artifact IDs: keep them unique and use only letters,
digits, `.`, `_`, and `-` (no path segments or `..`).

### 2. `autoMark` — zero source edits

```js
tslPrecompile( { autoMark: true } );
```

The plugin chains `.precompile('auto-<n>')` onto every `new *NodeMaterial(...)`
it encounters. Great for trying the pipeline on an existing project without
touching shader source.

Caveat: artifact names are positional. Reordering materials in source
reshuffles names, which invalidates the on-disk artifacts.

### 3. `slim` — ship a node-builder-stripped three.js

```js
tslPrecompile( { slim: true } );
```

Production has two compiler-free delivery modes:

```js
tslPrecompile( { slim: true } );       // checked, prebuilt runtime
tslPrecompile( { slim: 'source' } );   // application-tree-shaken source
```

Both alias `three/tsl` to fail-loud replay stubs. `slim: true` aliases
`three/webgpu` to the checked `@tsl-precompile/runtime/slim` file.
`slim: 'source'` aliases it to a guarded source entry so the application
bundler can discard unused Three constructors and runtime exports. A minimal
WebGPU renderer build measured 162,508 bytes gzip in source mode versus
223,943 bytes for the current prebuilt file (61,435 bytes, or 27.4%, smaller).

The source entry is build-only: importing it without a matching plugin fails,
plugin/runtime policy revisions are checked, and the final bundle is rejected
if a Three node compiler or stock replay-owned adapter survives. `vite dev`
keeps the full Three entries in either mode so `.precompile()` and auxiliary
capture still have a node builder.

When either slim mode is configured, the development `setupPrecompile()`
hook also observes successful real renders and captures each renderer-output
topology required for tone mapping and color-space replay. Repeated renders
of the same topology are deduplicated; changes such as tone mapping, output
color space, array sampling, or multiview produce another exact artifact.
This narrow path does not trigger an automatic background / shadow / PMREM /
post-processing sweep; those feature-specific captures stay explicit through
`captureAux()`.

The published slim bundle is currently built against exactly three `0.184.0`.
A slim build fails early when the consumer resolves another patch instead of
combining incompatible renderer internals. Source mode uses the consumer's
installed Three source, but capture and production build must still resolve
the same exact patch; artifacts from another patch are rejected.

**What slim mode actually changes:**
- ✅ Eliminates the TSL→WGSL compiler from production runtime (no JIT shader
  compile at first frame, no node-graph traversal each draw).
- ✅ Removes node-graph data structures from memory.
- ✅ Catches forgotten `.precompile()` markers as loud runtime errors instead
  of silent live compilation.
- ✅ Smaller on the wire: the slim bundle is ~240 kB gzip vs ~280 kB for
  stock `three.webgpu` + `three.core`. The gap widens on scenes that pull in
  many TSL helpers / postprocessing chains; on a minimal scene it's modest.

**`optimizeDeps` is required** in `vite.config.js` for slim:

```js
optimizeDeps: {
	include: [ 'three', 'three/webgpu', 'three/tsl' ],
},
```

For larger apps that still have non-precompiled helper meshes, Inspector
overlays, PMREM work, compute outputs, or post-processing passes, use the
public slim-support entry instead of reaching into runtime internals:

```js
import { createSlimSceneSupport } from '@tsl-precompile/runtime/slim-support';

const support = createSlimSceneSupport( {
	renderer,
	loadThreeFullModule: () => import( 'virtual:tsl-precompile/full-three' ),
	fullRendererFallback: true,
} );

support.indexScene( scene );
await support.ensureFallback();
```

Load the virtual full-three entry dynamically for fallback code so it stays
in a separate lazy chunk. A direct production
import from `three/webgpu` intentionally resolves to slim and is rejected by
the fallback helper.

For offscreen override-material renders such as contact shadows or depth
prepasses, call `support.renderOffscreenOverrideWithFallback( scene, camera )`
after the fallback renderer has been initialized and while your slim renderer
has a render target bound. It renders that target with the shared full renderer
and hands the produced GPU textures back to slim.

Pairs naturally with `autoMark` if you want to remove the live TSL compiler
from production on an existing project without manually marking every
material.

## Plugin options

| Option | Default | Description |
|---|---|---|
| `artifactsDir` | `'./artifacts'` | Where captured artifacts live on disk. |
| `fail` | `'error'` | Use `'warn'` to keep building when a named artifact is missing. |
| `autoMark` | `false` | Chain `.precompile('auto-<n>')` onto every `new *NodeMaterial(...)` automatically. |
| `autoMarkPrefix` | `'auto'` | Prefix used by `autoMark` to name artifacts. |
| `slim` | `false` | `true` uses the checked prebuilt slim runtime; `'source'` lets the application bundler tree-shake the guarded compiler-free source entry. Production only; dev keeps full Three for capture. |
| `minifyWgsl` | `true` | Compact WGSL only in emitted virtual modules; captured JSON stays readable. |
| `dedupeWgsl` | `true` | Hoist repeated WGSL strings into `virtual:tsl-precompile/__wgsl` for tree-shakeable reuse. |
| `threeVersion` | auto-detect | Override the exact three.js package version used in rewrite hashes. It must match the installed package (rarely needed). |

## Troubleshooting

- **`[tsl-precompile] no artifact for "X". Run dev mode once to capture it.`**
  You ran `vite build` before `vite` ever captured the artifact. Run `vite`
  once, commit `./artifacts/X.<hash>.json`, then build.
- **`[tsl-precompile] artifact "X" has N unknown kind(s) ...`**
  The captured material uses a TSL pattern the codegen does not handle yet.
  Either remove the marker for now, or file an issue with the kind name —
  see [packages/examples/batch/results/coverage-summary.md](packages/examples/batch/results/coverage-summary.md)
  for what's currently supported.
- **`... not-yet-animated kind(s) ... frozen-snapshot fallback`**
  The updater is shipping a snapshot fallback for that kind — frame-0 visual
  is correct, but values won't animate over time. Track support at
  [packages/examples/batch/results/coverage-summary.md](packages/examples/batch/results/coverage-summary.md).
- **`[tsl-precompile/slim] X is not available in the slim bundle`**
  You hit a code path that wasn't precompiled in `slim: true` mode. Mark
  that material with `.precompile()` (or enable `autoMark`), re-run dev to
  capture, then rebuild.
- **`slim build refused: ... built against three 0.184.0`**
  The installed three.js patch does not match this release's checked-in slim
  renderer. Pin three to `0.184.0`, or disable `slim` until a matching runtime
  slim bundle is published.
- **`slim source policy mismatch`**
  The plugin and runtime packages came from incompatible releases. Install
  matching `vite-plugin-tsl-precompile` and `@tsl-precompile/runtime` versions.
- **Post-processing renders black or samples stale textures in `slim` mode.**
  Run `precompileAuxiliary(renderer, scene, camera, { three: THREE,
  postProcessing })` once in dev after creating the `RenderPipeline` /
  `PostProcessing` graph. The build rewrite now rebinds live pass/effect
  render-target textures by name for postfx artifacts.
- **`[tsl-precompile] .precompile('X') was called but no dev endpoint is
  configured`** in production. The Babel transform did not run — check that
  `tslPrecompile()` is in your Vite config and you're running through Vite.
- **Hash mismatch on load.** Your source TSL graph changed (or three.js was
  bumped) but the committed artifact is stale. Re-run `vite` to refresh it.

If you use the three.js Inspector addon, also exclude it from `optimizeDeps`:

```js
optimizeDeps: {
	include: [ 'three', 'three/webgpu', 'three/tsl' ],
	exclude: [ 'three/addons/inspector/Inspector.js' ],
}
```

(The addon uses `import.meta.url` to locate `extensions.json`; pre-bundling
rewrites that URL and the fetch falls through to the SPA fallback.)

To avoid the same crash in `vite preview` / production, use the runtime helper
that returns `null` in production-like environments:

```js
import { loadInspectorOptional } from '@tsl-precompile/runtime';

const Inspector = await loadInspectorOptional();
if ( Inspector ) {
	const inspector = new Inspector( renderer );
	// ...
}
```

## What works today

Beta-target features are green for ordinary PBR rendering: standard and
physical node materials, material texture maps, env maps / PMREM, direct
lights, shadows, material uniforms, plus stable artifact invalidation
across dev capture / build rewrite / runtime hash check.

Compute and storage shaders are experimental. The focused MRT/render-target
guard set is green; broad postprocessing beyond focused bloom is deferred.

The latest generated coverage table is at
[packages/examples/batch/results/coverage-summary.md](packages/examples/batch/results/coverage-summary.md).

## Tested configurations

The matrix below is what CI actually exercises on every PR. Configurations
outside it are best-effort — they may work but aren't guarded against
regression.

| Layer | Tested | Notes |
|---|---|---|
| **Operating systems (unit tests)** | Ubuntu, macOS, Windows | All three run the fast plugin + runtime suite on every PR; Linux additionally runs extractor, rewrite, slim, and coverage tests through `pnpm test:full`. |
| **Operating systems (visual / e2e)** | Ubuntu only | Tier-1 visual gate, preview-smoke, and fresh-project-smoke run under `xvfb-run` on Linux. macOS/Windows e2e is not gated. |
| **Browsers** | Chromium (Playwright, SwiftShader Vulkan) | Firefox WebGPU is still flag-gated; Safari is untested in CI. |
| **Node** | 22 (CI) | Plugin/runtime require `>= 20.19`. |
| **Vite** | 8.x (CI) | Plugin declares `vite >= 6.4.3` as a peer; 6.4.3–7 are best-effort. |
| **three.js** | `0.184.0` (locked) + nightly run against `latest` ([three-compat.yml](.github/workflows/three-compat.yml)) | Artifacts are pinned to a three.js patch — see [MIGRATION.md](MIGRATION.md). |
| **Publish path** | `npm install` of `pnpm pack` tarballs into a clean temp project ([fresh-project-smoke](packages/examples/fresh-project-smoke)) | Verifies that `exports`, `files`, `peerDependencies`, and `.d.ts` resolve outside the monorepo. |
| **Bundlers** | Vite only | Plugin is Vite-specific; Rollup/esbuild/webpack are not supported. |

**Known-limited examples.** Sixteen of the 206 stock three.js examples
have the pixel-diff gate disabled — eight stochastic/PRNG-driven compute
demos plus seven postprocessing flows whose float drift is too large for
PSNR. Each carries a per-example justification in
[coverage-config.json](packages/examples/batch/coverage-config.json) under
`pixelGate.disabledNotes`. The replay still loads and renders a
non-trivial frame; only the per-pixel assertion is relaxed.

## Examples in this repo

- [`packages/examples/getting-started`](packages/examples/getting-started) — minimal copy-paste template
- [`packages/examples/pbr-shadows`](packages/examples/pbr-shadows) — PBR sphere + ground + shadow-casting light (two markers in one scene)
- [`packages/examples/ocean`](packages/examples/ocean) — flagship demo: animated TSL + Inspector + aux pass
- [`packages/examples/bloom`](packages/examples/bloom) — post-processing bloom
- [`packages/examples/background`](packages/examples/background) — TSL background node + PMREM
- [`packages/examples/compute`](packages/examples/compute) — minimal compute pipeline
- `packages/examples/*-debug` — regression repros for shadows, postprocessing, PMREM, MRT, compute

See [MIGRATION.md](MIGRATION.md) for porting notes from earlier APIs.

## Development

Three steps to see the flagship demo running locally:

```sh
git clone https://github.com/Makio64/vite-plugin-tsl-precompile.git
cd vite-plugin-tsl-precompile
pnpm install
pnpm dev                 # boots the ocean demo on http://localhost:5173
```

Other useful scripts:

```sh
pnpm dev:getting-started  # the minimal copy-paste template (this README's example)
pnpm dev:bloom            # post-processing bloom demo
pnpm dev:background       # background / PMREM demo
pnpm dev:compute          # compute-shader demo
pnpm dev:shadow-debug     # minimal shadow repro pages
pnpm dev:site             # docs site
pnpm test                 # fast default checks (heavy generation/rewrite suites excluded)
pnpm test:generation      # extractor and artifact-generation tests only
pnpm test:full            # complete release suite
pnpm test:coverage        # coverage-matrix fixtures
pnpm test:e2e -- --filter=webgpu_clearcoat
                          # focused capture/replay against one three.js example
pnpm verify               # artifact/manifest integrity check
```

Contributing? Start with [AGENTS.md](AGENTS.md) (the AI/human contributor
guide), then [ARCHITECTURE.md](ARCHITECTURE.md).

## License

MIT
