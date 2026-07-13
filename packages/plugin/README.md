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

Peer deps: `three >= 0.184.0`, `vite >= 5`.

## Use

```js
// vite.config.js
import { defineConfig } from 'vite';
import tslPrecompile from 'vite-plugin-tsl-precompile';

export default defineConfig( {
	plugins: [ tslPrecompile() ],
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
import * as THREE from 'three/webgpu';
import { WebGPURenderer, MeshStandardNodeMaterial } from 'three/webgpu';
import { color, mix, uv } from 'three/tsl';
import { setupPrecompile } from '@tsl-precompile/runtime';

const renderer = new WebGPURenderer();
const setup = setupPrecompile( { three: THREE, renderer } );
await renderer.init();
await setup.ready;

const water = new MeshStandardNodeMaterial();
water.colorNode = mix( color( '#002' ), color( '#4af' ), uv().y );
water.precompile( 'ocean-water' );      // <-- the only thing you add
```

In dev, `.precompile('ocean-water')` runs the real extractor on the live
material and writes `artifacts/ocean-water.<hash>.json`. In build, the plugin
rewrites that call to inject the baked artifact + a generated updater
function. With `slim: true`, the checked slim runtime bundle skips the node
builder entirely at runtime. Use `slim: 'source'` to expose the same guarded,
compiler-free surface to the application bundler for finer tree-shaking.
Source mode is production-only, checks the plugin/runtime policy revision, and
fails the build if compiler or stock replay modules remain reachable.

Projects that use MRT / `RenderPipeline` should also capture aux artifacts
after the pass graph is built. `setupPrecompile({ aux: true })` exposes
`captureAux(extraOpts)`, so a `pass(scene, camera).setMRT(...)` pipeline can
rendering.

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
| `slim` | `false` | `true` aliases `three/webgpu` to the checked prebuilt runtime; `'source'` lets Vite tree-shake the guarded compiler-free source entry. Dev keeps full Three for capture. |
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
