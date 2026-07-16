# vite-plugin-tsl-precompile

Vite plugin that AOT-compiles three.js TSL materials marked with
`.precompile('name')` into static WGSL + a generated per-frame UBO updater.

Pairs with [`@tsl-precompile/runtime`](https://www.npmjs.com/package/@tsl-precompile/runtime).

## Status

Experimental.

## Install

```sh
pnpm add -D vite-plugin-tsl-precompile
pnpm add @tsl-precompile/runtime
```

Peer deps: `three >= 0.184.0`, `vite >= 6.4.3`.

## Use

```js
// vite.config.js
import { defineConfig } from 'vite';
import tslPrecompile from 'vite-plugin-tsl-precompile';

export default defineConfig( {
	// Preferred compiler-free profile for a new, fully captured Vite app.
	plugins: [ tslPrecompile( { slim: 'source' } ) ],
	build: { target: 'esnext' },
	optimizeDeps: {
		// three.js's WebGPU entry pulls a lot of node-graph code via dynamic
		// imports — pre-bundling keeps first paint snappy.
		include: [ 'three', 'three/webgpu', 'three/tsl' ],
	},
} );
```

```js
// app entry
import { WebGPURenderer, MeshStandardNodeMaterial } from 'three/webgpu';
import { color, mix, uv } from 'three/tsl';
import { setupPrecompile } from '@tsl-precompile/runtime/setup';

const renderer = new WebGPURenderer();
const setup = setupPrecompile( { renderer } );
await renderer.init();
await setup.ready;

const water = new MeshStandardNodeMaterial();
water.colorNode = mix( color( '#002' ), color( '#4af' ), uv().y );
water.precompile( 'ocean-water' );      // <-- the only thing you add
```

In dev, `.precompile('ocean-water')` runs the real extractor on the live
material and writes `artifacts/ocean-water.<hash>.json`. In build, the plugin
rewrites that call to inject the baked artifact + a generated updater
function. `slim: 'source'` is the recommended compiler-free mode for new Vite
apps whose production paths are captured: it exposes the guarded source surface
to the application bundler for finer tree shaking. `slim: true` selects the
same public surface from the checked single-file prebuilt runtime. Source mode
is production-only, checks the plugin/runtime policy revision, and fails the
build if compiler, stock replay, retained Node/TSL, or split Three-identity
modules remain reachable.

In either slim mode, `setupPrecompile()` automatically captures the exact
renderer-output transform after successful real renders in dev. It deduplicates
each tone-mapping/color-space/sampled-texture/multiview topology and captures a
new one when that topology changes. Other auxiliary features remain opt-in.

Projects that use MRT / `RenderPipeline` should also capture aux artifacts
after the pass graph is built. `setupPrecompile({ aux: true })` exposes
`captureAux(extraOpts)`, so a `pass(scene, camera).setMRT(...)` pipeline can
be captured with its real target topology.

## Automated Recapture

To automate the dev-capture process (e.g. during CI or post-upgrade sweeps) without opening a browser manually:

1. Install Playwright in your project:
   ```sh
   npm install --save-dev playwright
   npx playwright install chromium
   ```

2. Run the recapture tool while your Vite dev server is running:
   ```sh
   # Visits the default http://localhost:5173/ and automatically captures all .precompile() markers
   npx tsl-precompile-recapture
   ```

### Recapture CLI Options

| Option | Default | Description |
|---|---|---|
| `-u, --url <url>` | `http://localhost:5173` | Base URL of the running dev server |
| `-p, --paths <paths>` | `/` | Comma-separated paths/routes to visit |
| `-t, --timeout <ms>` | `10000` | Max time to wait per page in milliseconds |
| `-s, --settle <ms>` | `1000` | Settle delay in milliseconds after all captures finish |
| `--no-headless` | (headless) | Run the browser in headful mode (visible window) |
| `-b, --browser <name>` | `chromium` | Browser type: `chromium`, `firefox`, `webkit` |

## Options

| Option | Default | Description |
|---|---|---|
| `artifactsDir` | `'./artifacts'` | Where captured artifacts live on disk. |
| `fail` | `'error'` | Use `'warn'` to keep building when a named artifact is missing. |
| `autoMark` | `false` | Auto-chain `.precompile('auto-<n>')` onto every `new *NodeMaterial(...)` — zero source edits. |
| `autoMarkPrefix` | `'auto'` | Prefix used by `autoMark`. |
| `slim` | `false` | `'source'` is the recommended guarded, tree-shaken compiler-free entry for new Vite apps; `true` selects the checked single-file prebuilt runtime. Dev keeps full Three for capture. |
| `minifyWgsl` | `true` | Compact WGSL only in emitted virtual modules; captured artifact JSON stays readable. |
| `dedupeWgsl` | `true` | Hoist repeated WGSL strings into `virtual:tsl-precompile/__wgsl` for tree-shakeable reuse. |
| `threeVersion` | auto-detect | Override the three.js version used in rewrite hashes. |

WGSL minify/dedupe affect production virtual modules only — captured JSON
in `artifacts/` stays diffable and useful for debugging.

## More

Adoption modes (`autoMark`, `slim`), troubleshooting, and the live coverage
matrix:
**https://github.com/Makio64/vite-plugin-tsl-precompile**

## License

[MIT](https://github.com/Makio64/vite-plugin-tsl-precompile/blob/main/LICENSE)
