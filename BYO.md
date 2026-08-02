# Bring your own three.js project

For: someone with an existing three.js + Vite + `WebGPURenderer` app who wants
to precompile TSL materials for its WebGPU or WebGL 2 backend without delegating
the integration to an AI agent. Commands below use pnpm; the site's [manual setup](https://makio64.github.io/vite-plugin-tsl-precompile/#manual-setup)
can switch between pnpm, npm, Yarn, and Bun.

> If you're new to TSL itself, the upstream three.js examples are a better
> starting point. This plugin assumes your scene already renders correctly
> with `WebGPURenderer` and `MeshStandardNodeMaterial`-class materials.

Your first safe milestone is compatibility mode, not slim mode:

1. Install the exact supported versions.
2. Add `tslPrecompile()` to Vite and call `setupPrecompile({ renderer })` once.
3. Render every real route/state in development and commit the generated
   `artifacts/` directory.
4. Pass source-aware verification, the production build, and a preview over
   the same routes on every renderer backend production can select.

Only then evaluate `slim: 'source'` as a separate optimization.

> **Pre-release availability:** the plugin and runtime are not on npm yet. The
> install commands below become executable with the first alpha publish. To run
> the compatibility path now, clone this repository, install it with pnpm, and
> run `pnpm dev:getting-started`.

## Before you start

| Requirement | Minimum | Why |
|---|---|---|
| `three` | Exactly `0.185.1` for this alpha | Captured artifacts are versioned against the three.js native-shader emitters — see [MIGRATION.md](MIGRATION.md). A range or another patch is unsupported until the deliberate migration and re-capture workflow is complete. |
| `vite` | `>= 6.4.3 < 9` | The dev-capture endpoint is mounted as Vite middleware; Vite 9 is not yet validated. |
| Renderer | `WebGPURenderer` | Its WebGPU and WebGL 2 backends are supported, including `{ forceWebGL: true }` and automatic fallback. Classic `WebGLRenderer` is not supported. |
| Browser | WebGPU or WebGL 2 | It must provide each backend requested for capture and preview. `--backends webgl` works in a WebGL-only environment; the dual sweep also requires a real WebGPU device. |

In `package.json`, pin three exactly:

```json
{
  "dependencies": {
    "three": "0.185.1"
  }
}
```

Not `^0.185.1`, not `~0.185.1`. Bumping three is an explicit "re-capture artifacts" decision, not something dependabot does for you.
The plugin now warns during Vite config resolution when your app's own
`package.json` uses a ranged `three` dependency, because that can update the
native shader emitters without regenerating artifacts.

## Install

```sh
pnpm add -D vite-plugin-tsl-precompile@alpha
pnpm add @tsl-precompile/runtime@alpha three@0.185.1 --save-exact
```

TypeScript projects must install the exact matching Three declarations too:

```sh
pnpm add -D @types/three@0.185.1 --save-exact
```

Run the read-only doctor now and again after the first capture:

```sh
pnpm exec tsl-precompile-doctor --source src
```

It turns version, Vite/setup, marker, and artifact-coverage problems into
ordered next actions. `--json` emits one stable result for CI or a coding agent.
The doctor does not claim route/backend coverage: a production build and
backend-matched previews over every real route/state remain required.

Merge the plugin into `vite.config.js`; preserve existing plugins, aliases,
build settings, and dependency-optimizer entries:

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

Pass the existing renderer that performs the app's real draws. Do not create a
second renderer just for precompilation, and do not initialize the existing
renderer twice. The simplest insertion point is immediately after the app's
one existing `await renderer.init()` call:

```js
import { setupPrecompile } from '@tsl-precompile/runtime/setup';

await renderer.init(); // your app's existing call — keep exactly one
const setup = setupPrecompile( { renderer } );
await setup.ready;     // registers this renderer with the .precompile() marker
```

You may instead call `setupPrecompile({ renderer })` before the existing init;
in that order, run the app's same single init next and await `setup.ready`
afterward. Do not add another renderer or another `init()` call.

`setupPrecompile` installs the `.precompile()` method on the three.js `Material`
prototype and, in dev, wires the live renderer that the marker borrows for
shader extraction. Marker-owning modules also receive a development-only
bootstrap import, so an eagerly imported module can construct a marked material
before this bootstrap body runs. In production, markers are rewritten away and
that conditional bootstrap resolves to an empty module.

## Confirm automatic coverage; add stable names only where useful

Direct application-source `new *NodeMaterial(...)` constructors are detected
automatically, so this material needs no source edit:

```js
const water = new MeshStandardNodeMaterial();
water.colorNode = /* your TSL graph */;
```

Add an explicit override after the final graph assignment when a semantic name
is valuable or the constructor is hidden behind an indirect/dependency-owned
factory:

```js
water.precompile( 'water' );
```

