# Bring your own three.js project

For: someone with an existing three.js + Vite + WebGPU app who wants to
precompile their TSL materials. Five minutes to first capture, plus a short
"day 2" section.

> If you're new to TSL itself, the upstream three.js examples are a better
> starting point. This plugin assumes your scene already renders correctly
> with `WebGPURenderer` and `MeshStandardNodeMaterial`-class materials.

## Before you start

| Requirement | Minimum | Why |
|---|---|---|
| `three` | `>= 0.184.0`, **pinned to an exact patch** | Captured artifacts are versioned against the three.js WGSL emitter — see [MIGRATION.md](MIGRATION.md). A `^0.184.0` range will silently break artifacts on patch bumps. |
| `vite` | `>= 5` | The dev-capture endpoint is mounted as Vite middleware. |
| Renderer | `WebGPURenderer` | No WebGL fallback. |
| Browser | WebGPU-capable | Chrome/Edge 113+, Safari 18+ / Tech Preview. |

In `package.json`, pin three exactly:

```json
{
  "dependencies": {
    "three": "0.184.0"
  }
}
```

Not `^0.184.0`, not `~0.184.0`. Bumping three is an explicit "re-capture artifacts" decision, not something dependabot does for you.

## Install

```sh
pnpm add -D vite-plugin-tsl-precompile
pnpm add @tsl-precompile/runtime
```

Add the plugin to `vite.config.js`:

```js
import { defineConfig } from 'vite';
import tslPrecompile from 'vite-plugin-tsl-precompile';

export default defineConfig( {
    plugins: [ tslPrecompile() ],
    build: { target: 'esnext' },                       // for top-level await
    optimizeDeps: { include: [ 'three', 'three/webgpu', 'three/tsl' ] },
} );
```

## Wire the runtime once at app boot

```js
import * as THREE from 'three/webgpu';
import { setupPrecompile } from '@tsl-precompile/runtime';

const renderer = new THREE.WebGPURenderer();
const setup = setupPrecompile( { three: THREE, renderer } );
await renderer.init();
await setup.ready;     // registers this renderer with the .precompile() marker
```

`setupPrecompile` installs the `.precompile()` method on the three.js `Material` prototype and, in dev, wires the live renderer that the marker borrows for shader extraction. In production, the marker is rewritten away by the Babel transform — `setup.ready` becomes effectively a no-op.

## Mark each material

For each material whose WGSL you want frozen:

```js
const water = new THREE.MeshStandardNodeMaterial();
water.colorNode = /* your TSL graph */;
water.precompile( 'water' );      // ← one line per material
```

The name is the filename of the artifact on disk. Pick something stable — renaming the marker after capture is a re-capture event.

## First capture (dev mode)

```sh
pnpm vite                # or whatever you use to start dev
```

Open the app in a WebGPU-capable browser. The runtime will:

1. Detect each `.precompile('name')` call,
2. Run the real three.js extractor against a synthetic scene that has only that material,
3. POST the captured WGSL + uniform plan to `/__tsl-precompile/capture`,
4. The plugin writes `./artifacts/<name>.<hash>.json`.

**Commit `./artifacts/` to git.** These JSON files are part of your build inputs, like a lockfile.

Repeat for every material you want precompiled. The dev server hot-recaptures on save when you edit a marked material.

## Optional: capture auxiliary passes

If your scene has a background node, post-processing, or PMREM environment, three.js builds extra internal materials at runtime. The slim runtime won't have a TSL builder to recompile them. Capture them too:

```js
import { precompileAuxiliary } from '@tsl-precompile/runtime';

precompileAuxiliary( renderer, scene, camera, {
    devEndpoint: '/__tsl-precompile/capture',
    three: THREE,
    threeVersion: String( THREE.REVISION ).match( /^\d+/ )[ 0 ],
    postProcessing,            // optional, only if you have one
} );
```

Call this once, after your scene is fully assembled. In production builds it silently no-ops — safe to leave unguarded.

## Ship it

```sh
pnpm vite build
```

