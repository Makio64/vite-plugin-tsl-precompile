# vite-plugin-tsl-precompile

AOT precompile for three.js TSL materials. Mark materials with `.precompile('name')` in your source; the plugin extracts each one to a static WGSL shader + a generated per-frame UBO updater at build time. Runtime ships a slim three.js without the TSL builder.

Inspired by Unreal's Material Compiler and Unity's Shader Graph — explicit author markers, offline shader compilation, dumb runtime.

## Status

Early work in progress. See [ROADMAP.md](./ROADMAP.md) for the phase plan.

## Install (once published)

```sh
pnpm add -D vite-plugin-tsl-precompile @tsl-precompile/runtime
```

## Usage

```js
// vite.config.js
import { defineConfig } from 'vite';
import tslPrecompile from 'vite-plugin-tsl-precompile';

export default defineConfig({
  plugins: [
    tslPrecompile({
      artifactsDir: './artifacts',
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

## Development

```sh
pnpm install
pnpm dev:ocean           # run the ocean demo against the dev plugin
pnpm test                # unit tests per package
pnpm test:coverage       # coverage-matrix fixtures
pnpm test:batch          # 206 three.js webgpu examples
pnpm verify              # staleness audit: re-extract all artifacts, diff vs committed
```

## License

MIT