The explicit name is a project-global artifact ID. Pick something unique and
stable, using only letters, digits, `.`, `_`, and `-` (no paths or `..`).
Renaming it is a re-capture event.

## First capture (dev mode)

```sh
pnpm run dev             # use the app's existing dev script
```

Open the app in a browser capable of the selected `WebGPURenderer` backend and
exercise every lazy route and materially different camera, light/shadow,
geometry, render-target, background, PMREM, and post-processing state. The
runtime will:

1. Detect each `.precompile('name')` call,
2. Wait until the material is observed in a real `renderer.render(scene, camera)` call,
3. Preserve its owning object, lights, shadows, camera, geometry, clipping, and MRT context in an isolated extraction pass,
4. POST the captured native shader (WGSL for WebGPU or GLSL for WebGL 2) and
   uniform plan to `/__tsl-precompile/capture`,
5. Write `./artifacts/<name>.<hash>.json` from the plugin endpoint.

**Commit `./artifacts/` to git.** These JSON files are part of your build inputs, like a lockfile.

Captures are backend-specific. An app that always constructs
`new WebGPURenderer({ forceWebGL: true })` needs the WebGL/GLSL matrix. An app
that may use WebGPU or automatically fall back to WebGL 2 needs both the
WebGPU/WGSL and WebGL/GLSL variants for every shipped topology. Use the
recapture command's explicit backend matrix in development and an app-owned
backend switch for production preview; do not replace `WebGPURenderer` with
classic `WebGLRenderer`. Runtime replay rejects a shader/backend mismatch
instead of treating one backend's artifact as the other backend's fallback.

Keep the dev server running. After exercising the app, use a second terminal to
check the actual source roots and artifacts. The commands below assume `src`;
replace or repeat `--source` when the app uses another layout.

```sh
pnpm exec tsl-precompile-doctor --source src
pnpm exec tsl-precompile-verify --source src --source-root . artifacts
git add artifacts/
```

For automated routes, keep the dev server running separately:

```sh
pnpm exec tsl-precompile-recapture --json \
  --url http://localhost:5173 \
  --paths /,/viewer,/effects \
  --backends webgpu,webgl
pnpm exec tsl-precompile-verify --json --source src --source-root . artifacts
```

The explicit backend list visits every declared route twice in isolated
contexts and fails unless the observed post-init `WebGPURenderer` backend
matches each pass. The WebGL pass uses Three's built-in fallback, so it does
not mask `navigator.gpu` or alter application feature detection. Omitting
`--backends` keeps the app-selected single pass.

Recapture success proves accepted browser activity on the declared routes; the
second command proves exact authored/automatic source-marker ownership. The
backend evidence proves the requested native language was captured instead of
silently accepting an unintended fallback.

## Optional: capture auxiliary passes

If your scene has a background node, post-processing, or PMREM environment, three.js builds extra internal materials at runtime. The slim runtime won't have a TSL builder to recompile them. Capture them too:

```js
const setup = setupPrecompile( {
	renderer,
	scene,
	camera,
	aux: true,
} );
await setup.ready;
await setup.captureAux( { postProcessing } );
```

Call this once, after your scene and post-processing graph are fully assembled.
For TSL postfx chains it captures the top-level `post-process` artifact plus
known internal effect materials such as bloom and GTAO. In production builds it
silently no-ops — safe to leave unguarded.

## Ship it

Stop the dev server, build with the app's existing script, then keep the preview
server running while you replay the same route/state/topology matrix on every
captured backend:

```sh
pnpm run build
pnpm run preview
```

Confirm the intended `WebGPURenderer` backend, nonblank changing pixels, and
zero page, console, request, capture, or GPU validation errors. For automatic
fallback, prove both a WebGPU run and a `forceWebGL: true` WebGL 2 run. Record
any authenticated or otherwise unreachable state instead of silently treating
it as covered.

The Babel transform rewrites every marker into a hash-checked
`__applyPrecompiled(...)` that loads the artifact JSON. Stale or corrupt
artifacts fail in every mode. A missing authored marker fails by default.
In compatibility mode only, an uncaptured automatic discovery marker warns and
keeps the live NodeMaterial; slim mode fails closed because it has no compiler
fallback.

## Day-2 workflow

| You did this | What happens | What you do |
|---|---|---|
| Edited a marked material's TSL graph | Dev server hot-recaptures and writes a new artifact filename | Commit the new artifact, delete the stale one |
| Renamed `precompile('a')` → `precompile('b')` | Build fails: no artifact for `b` | Run dev once, commit `b.<hash>.json`, optionally delete `a.<hash>.json` |
| Bumped `three` patch version | Build fails: every artifact's hash is stale | Run dev across your whole app, commit the regenerated artifacts. See [MIGRATION.md](MIGRATION.md). |
| Bumped `vite-plugin-tsl-precompile` or `@tsl-precompile/runtime` | Build may fail if the artifact schema changed | Same as a three.js bump — re-capture. |
| Added a direct NodeMaterial | Compatibility warns and keeps it live until its automatic marker is captured; slim fails closed | Render its real routes/states in dev, verify, then rebuild |

