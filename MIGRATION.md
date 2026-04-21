# Migration guide

For users coming from the `precompileScene()` helper in [Makio64/three.js@tsl-precompile](https://github.com/Makio64/three.js/tree/tsl-precompile), or from no precompile at all.

## From `precompileScene(renderer, scene, camera, …)`

**Before:**

```js
import { WebGPURenderer, MeshStandardNodeMaterial } from 'three/webgpu';
import { precompileScene } from 'three/webgpu';

const renderer = new WebGPURenderer();
await renderer.init();

const water = new MeshStandardNodeMaterial();
water.colorNode = mix(deepBlue, foamWhite, uv().y);

const mesh = new Mesh(geom, water);
scene.add(mesh);

await precompileScene(renderer, scene, camera);
renderer.render(scene, camera);
```

**After:**

```js
import { WebGPURenderer, MeshStandardNodeMaterial } from 'three/webgpu';
import { installPrecompileMarker, setDevRenderer } from '@tsl-precompile/runtime';
import * as THREE from 'three';

const renderer = new WebGPURenderer();
await renderer.init();

installPrecompileMarker(THREE, { devEndpoint: '/__tsl-precompile/capture' });
setDevRenderer(renderer);

const water = new MeshStandardNodeMaterial();
water.colorNode = mix(deepBlue, foamWhite, uv().y);
water.precompile('ocean-water');   // <-- author marker, replaces precompileScene

const mesh = new Mesh(geom, water);
scene.add(mesh);

renderer.render(scene, camera);
```

Add `vite-plugin-tsl-precompile` to your Vite config.

### Key differences

- **No `await precompileScene(...)` call.** Each material opts in via `.precompile('name')`, called wherever the material is constructed — including inside loaders, async callbacks, conditional branches.
- **No scene curation.** Dynamic / lazy-loaded materials Just Work, as long as their construction site reaches a `.precompile()` call.
- **Names are required and authoritative.** The plugin uses the name as the artifact filename + the staleness-hash key + the prod-build rewrite target. Pick stable names; don't generate them.
- **Hash-gated.** The plugin computes a content hash of the material's TSL graph + three.js version + plugin version + name. Mismatch at build → loud error. Mismatch at runtime → throw at app init.

## From no precompile (stock three.js)

The plugin is opt-in per material. To start small, mark just one expensive material:

1. `pnpm add -D vite-plugin-tsl-precompile @tsl-precompile/runtime`.
2. Add the plugin to `vite.config.js` (see [README.md](./README.md)).
3. In your code, after creating the renderer:
   ```js
   import { installPrecompileMarker, setDevRenderer } from '@tsl-precompile/runtime';
   import * as THREE from 'three';
   installPrecompileMarker(THREE, { devEndpoint: '/__tsl-precompile/capture' });
   setDevRenderer(renderer);
   ```
4. Pick your worst-offender material, add `.precompile('something-meaningful')` after the last node assignment.
5. Run `pnpm dev` once — watch the console for `[tsl-precompile] captured "something-meaningful"`. An `artifacts/something-meaningful.<hash>.json` file appears.
6. **Commit `artifacts/`.** It's source — PR diffs are visible, CI re-extracts, staleness is gated.

Repeat for additional materials at your own pace. Materials without `.precompile()` use the full TSL path, unchanged.

## Common errors

### `[tsl-precompile] no captured artifact for "<name>"`

Build-time: the Babel transform found `.precompile('foo')` in source but no `artifacts/foo.<hash>.json`. Run `pnpm dev` once to capture.

### `[tsl-precompile] stale artifact detected for "<name>"`

Build-time or runtime: the source's hash changed since the artifact was captured. Run `pnpm dev` once to recapture.

### `[tsl-precompile] .precompile("<name>") was called but no dev endpoint`

The runtime marker fired in production, meaning the Babel transform didn't run. Check that `vite-plugin-tsl-precompile` is in your `vite.config.js` and the plugin's `enforce: 'pre'` isn't being overridden.

### `[tsl-precompile] no dev renderer registered`

Call `setDevRenderer(renderer)` once after `await renderer.init()`. The marker borrows your renderer for in-browser extraction.

### `unsupported source.kind: <kind>`

The extractor saw a TSL primitive the AOT codegen doesn't yet handle. Open an issue with the offending kind — Phase 5's coverage matrix tracks these.
