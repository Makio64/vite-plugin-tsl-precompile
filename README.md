# vite-plugin-tsl-precompile

AOT precompilation for three.js `WebGPURenderer` TSL materials on its WebGPU
or WebGL 2 backend. In development, the plugin observes real renders and writes
versioned native WGSL/GLSL artifacts. In production,
Vite validates those artifacts; after every render path is covered, optional
slim mode can replay them without shipping Three's TSL compiler.

Direct `new *NodeMaterial(...)` constructors are detected automatically. Add
`.precompile('name')` only when you want a stable semantic artifact name or a
constructor cannot be detected.

**Site:** https://makio64.github.io/vite-plugin-tsl-precompile/

> **Status — experimental.** The alpha target is ordinary PBR app rendering
> (`Mesh{Standard,Physical}NodeMaterial` + texture maps + env/PMREM + direct
> lights + shadows + material uniforms). Compute, storage, MRT, and focused
> post-processing paths are implemented through captured artifacts and the
> explicit slim-support boundary. Arbitrary uncaptured live TSL remains outside
> the compiler-free contract.
> The checked generated evidence snapshot is at [packages/examples/batch/results/coverage-summary.md](packages/examples/batch/results/coverage-summary.md); validate its cohort manifest and repository-source fingerprint before treating it as current.

> **Pre-release availability:** `vite-plugin-tsl-precompile` and
> `@tsl-precompile/runtime` are not published to npm yet. The install tasks below
> are the first-alpha contract and stop on a registry 404. To evaluate the
> compatibility path now, run the repository example:
>
> ```sh
> git clone https://github.com/Makio64/vite-plugin-tsl-precompile.git
> cd vite-plugin-tsl-precompile
> pnpm install
> pnpm dev:getting-started
> ```

## Start here

