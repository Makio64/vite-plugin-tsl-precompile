# vite-plugin-tsl-precompile

Vite plugin that AOT-compiles three.js TSL materials. Mark materials with `.precompile('name')` in your source; in dev the plugin captures the WGSL + UBO plan to disk; in build it rewrites the call site to inject the baked artifact and a generated per-frame UBO updater. Pair with [`@tsl-precompile/runtime`](https://www.npmjs.com/package/@tsl-precompile/runtime) so the slim three.js skips the node builder entirely at runtime.

## Status

Experimental — see [STATUS.md](https://github.com/Makio64/vite-plugin-tsl-precompile/blob/main/STATUS.md) for the current support snapshot and [BACKLOG.md](https://github.com/Makio64/vite-plugin-tsl-precompile/blob/main/BACKLOG.md) for known limitations.

## Install

```sh
pnpm add -D vite-plugin-tsl-precompile @tsl-precompile/runtime
```

Peer deps: `three >= 0.184.0`, `vite >= 5`.

## Usage

```js
// vite.config.js
import { defineConfig } from 'vite';
import tslPrecompile from 'vite-plugin-tsl-precompile';

export default defineConfig({
  plugins: [
    tslPrecompile({
      artifactsDir: './artifacts',
      // fail: 'error' | 'warn'  — what to do if a named artifact is missing in build
    }),
  ],
});
```

```js
// your source
import { MeshStandardNodeMaterial } from 'three/webgpu';
import { mix, color, uv } from 'three/tsl';

const water = new MeshStandardNodeMaterial();
water.colorNode = mix(color('#002'), color('#4af'), uv().y);
water.precompile('ocean-water');   // <-- the only thing you add

mesh.material = water;
```

In dev, `.precompile('ocean-water')` runs the real extractor on the live material and writes `artifacts/ocean-water.<hash>.json`. In prod, the plugin rewrites that call to inject the baked artifact + a generated updater function, and the slim runtime skips the node builder entirely.

The runtime side (`installPrecompileMarker`, `setDevRenderer`) lives in [`@tsl-precompile/runtime`](https://www.npmjs.com/package/@tsl-precompile/runtime).

## Options

| Option | Default | Description |
|---|---|---|
| `artifactsDir` | `'./artifacts'` | Where captured artifacts live on disk. |
| `fail` | `'error'` | `'error'` or `'warn'` when a named artifact is missing in build. |

## More

Full project story, architecture, and roadmap: [monorepo README](https://github.com/Makio64/vite-plugin-tsl-precompile#readme).

## License

[MIT](https://github.com/Makio64/vite-plugin-tsl-precompile/blob/main/LICENSE)