The layered staleness gate combines artifact-content identity, call-site/module
revision checks, dev hot-recapture, exact toolchain checks, runtime validation,
and source-aware verification:

```sh
pnpm exec tsl-precompile-verify --source src --source-root . artifacts
```

Use `--json` for CI and repeat `--source` when the app has several
JavaScript/TypeScript source roots. A changed source module must be observed in dev again before
the next production build accepts its artifact.

## Optional: guarded slim production (no TSL compiler, stricter mode)

```js
tslPrecompile( { slim: 'source' } ) // recommended for a fully captured Vite app
// tslPrecompile( { slim: true } )  // checked single-file prebuilt alternative
```

Both modes alias `three/webgpu` to a node-builder-stripped three.js. **Every**
production path must be represented by captured artifacts or explicit slim
support (automatic detection covers eligible direct constructors by default).
An unsupported live
TSL path throws in pure slim; a path covered by an explicitly initialized full
renderer fallback delegates there instead. Source mode lets Vite
discard unused Three constructors and runtime exports; `true` selects the
stable checked prebuilt file.

**What slim mode buys you:** no TSL→WGSL/GLSL compile at first frame (predictable
cold start), no node-graph traversal per draw, and explicit handling for every
reachable path. The checked Three r185 gzip-9 regression baselines are 176,256
bytes for minimal source, 185,490 bytes for advanced source, and 261,600 bytes
for the prebuilt runtime. Their enforced caps are 184,000, 194,000, and 268,000
bytes. Those are repository fixtures, not a promise for your scene or a current
stock-Three comparison; `pnpm analyze:slim` prints the current exact values.

Slim is the right choice for shipping a tightly-controlled scene where you want predictable runtime behavior. It is the wrong choice if you have a sprawling scene with addons (`WaterMesh`, `Sky`, etc.) you haven't audited — start without slim, get the dev-capture flow working, then enable slim once you know which materials need markers.

If an audited feature still needs live compilation, configure
`createSlimSceneSupport()` with the lazy `virtual:tsl-precompile/full-three`
fallback. That compiler lives in a separate chunk and is loaded only when the
application explicitly requests it; once loaded, that fallback path is not
compiler-free.

## Common questions

**Can I use Webpack/Rollup/esbuild instead of Vite?** Not today. The dev-capture endpoint is mounted as Vite middleware. Production replay (the runtime side) is bundler-agnostic, but the capture flow assumes Vite.

**What about Vue, Astro, or Svelte?** Plain JS/TS modules and Vue/Astro script
subrequests are transformed. Svelte compiles its raw `.svelte` ID after this
plugin's strict pre-transform, so put marked material construction in an
imported `.js`/`.ts` module for now; raw Svelte component scripts are not
rewritten directly.

**What if my project doesn't use TSL — just classic three.js materials?** The plugin is a no-op on non-`NodeMaterial` materials. You only get value if your scene uses TSL.

**Can I use classic `WebGLRenderer`?** No. The supported WebGL 2 path is
`WebGPURenderer` selecting its WebGL backend, explicitly with `{ forceWebGL:
true }` or through its automatic fallback. Migrating a classic
`WebGLRenderer` application to that renderer/TSL stack is a separate project.

**Do I have to commit `./artifacts/` to git?** Strongly recommended. They are build inputs and your CI needs them. If you treat them as build outputs and regenerate per-build, you lose the staleness gate and your prod and dev can diverge.

**What about addons (Water, Sky, GLTFLoader)?** GLTFLoader and friends are fine — they load assets, they don't author TSL graphs at runtime. Addons that build TSL graphs in their constructors (e.g., `WaterMesh`) work in non-slim mode but may need manual marker wiring in slim mode. Start without slim.

**How do I know if my scene works before committing to this?** Run `pnpm vite` and look at the dev console. You should see `[tsl-precompile/aux] precompileAuxiliary: ...` and per-marker capture logs. If you see capture errors for specific markers, those are the materials that need TSL graph adjustments — file an issue with the kind name.

**Where do I report issues?** [github.com/Makio64/vite-plugin-tsl-precompile/issues](https://github.com/Makio64/vite-plugin-tsl-precompile/issues). For "does my use case work" questions, paste your `vite.config.js` and one marked material — that's usually enough.

## Where to look next

- [README.md](README.md) — full plugin options reference
- [MIGRATION.md](MIGRATION.md) — version-bump workflow in detail
- [packages/examples/getting-started](packages/examples/getting-started) — minimal compatibility-first repository example
- [packages/examples/pbr-shadows](packages/examples/pbr-shadows) — PBR + shadows, two markers in one scene
- [packages/examples/ocean](packages/examples/ocean) — flagship demo with addons + post-processing + Inspector