| You want to… | Best starting point |
|---|---|
| Let AI handle the integration end to end | Copy the task in [AI-assisted setup](#ai-assisted-setup). It installs the official skill and carries explicit capture/build acceptance criteria. |
| Use AI but review the plan and diff | Use the site's [review-first task](https://makio64.github.io/vite-plugin-tsl-precompile/#review-agent-task). It requires a fit check, doctor report, file plan, and route/topology matrix before edits. |
| Work manually with `WebGPURenderer` + TSL | Follow [BYO.md](BYO.md), the concise existing-app guide. A minimal repository example lives at [packages/examples/getting-started](packages/examples/getting-started). |

Every path starts in compatibility mode: the stock Three compiler remains
available while you capture and verify the app. Treat `slim: 'source'` as a
separate optimization only after the same real routes pass in a production
preview on every `WebGPURenderer` backend the application can select.

### What slim mode changes

Slim mode removes runtime TSL→shader compilation, replaces node-graph traversal
with generated UBO updates, and fails closed on missing or stale captures. The
default compatibility mode runs the same artifact and freshness gates but keeps
the live NodeMaterial/compiler authoritative while coverage is being audited.

The checked Three r185 gzip-9 regression baselines are **176,256 bytes** for a
minimal guarded source build, **185,398 bytes** for the advanced source fixture,
**261,382 bytes** for the single-file prebuilt runtime, and **202,842 bytes** for
a generated-helper consumer. Their enforced caps are 184,000, 194,000, 268,000,
and 209,000 bytes respectively. These are repository fixtures, not universal
transfer sizes or a stock-Three comparison. `pnpm analyze:slim` reports the
current exact measurements and provenance; measure your own production chunks.

## Requirements

| | Minimum |
|---|---|
| **Renderer** | `WebGPURenderer` with its WebGPU backend or WebGL 2 backend (`forceWebGL: true` and automatic fallback are supported) |
| **Browser** | WebGPU or WebGL 2, matching the backend captured for each render path |
| **three.js** | Exactly `0.185.1` for this alpha (use `"three": "0.185.1"`, not a range). Artifacts are versioned against the exact native-shader emitter package; see [MIGRATION.md](MIGRATION.md) for the deliberate upgrade and re-capture workflow. |
| **Vite** | `>= 6.4.3 < 9` |
| **Node** | `>= 20.19` (build tooling only; not a runtime requirement) |
| **TypeScript** | `>= 5.6` when consuming the declarations (CI runs exact `5.6.3` and `5.9.3` packed consumers) |

Classic `WebGLRenderer` is not supported. WebGL 2 support means the WebGL
backend selected by `WebGPURenderer`, so the application continues to use the
`three/webgpu` renderer and TSL material stack. Captures are backend-specific:
WGSL is replayed on WebGPU and GLSL is replayed on WebGL 2. If production can
choose either backend, capture and preview the full route/topology matrix on
both; a shader captured for one backend is not a fallback for the other.

> **Adopting this manually?** Start at [BYO.md](BYO.md) for install, first
> capture, the day-2 workflow, and common pitfalls.

## AI-assisted setup

Open the application repository in your coding agent and paste this whole task.
It uses the packaged [`integrate-tsl-precompile`](.agents/skills/integrate-tsl-precompile)
skill when available and gives the agent a hosted fallback when a newly installed
skill is not discoverable in the current session.

```text
Integrate vite-plugin-tsl-precompile into this Vite + three.js WebGPURenderer TSL app.

Before installing packages or editing files, inspect the lockfile/package manager,
Vite config, renderer bootstrap and backend options, TSL NodeMaterials, routes,
current three version, and matching @types/three. If this is not a Vite +
WebGPURenderer + TSL app, if it uses classic WebGLRenderer, or if exact
three@0.185.1 requires an unapproved migration, stop and report without mutating.

After the fit check passes, use this project's package manager (pnpm shown):
  pnpm add -D vite-plugin-tsl-precompile@alpha
  pnpm add @tsl-precompile/runtime@alpha three@0.185.1 --save-exact
  pnpm add -D @types/three@0.185.1 --save-exact  # TypeScript only
  pnpm exec tsl-precompile-install-skill --json
  pnpm exec tsl-precompile-doctor --json --source src

Replace or repeat --source for the source roots discovered in the fit check.

If npm returns 404, stop: the first alpha is not published yet. Do not substitute an
unrelated package. If the newly installed skill is unavailable in this session, read
the hosted raw skill and llms.txt below and continue from those instructions.

Use $integrate-tsl-precompile end to end. Start in compatibility mode. Derive the
complete route/state/render-topology matrix and ask me about authenticated or
otherwise inaccessible states. Capture every real renderer-backend path, verify and commit a
non-zero artifacts/ set, build, and replay the same matrix in production preview.
Report anything unverified plus a separate slim-readiness verdict. Never hand-edit
artifacts or enable slim in this change.

Raw skill: https://makio64.github.io/vite-plugin-tsl-precompile/agent/integrate-tsl-precompile/SKILL.md
AI guide: https://makio64.github.io/vite-plugin-tsl-precompile/llms.txt
```

The default writes `.agents/skills/integrate-tsl-precompile` without
overwriting local changes. Use `--target codex`, `--target claude`, or a
project-relative skill root when an agent requires a different discovery
location. The hosted [AI-readable guide](https://makio64.github.io/vite-plugin-tsl-precompile/llms.txt)
and [raw skill](https://makio64.github.io/vite-plugin-tsl-precompile/agent/integrate-tsl-precompile/SKILL.md)
are available to agents that cannot run the installer.

The skill audits the app before editing, starts with the safe full-Three
compatibility profile, generates artifacts from real renders through either
`WebGPURenderer` backend, and automates the declared development route matrix
across both production backends. It
only enables compiler-free slim mode after the ordinary integration works. A
`ready-compatibility` doctor result does not prove route/topology coverage,
the production build, or backend-matched production previews.

## Quickstart

```sh
pnpm add -D vite-plugin-tsl-precompile@alpha
pnpm add @tsl-precompile/runtime@alpha three@0.185.1 --save-exact
```

TypeScript projects must pin the matching Three declarations too:

```sh
pnpm add -D @types/three@0.185.1 --save-exact
```

Run the read-only adoption audit before and after wiring the plugin:

```sh
pnpm exec tsl-precompile-doctor --source src
pnpm exec tsl-precompile-doctor --json --source src
pnpm exec tsl-precompile-doctor --json --compact --source src
```

It checks the installed version pair, exact Three pin, Vite wiring, renderer
setup, discoverable markers, and source-aware artifact coverage. A passing
compatibility-mode audit still emits the ordered route-coverage,
topology-coverage, production-build, and backend-matched production-preview gates.
`--compact` keeps all checks/actions/gates but samples bulky source, marker,
and diagnostic evidence with explicit omission counts for large agent
contexts.

For coding agents, every `--json` skill-installer, doctor, recapture, and
verifier response keeps stdout to one schema-versioned object with `ok`,
`status`, `command`, and `nextActions`. Parse that object even when the process
exits nonzero. Passing checks omit `remediation` and `nextAction`; warn and fail
checks carry them. Execute a
`kind: "command"` action by spawning its `argv` array directly in its absolute
`cwd`; do not pass the prose fields through a shell. A `kind: "manual"` action
has `argv: null` because it needs inspection or user input. When it provides
`argvByPackageManager`, resolve the `packageManager` input and select exactly
one matching argv; never execute every alternative or assume npm. Generated
artifact JSON remains capture output—never fabricate or hand-edit it.

**`vite.config.js`:**

```js
import { defineConfig } from 'vite';
import tslPrecompile from 'vite-plugin-tsl-precompile';

export default defineConfig( {
	// Start in full-Three compatibility mode. Enable `slim: 'source'` only
	// after capture, build, and production preview prove route coverage.
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
import { WebGPURenderer, MeshStandardNodeMaterial, Scene, PerspectiveCamera, Mesh, SphereGeometry } from 'three/webgpu';
import { color, mix, uv } from 'three/tsl';
import { setupPrecompile } from '@tsl-precompile/runtime/setup';

const renderer = new WebGPURenderer();
const setup = setupPrecompile( { renderer } );
await renderer.init();
await setup.ready;          // ← registers this renderer with the marker

const material = new MeshStandardNodeMaterial();
material.colorNode = mix( color( '#224' ), color( '#88c' ), uv().y );
material.precompile( 'my-material' );    // optional stable-name override

const scene = new Scene();
const camera = new PerspectiveCamera( 45, innerWidth / innerHeight, 0.1, 100 );
camera.position.z = 3;
scene.add( new Mesh( new SphereGeometry(), material ) );
renderer.setAnimationLoop( () => renderer.render( scene, camera ) );
```

Keep the application's intended renderer options. `new WebGPURenderer({
forceWebGL: true })` is the supported explicit WebGL 2 path; replacing this
renderer with classic `WebGLRenderer` is not. If automatic fallback is part of
the production contract, provide an app-owned way to exercise the same routes
once on WebGPU and once with `forceWebGL: true` during production preview. In
development, the recapture command can exercise both backends automatically.

Automatic and authored marker modules receive a development-only bootstrap
import, so materials constructed by eager static imports are safe even though
the importing app module calls `setupPrecompile()` later. The production
conditional export is empty and tree-shakes away.

Start the normal dev script, open every reachable route/state in a browser
capable of WebGPU, wait for capture settlement, and run the source-aware
verifier. `tsl-precompile-recapture --backends webgpu,webgl` repeats every
declared route automatically and requires exact post-init backend evidence for
both passes. The plugin writes
`./artifacts/my-material.<hash>.json`. Commit the artifact, then `vite build`
ships the validated artifact metadata and native shader source. With either slim mode it also
ships the generated UBO updater and the production renderer has no TSL
builder. Capture begins
only after the marker is observed in a real render,
so lights, shadows, fog, camera type, geometry attributes, instancing/skinning,
clipping, and MRT state select the correct shader variant.

Without `slim`, the build still validates and registers that artifact but
returns the original live NodeMaterial unchanged; stock Three compiles the live
graph at runtime. This mode is intended for compatibility while auditing
coverage. The choice is made by the plugin at build time and does not depend on
whether, when, or where the application calls `setupPrecompile()`.

A full runnable copy lives in
[packages/examples/getting-started](packages/examples/getting-started).

For MRT / `RenderPipeline` projects, enable aux capture and pass the live
PassNode after you build the pass graph:

```js
const setup = setupPrecompile( { renderer, scene, camera, aux: true } );
await setup.ready;

const scenePass = pass( scene, camera ).setMRT( mrt( { output, normal } ) );
await setup.captureAux( { passNode: scenePass, renderPipeline } );
```

Browser tests and one-shot apps can wait on capture without guessing a sleep:

```js
const beforeCapture = setup.captureStatus();
renderer.render( scene, camera );
await setup.waitForCaptureSettled( { since: beforeCapture } );
window.__APP_CAPTURE_READY__ = true;
```

The promise resolves only after a new accepted capture outcome is observed,
the shared pending counter returns to zero, and a short settle window passes.
It rejects on capture failure or timeout. The conditional production setup
entry returns the same methods as inert, already-settled no-ops.

Verify both artifact integrity and expected source-marker coverage before the
production build:

```sh
pnpm exec tsl-precompile-verify --source src --source-root . artifacts
pnpm exec tsl-precompile-verify --json --source src --source-root . artifacts
```

The first form is human-readable. The second emits a stable JSON result for CI
and exits nonzero for corrupt artifacts or any authored/automatic marker that
has no manifest entry. Repeat `--source` for additional application source
roots; use `--no-auto-mark` or `--auto-mark-prefix` when they match the plugin
configuration. Current captures also carry a canonical transitive
project-local static-import proof. The source-aware verifier re-reads that
closure, so changing a material/TSL helper imported by an otherwise unchanged
marker module is reported as stale. Package dependencies, virtual generated
modules, and linked sources outside `--source-root` remain on their separate
package/toolchain provenance gates.

For route automation, keep Vite running separately and request structured
output:

```sh
pnpm exec tsl-precompile-recapture --json \
  --url http://localhost:5173 --paths /,/viewer,/effects \
  --backends webgpu,webgl \
  --source src --source-root . --artifacts artifacts
```

The JSON result reports the requested and observed WebGPURenderer backend,
backend-control evidence, WebGPU availability, per-route capture starts,
accepted POSTs, failures, elapsed time, and cold-reload recovery. The WebGL
pass uses Three's own fallback without masking `navigator.gpu`; a WebGPU pass
that silently falls back fails instead of producing a false success. A successful
recapture returns a source-aware verifier action derived from these exact
source/root/artifact inputs; route activity alone does not prove complete
marker coverage. Repeat `--source` and pass the plugin's `--no-auto-mark` or
`--auto-mark-prefix` setting when applicable.

## How it works

1. **Dev capture.** By default, the plugin injects a generated
   `.precompile('auto-…')` marker after each direct `new *NodeMaterial(...)`
   constructor. An explicit `.precompile('name')` call takes precedence. On the
   material's first real `renderer.render(scene, camera)`, the runtime records
   the owning object and render context, then borrows that renderer for an
   isolated extraction pass and POSTs the resulting WGSL/GLSL + uniform plan to the
   plugin's dev-only capture endpoint.
   The endpoint accepts only same-origin `application/json` requests whose
   `Origin` and `Host` agree, and bounds the body at 32 MiB before the plugin
   writes `./artifacts/<name>.<hash>.json`. Legacy unsigned user-material
   payloads remain a local migration input only; they are not a remotely
   trusted artifact-ingestion format.
2. **Build rewrite.** A Babel pass replaces `material.precompile('name')` with
   `__applyPrecompiled(material, virtualArtifactModule, expectedHash)` and
   hoists `import * as __tsl_art_<name> from 'virtual:tsl-precompile/<name>'`.
   The plugin's `load()` hook resolves that virtual module to the captured
   artifact JSON. The injected apply entry and emitted module are mode-specific:
   default full mode emits passive metadata (no replay updater/light-helper
   closure), hash-gates/registers it, and retains the live material; both slim
   modes emit the generated updater and adopt replay behavior. Standalone
   precompiled compute modules keep their updater in every mode.
3. **Slim runtime (optional).** Production builds can use the guarded
   application-tree-shaken entry (`slim: 'source'`, recommended for new Vite
   apps) or the checked single-file prebuilt runtime (`slim: true`). Both strip
   the node builder; dev/serve deliberately
   keeps full Three so capture can generate native shader source. Only paths represented by
   precompiled artifacts or explicit replay/fallback adapters work in slim.

Artifact families keep WebGPU/WGSL and WebGL/GLSL variants separate. Runtime
selection rejects a native-shader/backend mismatch instead of passing WGSL to
WebGL or GLSL to WebGPU.

## Adoption modes

### 1. Automatic detection (default)

Zero configuration is required:

```js
tslPrecompile();
```

The plugin chains `.precompile('auto-<n>')` onto every `new *NodeMaterial(...)`
it encounters in application source.

Caveat: artifact names are positional. Reordering materials in source
reshuffles names, which invalidates the on-disk artifacts.

### 2. Explicit `.precompile()` names

Add a marker when you want a stable semantic name:

```js
material.precompile( 'water' );
```

Explicit markers take precedence over automatic detection. Names are
project-global artifact IDs: keep them unique and use only letters, digits,
`.`, `_`, and `-` (no path segments or `..`). Set `autoMark: false` only when
you want to require explicit markers everywhere.

### 3. `slim` — ship a node-builder-stripped three.js

```js
tslPrecompile( { slim: 'source' } );
```

Production has two compiler-free delivery modes:

```js
tslPrecompile( { slim: 'source' } );   // recommended, app-tree-shaken source
tslPrecompile( { slim: true } );       // checked single-file prebuilt runtime
```

Both alias `three/tsl` to compiler-free replay stubs; known captured graph
construction calls become inert, while unsupported live paths fail loudly.
`slim: 'source'` aliases
`three/webgpu` to a guarded source entry so the application bundler can discard
unused Three constructors and runtime exports. The checked r185 fixture
baselines are 176,256 bytes gzip-9 for minimal source versus 261,600 bytes for
the prebuilt file: 85,231 bytes, or 35.3%, smaller. `slim: true` aliases
`three/webgpu` to that checked `@tsl-precompile/runtime/slim` file when a stable
single-file renderer is preferable to application-specific tree shaking.

The source entry is build-only: importing it without a matching plugin fails,
plugin/runtime policy revisions are checked, and the final bundle is rejected
if a Three node compiler, stock replay-owned adapter, retained Three Node/TSL
module, or split bare-Three identity survives. `vite dev` keeps the full Three
entries in either mode so `.precompile()` and auxiliary capture still have a
node builder.

Leaving `slim` at its default `false` is the full-Three compatibility mode.
Marked artifacts remain freshness-checked and available to tooling, but the
renderer receives the original live NodeMaterial and uses Three's ordinary
TSL compiler. Enable a slim mode only when the captured/replay coverage needed
by the application is ready.

When either slim mode is configured, the development `setupPrecompile()`
hook also observes successful real renders and captures each renderer-output
topology required for tone mapping and color-space replay. Repeated renders
of the same topology are deduplicated; changes such as tone mapping, output
color space, array sampling, or multiview produce another exact artifact.
This narrow path does not trigger an automatic background / shadow / PMREM /
post-processing sweep; those feature-specific captures stay explicit through
`captureAux()`.

The published slim bundle is currently built against exactly three `0.185.1`.
A slim build fails early when the consumer resolves another patch instead of
combining incompatible renderer internals. Source mode uses the consumer's
installed Three source, but capture and production build must still resolve
the same exact patch; artifacts from another patch are rejected.

**What slim mode actually changes:**
- ✅ Eliminates the TSL→WGSL/GLSL compiler from production runtime (no JIT shader
  compile at first frame, no node-graph traversal each draw).
- ✅ Guarded builds retain zero stock compiler, stock replay-adapter, and Three
  Node/TSL modules. Explicit hybrid/full-renderer fallback remains a separate
  lazy chunk and loads a compiler only when the application asks for it.
- ✅ Uncovered paths fail loudly in pure slim; applications that explicitly
  call `ensureFallback()` can instead delegate them to the lazy full renderer.
- ✅ Lets the application bundler remove unused renderer/runtime exports in
  source mode; the guarded minimal and advanced regression baselines are
  176,256 and 185,490 bytes gzip-9, versus 261,600 bytes for the checked
  prebuilt runtime. `pnpm analyze:slim` reports the current exact values.

**`optimizeDeps` is required** in `vite.config.js` for slim:

```js
optimizeDeps: {
	include: [ 'three', 'three/webgpu', 'three/tsl' ],
},
```

For larger apps that need compiler-free PMREM/VSM, non-precompiled helper
meshes, Inspector overlays, compute outputs, or post-processing passes, use
the public slim-support entry instead of reaching into runtime internals:

```js
import { createSlimSceneSupport } from '@tsl-precompile/runtime/slim-support';

const support = createSlimSceneSupport( {
	renderer,
	fullRendererFallback: false,
} );

support.indexScene( scene );
await support.generatePMREMAsync( environmentTexture );
await support.populateShadowMaps( scene, camera );
```

PMREM source conversion/blur/GGX and Directional/Spot VSM depth/filter passes
use captured `internal-pass@1` artifacts on the slim renderer. Add
`loadThreeFullModule` and call `ensureFallback()` only for uncaptured dynamic
work.

Load the virtual full-three entry dynamically for fallback code so it stays
in a separate lazy chunk. A direct production
import from `three/webgpu` intentionally resolves to slim and is rejected by
the fallback helper.

For offscreen override-material renders such as contact shadows or depth
prepasses, call `support.renderOffscreenOverrideWithFallback( scene, camera )`
after the fallback renderer has been initialized and while your slim renderer
has a render target bound. It renders that target with the shared full renderer
and hands the produced GPU textures back to slim.

Automatic detection pairs naturally with slim mode when you want to remove the
live TSL compiler from production without manually marking every material.

## Plugin options

| Option | Default | Description |
|---|---|---|
| `artifactsDir` | `'./artifacts'` | Where captured artifacts live on disk. |
| `fail` | `'error'` | In full-Three compatibility mode, `'warn'` keeps the live material when a named artifact is missing and continues rewriting captured siblings. Slim modes reject warning recovery. |
| `autoMark` | `true` | Chain `.precompile('auto-<n>')` onto every `new *NodeMaterial(...)` automatically. Set to `false` to require explicit markers. |
| `autoMarkPrefix` | `'auto'` | Prefix used by `autoMark` to name artifacts. |
| `slim` | `false` | `false` keeps the original live NodeMaterial and full Three compiler while validating/registering artifacts; `'source'` is the recommended guarded, tree-shaken compiler-free entry; `true` uses the checked single-file prebuilt runtime. Dev always keeps full Three for capture. |
| `minifyWgsl` | `true` | Compact WGSL only in emitted virtual modules; captured JSON stays readable. |
| `dedupeWgsl` | `true` | Hoist repeated native shader strings into the legacy-named `virtual:tsl-precompile/__wgsl` pool for tree-shakeable reuse; GLSL bytes are preserved. |
| `threeVersion` | auto-detect | Override the exact three.js package version used in rewrite hashes. It must match the installed package (rarely needed). |

## Troubleshooting

- **`[tsl-precompile] no artifact for "X". Run dev mode once to capture it.`**
  You ran `vite build` before `vite` ever captured the artifact. Run `vite`
  once, commit `./artifacts/X.<hash>.json`, then build.
- **`[tsl-precompile] artifact "X" has N unknown kind(s) ...`**
  The captured material uses a TSL pattern the codegen does not handle yet.
  Either remove the marker for now, or file an issue with the kind name —
  see [packages/examples/batch/results/coverage-summary.md](packages/examples/batch/results/coverage-summary.md)
  for what's currently supported.
- **`TSLP_SHADER_LANGUAGE_MISMATCH` / captured WGSL or GLSL targets the other
  backend.** The active `WebGPURenderer` selected a backend for which this
  material/topology was not captured. Repeat development capture with the
  missing explicit `--backends` value, verify the artifact family, and
  rebuild. Do not switch to classic `WebGLRenderer` or edit shader JSON.
- **`... not-yet-animated kind(s) ... frozen-snapshot fallback`**
  This warning is specific to compiler-free slim replay. Its generated updater
  is shipping a snapshot fallback for that kind — the captured frame is
  correct, but those values will not animate over time. Keep `slim: false`
  (where the live NodeMaterial remains authoritative) until the path is
  supported, or supply an explicit slim-support fallback. Full-Three
  compatibility builds intentionally do not emit this replay-only warning.
  Current kind coverage is tracked in
  [packages/examples/batch/results/coverage-summary.md](packages/examples/batch/results/coverage-summary.md).
- **`[tsl-precompile/slim] X is not available in the slim bundle`**
  You hit a code path that wasn't precompiled in a slim production mode. Add
  an explicit `.precompile()` marker if automatic detection cannot see its
  constructor (or re-enable `autoMark`), re-run dev to capture, then rebuild.
- **`slim build refused: ... built against three 0.185.1`**
  The installed three.js patch does not match this release's checked-in slim
  renderer. Pin three to `0.185.1`, or disable `slim` until a matching runtime
  slim bundle is published.
- **`slim source policy mismatch`**
  The plugin and runtime packages came from incompatible releases. Install
  matching `vite-plugin-tsl-precompile` and `@tsl-precompile/runtime` versions.
- **Post-processing renders black or samples stale textures in `slim` mode.**
  Run `precompileAuxiliary(renderer, scene, camera, { three: THREE,
  postProcessing })` once in dev after creating the `RenderPipeline` /
  `PostProcessing` graph. The build rewrite now rebinds live pass/effect
  render-target textures by name for postfx artifacts.
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

Alpha-target features are green for ordinary PBR rendering: standard and
physical node materials, material texture maps, env maps / PMREM, direct
lights, shadows, material uniforms, plus stable artifact invalidation
across dev capture / build rewrite / runtime hash check.

Compute/storage and post-processing replay are implemented through captured
artifacts and explicit hybrid support. The canonical catalogue has one explicit
pixel diagnostic: `webgpu_storage_buffer.html`, whose r185 shader has volatile
compute behavior. Every other canonical row retains the pixel gate. A diagnostic
pixel comparison does not relax artifact, browser/runtime, brightness, or
semantic evidence checks, and an arbitrary uncaptured live TSL path is not
accepted by pure slim.

The generated evidence snapshot is at
[packages/examples/batch/results/coverage-summary.md](packages/examples/batch/results/coverage-summary.md).
Treat it as current only when its run manifest and repository-source
fingerprint validate. Any fingerprinted harness/source change requires a fresh
exact campaign before publishing new coverage claims.

Semantic evidence uses `tslp-e2e-semantic-evidence-gate@3`. A row is eligible
to pass only when stock, capture, and replay are all observed and explicitly
complete their deterministic freeze boundary; unexpected browser/runtime and
GPU errors and `[tslp*]` or `[tsl-precompile*]` warnings are blocking. Every phase must positively
prove GPU hook/device observation and a submitted-work fence. A complete
versioned operation registry binds required material-compute, direct-material,
render-pass, and Bloom outcomes. Missing or unknown outcomes and requiredness
downgrades fail closed; only auxiliary-capture outcomes may be optional. FSR
and Bloom recovery is accepted only when each ordered selector-failure record
is bound to the exact operation/effect and paired with its own later render and
presentation.

Canonical schema-2 artifact descriptors are also checked against their stored
byte length and SHA-256 before bounded decoding, with path containment,
compression metadata, and exact uncompressed size validated. Because these v2
harness changes alter the source fingerprint, no final 254-route result is
claimed here until a fresh exact campaign completes and its manifest-bound
report, artifacts, and screenshots validate together.

## Tested configurations

The matrix below is what CI exercises on every PR, except where a row explicitly
calls out a scheduled probe. Configurations outside it are best-effort — they
may work but aren't guarded against regression.

| Layer | Tested | Notes |
|---|---|---|
| **Operating systems** | Ubuntu | Unit, visual, example-production, and packed-consumer gates run on Linux. macOS and Windows are not currently gated. |
| **Browsers** | Chromium (Playwright, SwiftShader Vulkan) | Firefox WebGPU is still flag-gated; Safari is untested in CI. |
| **Node** | 20.19.0, 22.12.0, and 24.18.0 | The complete suite runs on 24.18; default package checks exercise the declared 20.19 minimum, and packed-consumer lanes cover all three versions. |
| **Vite** | 6.4.3, 7.3.6, and 8.0.16 | Exact packed-consumer smokes exercise every major in the declared `>= 6.4.3 < 9` range. |
| **three.js** | `0.185.1` (locked) + nightly run against `latest` ([three-compat.yml](.github/workflows/three-compat.yml)) | Artifacts are pinned to a three.js patch — see [MIGRATION.md](MIGRATION.md). |
| **TypeScript** | 5.6.3 and 5.9.3 | Packed public declarations are checked in strict NodeNext mode with library checking enabled at the documented floor and current pinned compiler. |
| **Publish path** | `npm install` of `pnpm pack` tarballs into a clean temp project ([fresh-project-smoke](packages/examples/fresh-project-smoke)) | Verifies that `exports`, `files`, `peerDependencies`, and `.d.ts` resolve outside the monorepo. |
| **Bundlers** | Vite only | Plugin is Vite-specific; Rollup/esbuild/webpack are not supported. |

**Visual exceptions.**
[coverage-config.json](packages/examples/batch/coverage-config.json) currently
contains exactly one `pixelGate.disabled` entry:
`webgpu_storage_buffer.html` in `volatileCompute`. Its image comparison is
diagnostic because the upstream r185 compute shader is not deterministic under
the configured execution model. All other canonical rows are pixel-gated. Any
future exception must carry a reviewable per-example justification there.
Artifact coverage, browser/runtime errors, minimum brightness, deterministic
freeze completion, and the semantic evidence gate remain mandatory even when a
pixel comparison is disabled.

## Examples in this repo

- [`packages/examples/getting-started`](packages/examples/getting-started) — minimal compatibility-first repository example
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
pnpm dev:getting-started  # minimal compatibility-first repository example
pnpm dev:bloom            # post-processing bloom demo
pnpm dev:background       # background / PMREM demo
pnpm dev:compute          # compute-shader demo
pnpm dev:shadow-debug     # minimal shadow repro pages
pnpm dev:site             # docs site
pnpm test                 # fast default checks (heavy generation/rewrite suites excluded)
pnpm test:generation      # extractor and artifact-generation tests only
pnpm test:full            # complete non-example package suites
pnpm release:check        # clean-commit release gate (packages, examples, packed consumers)
pnpm test:coverage        # coverage-matrix fixtures
pnpm test:e2e -- --filter=webgpu_clearcoat
                          # focused capture/replay against one three.js example
pnpm verify               # artifact/manifest integrity check
```

Contributing? Start with [AGENTS.md](AGENTS.md) (the AI/human contributor
guide), then [ARCHITECTURE.md](ARCHITECTURE.md).

## License

MIT
