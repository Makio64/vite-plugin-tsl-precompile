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
graph traversal, no closure dispatch), and a five-layer staleness gate that
fails loudly instead of regressing visuals silently.

**What this is *not*:** a bundle-size silver bullet. Measured on a minimal
PBR scene, the slim bundle is roughly the same gzip size as stock three.js
TSL (~220–240 kB gzip either way) — the win is *what runs at runtime*, not
*what's downloaded*. The bundle-size advantage only shows up on apps that use
many TSL helpers / postprocessing chains, where stock three.js drags the
whole node-builder + TSL function library into the bundle while slim ships
only stubs. **Run the numbers on your own scene before assuming a win.**

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
| **three.js** | `>= 0.184.0`, **pinned to an exact patch** in `package.json` (e.g. `"three": "0.184.0"`, not `"^0.184.0"`). Artifacts are versioned against the WGSL emitter; a silent patch bump invalidates them. See [MIGRATION.md](MIGRATION.md) for the re-capture workflow when bumping deliberately. |
| **Vite** | `>= 5` |
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
import * as THREE from 'three/webgpu';
import { WebGPURenderer, MeshStandardNodeMaterial } from 'three/webgpu';
import { color, mix, uv } from 'three/tsl';
import { setupPrecompile } from '@tsl-precompile/runtime';

const renderer = new WebGPURenderer();
const setup = setupPrecompile( { three: THREE, renderer } );
await renderer.init();
await setup.ready;          // ← registers this renderer with the marker

const material = new MeshStandardNodeMaterial();
material.colorNode = mix( color( '#224' ), color( '#88c' ), uv().y );
material.precompile( 'my-material' );    // ← the one line you add
```

Run `vite` once. The plugin captures the live material and writes
`./artifacts/my-material.<hash>.json`. Commit the artifact, then `vite build`
ships precompiled WGSL plus a generated UBO updater — no TSL builder at
runtime.

A full runnable copy lives in
[packages/examples/getting-started](packages/examples/getting-started).

## How it works

1. **Dev capture.** `material.precompile('name')` runs in your browser. The
   runtime borrows the active `WebGPURenderer`, drives the real three.js
   extractor against a synthetic scene containing the material, and POSTs
   the resulting WGSL + uniform plan to the plugin's dev-only capture endpoint.
   The plugin writes `./artifacts/<name>.<hash>.json`.
2. **Build rewrite.** A Babel pass replaces `material.precompile('name')` with
   `__applyPrecompiled(material, virtualArtifactModule, expectedHash)` and
   hoists `import * as __tsl_art_<name> from 'virtual:tsl-precompile/<name>'`.
   The plugin's `load()` hook resolves that virtual module to the captured
   artifact JSON + a generated `updater.js` that writes UBOs per frame.
3. **Slim runtime (optional).** With `slim: true`, the plugin also aliases
   `three/webgpu` to `@tsl-precompile/runtime/slim` — a three.js bundle with
   the node builder stripped out. Only materials reached through a
   precompiled artifact work in slim mode. The bundle is roughly the same
   gzip size as stock three.js TSL on a minimal scene; the win is runtime
   (no JIT shader compile, no node-graph traversal), not download.

## Adoption modes

### 1. Explicit `.precompile()` markers (recommended)

You add one line per material:

```js
material.precompile( 'water' );
```

Predictable, reviewable, names survive refactors.

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

The plugin aliases `three/webgpu` → `@tsl-precompile/runtime/slim` (the
node-builder-stripped bundle) and `three/tsl` → a stub module that throws
loud, descriptive errors if any un-precompiled TSL helper is reached.

**What slim mode actually changes:**
- ✅ Eliminates the TSL→WGSL compiler from production runtime (no JIT shader
  compile at first frame, no node-graph traversal each draw).
- ✅ Removes node-graph data structures from memory.
- ✅ Catches forgotten `.precompile()` markers as loud runtime errors instead
  of silent live compilation.
- ⚠️ Gzip bundle size is roughly the same as stock three.js TSL on simple
  scenes (~220–240 kB gzip either way). The download-size win only appears
  on scenes that pull in many TSL helpers / postprocessing chains.

**`optimizeDeps` is required** in `vite.config.js` for slim:

```js
optimizeDeps: {
	include: [ 'three', 'three/webgpu', 'three/tsl' ],
},
```

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
| `slim` | `false` | Alias `three/webgpu` → the slim runtime bundle. |
| `minifyWgsl` | `true` | Compact WGSL only in emitted virtual modules; captured JSON stays readable. |
| `dedupeWgsl` | `true` | Hoist repeated WGSL strings into `virtual:tsl-precompile/__wgsl` for tree-shakeable reuse. |
| `threeVersion` | auto-detect | Override the three.js version used in rewrite hashes (rarely needed). |

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
pnpm test                 # unit tests per package
pnpm test:coverage        # coverage-matrix fixtures
pnpm test:e2e -- --filter=webgpu_clearcoat
                          # focused capture/replay against one three.js example
pnpm verify               # artifact/manifest integrity check
```

Contributing? Start with [AGENTS.md](AGENTS.md) (the AI/human contributor
guide), then [ARCHITECTURE.md](ARCHITECTURE.md).

## License

MIT