The Babel transform rewrites every `material.precompile('name')` call into a hash-checked `__applyPrecompiled(...)` that loads the artifact JSON. If an artifact is missing or its hash doesn't match, the build fails loudly with a message telling you which marker to fix.

## Day-2 workflow

| You did this | What happens | What you do |
|---|---|---|
| Edited a marked material's TSL graph | Dev server hot-recaptures and writes a new artifact filename | Commit the new artifact, delete the stale one |
| Renamed `precompile('a')` → `precompile('b')` | Build fails: no artifact for `b` | Run dev once, commit `b.<hash>.json`, optionally delete `a.<hash>.json` |
| Bumped `three` patch version | Build fails: every artifact's hash is stale | Run dev across your whole app, commit the regenerated artifacts. See [MIGRATION.md](MIGRATION.md). |
| Bumped `vite-plugin-tsl-precompile` or `@tsl-precompile/runtime` | Build may fail if the artifact schema changed | Same as a three.js bump — re-capture. |
| Added a new material | Build fails: no artifact for the new marker | Run dev once to capture it |

The five-layer staleness gate (content hash, dev hot-recapture, build mismatch error, runtime assertion, `pnpm verify` CI check) is designed so silent visual regressions are not possible. Loud failure with a clear next step is the only failure mode.

## Optional: `slim: true` (no TSL compiler at runtime, harder mode)

```js
tslPrecompile( { slim: true } )
```

Aliases `three/webgpu` to a node-builder-stripped three.js. **Every** material reachable in production must be marked with `.precompile()` (or `autoMark: true`). Any un-precompiled TSL path throws at runtime with a descriptive error.

**What slim mode buys you:** no TSL→WGSL compile at first frame (predictable cold start), no node-graph traversal per draw, and loud errors on forgotten markers instead of silent live compilation. **It is not primarily a bundle-size win** — measured on a minimal PBR scene, the slim three.js bundle is roughly the same gzip size as stock three.js TSL. Run the numbers on your own scene before assuming a download-size benefit.

Slim is the right choice for shipping a tightly-controlled scene where you want predictable runtime behavior. It is the wrong choice if you have a sprawling scene with addons (`WaterMesh`, `Sky`, etc.) you haven't audited — start without slim, get the dev-capture flow working, then enable slim once you know which materials need markers.

## Common questions

**Can I use Webpack/Rollup/esbuild instead of Vite?** Not today. The dev-capture endpoint is mounted as Vite middleware. Production replay (the runtime side) is bundler-agnostic, but the capture flow assumes Vite.

**What if my project doesn't use TSL — just classic three.js materials?** The plugin is a no-op on non-`NodeMaterial` materials. You only get value if your scene uses TSL.

**Do I have to commit `./artifacts/` to git?** Strongly recommended. They are build inputs and your CI needs them. If you treat them as build outputs and regenerate per-build, you lose the staleness gate and your prod and dev can diverge.

**What about addons (Water, Sky, GLTFLoader)?** GLTFLoader and friends are fine — they load assets, they don't author TSL graphs at runtime. Addons that build TSL graphs in their constructors (e.g., `WaterMesh`) work in non-slim mode but may need manual marker wiring in slim mode. Start without slim.

**How do I know if my scene works before committing to this?** Run `pnpm vite` and look at the dev console. You should see `[tsl-precompile/aux] precompileAuxiliary: ...` and per-marker capture logs. If you see capture errors for specific markers, those are the materials that need TSL graph adjustments — file an issue with the kind name.

**Where do I report issues?** [github.com/Makio64/vite-plugin-tsl-precompile/issues](https://github.com/Makio64/vite-plugin-tsl-precompile/issues). For "does my use case work" questions, paste your `vite.config.js` and one marked material — that's usually enough.

## Where to look next

- [README.md](README.md) — full plugin options reference
- [MIGRATION.md](MIGRATION.md) — version-bump workflow in detail
- [packages/examples/getting-started](packages/examples/getting-started) — minimal copy-paste template
- [packages/examples/pbr-shadows](packages/examples/pbr-shadows) — PBR + shadows, two markers in one scene
- [packages/examples/ocean](packages/examples/ocean) — flagship demo with addons + post-processing + Inspector
