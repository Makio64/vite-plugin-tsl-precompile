# vite-plugin-tsl-precompile

**Site:** https://makio64.github.io/vite-plugin-tsl-precompile/

AOT precompile for three.js TSL materials. Mark materials with `.precompile('name')` in your source; the plugin extracts each one to a static WGSL shader + a generated per-frame UBO updater at build time. Runtime ships a slim three.js without the TSL builder.

Inspired by Unreal's Material Compiler and Unity's Shader Graph — explicit author markers, offline shader compilation, dumb runtime.

## Status

Experimental, with the main AOT pipeline wired and a narrower v0.1 beta surface now defined. The canonical current snapshot lives in [STATUS.md](STATUS.md); open work is tracked in [BACKLOG.md](BACKLOG.md).

- `pnpm test` runs plugin, runtime, and inspector-panel tests. The slim runtime smoke test exercises `WebGPURenderer.compileAsync()` with a `PrecompiledMaterial`.
- `pnpm test:slim` runs a load-smoke pass across the 206 `webgpu_*.html` examples from a sibling `../three.js` checkout. Load-smoke results only prove examples load or fail loudly; visual correctness is gated by E2E PSNR.
- `pnpm test:e2e -- --filter=<example>` runs the automated stock -> capture -> slim replay harness. It visits a clean stock three.js example for the visual reference, captures constructed NodeMaterials in a separate pass, reloads with the slim bundle and captured artifacts, then fails below the default 30 dB PSNR visual gate. The default `test:e2e` and `test:e2e-serial` scripts save `results/shots/*.png` and refresh `coverage-summary.md`; pass `--no-save-shots` or `--no-coverage` only for throwaway diagnostics. The parallel runner uses short-lived batch workers to keep Chromium/WebGPU memory bounded; tune with `--workers=<n>`, `--batch-size=<n>`, or `TSLP_E2E_WORKERS`.
- `pnpm test:batch` runs the extractor/codegen batch harness.

The credible v0.1 beta target is not "all 194 graded examples." It is ordinary PBR application rendering: `MeshStandardNodeMaterial` / `MeshPhysicalNodeMaterial`, material texture maps, env maps / PMREM, direct lights, shadows, material uniforms, and stable artifact invalidation. Compute/storage is experimental. Focused bloom/PassNode replay is green, but MRT and broad postprocessing stay outside the beta target until the wider render-target chain is hardened.

Still experimental: the next production work is shadows first, then broader PMREM/environment/reflections, then transmission/viewport/reflector texture correctness. Refresh visual coverage from the E2E report before quoting pass counts.

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
      // fail: 'error' | 'warn',
      // minifyWgsl: true,  // compact WGSL in emitted prod modules
      // dedupeWgsl: true,  // hoist repeated WGSL strings into a tree-shakeable shared pool
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

## Options

| Option | Default | Description |
|---|---|---|
| `artifactsDir` | `'./artifacts'` | Where captured artifacts live on disk. |
| `fail` | `'error'` | Use `'warn'` to keep building when a named artifact is missing. |
| `minifyWgsl` | `true` | Compacts WGSL only in emitted virtual modules; captured JSON stays readable. |
| `dedupeWgsl` | `true` | Hoists repeated WGSL strings into `virtual:tsl-precompile/__wgsl`, shared by generated artifact modules. |

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
pnpm dev:background      # background / PMREM demo
pnpm dev:shadow-debug    # minimal shadow repro pages
pnpm dev:compute-debug   # minimal compute repro pages (particles / instanced / texture / reduce)
pnpm dev:site            # docs site
pnpm test                # unit tests per package
pnpm test:coverage       # coverage-matrix fixtures
pnpm test:batch          # extractor/codegen pass over 206 three.js webgpu examples
pnpm test:slim           # slim-bundle load-smoke over the same examples
pnpm test:e2e -- --filter=webgpu_lights_custom
                          # capture -> slim replay, saved screenshots, coverage refresh
pnpm test:e2e -- --limit=12
                          # faster partial replay sweep; parallel runner honors limit/offset
pnpm test:e2e -- --limit=24 --batch-size=6 --workers=1
                          # lower-memory sweep: short-lived Chromium/WebGPU worker batches
pnpm test:e2e -- --filter=webgpu_clearcoat.html --timings
                          # print per-pass timing breakdown for slow examples
pnpm test:e2e:replay -- --filter=webgpu_lights_custom
                          # fastest screenshot refresh: reuse saved reference PNGs/artifacts,
                          # then rerun only slim replay; use after runtime-only changes
pnpm test:e2e:shadow-debug
                          # focused capture/replay pass over the minimal shadow repro pages
pnpm test:e2e:compute-debug
                          # focused capture/replay pass over the minimal compute repro pages
pnpm coverage:site        # regenerate coverage markdown + site examples data from saved shots
pnpm verify              # artifact/manifest integrity check
```

## License

MIT
