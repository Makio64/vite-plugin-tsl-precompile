# vite-plugin-tsl-precompile

**Site:** https://makio64.github.io/vite-plugin-tsl-precompile/

AOT precompile for three.js TSL materials. Mark materials with `.precompile('name')` in your source; the plugin extracts each one to a static WGSL shader + a generated per-frame UBO updater at build time. Runtime ships a slim three.js without the TSL builder.

Inspired by Unreal's Material Compiler and Unity's Shader Graph — explicit author markers, offline shader compilation, dumb runtime.

## Status

Experimental, with the main AOT pipeline wired and a narrower v0.1 beta surface now defined. The canonical current snapshot lives in [STATUS.md](STATUS.md); open work is tracked in [BACKLOG.md](BACKLOG.md).

- `pnpm test` runs plugin, runtime, and inspector-panel tests. The slim runtime smoke test exercises `WebGPURenderer.compileAsync()` with a `PrecompiledMaterial`.
- `pnpm test:slim` runs a load-smoke pass across the 206 `webgpu_*.html` examples from a sibling `../three.js` checkout. Load-smoke results only prove examples load or fail loudly; visual correctness is gated by E2E PSNR.
- `pnpm test:e2e -- --filter=<example>` runs the automated stock -> capture -> slim replay harness. It visits a clean stock three.js example for the visual reference, captures constructed NodeMaterials in a separate pass, reloads with the slim bundle and captured artifacts, then fails below the default 30 dB PSNR visual gate. Pass `--verbose` or set `TSLP_E2E_VERBOSE=1` for raw page logs.
- `pnpm test:batch` runs the extractor/codegen batch harness.

The credible v0.1 beta target is not "all 194 graded examples." It is ordinary PBR application rendering: `MeshStandardNodeMaterial` / `MeshPhysicalNodeMaterial`, material texture maps, env maps / PMREM, direct lights, shadows, material uniforms, and stable artifact invalidation. Compute/storage is experimental. MRT and broad postprocessing are deferred until the render-target / PassNode chain is truly wired.

Still experimental: the next production work is shadows first, then PMREM/environment/reflections, then transmission/viewport texture correctness. Refresh visual coverage from the E2E report before quoting pass counts.

## Install

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

Three steps to see it running locally:

```sh
git clone https://github.com/Makio64/vite-plugin-tsl-precompile.git
cd vite-plugin-tsl-precompile
pnpm install
pnpm dev                 # boots the ocean demo on http://localhost:5173
```

`pnpm dev` is an alias for `pnpm dev:ocean` — open the URL and you should see a lit water plane plus the three.js Inspector panel with live `.precompile()` captures. Requires a WebGPU-capable browser (Chrome/Edge 113+, or Safari Technology Preview).

Other scripts:

```sh
pnpm dev:bloom           # post-processing bloom demo
pnpm dev:compute         # compute-shader demo
pnpm dev:site            # docs site
pnpm test                # unit tests per package
pnpm test:coverage       # coverage-matrix fixtures
pnpm test:batch          # extractor/codegen pass over 206 three.js webgpu examples
pnpm test:slim           # slim-bundle load-smoke over the same examples
pnpm test:e2e -- --filter=webgpu_lights_custom
                          # capture -> slim replay for one or more examples
pnpm verify              # artifact/manifest integrity check
```

## License

MIT
