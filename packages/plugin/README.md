# vite-plugin-tsl-precompile

Vite plugin that automatically detects direct three.js `new *NodeMaterial(...)`
constructors and captures them as static native-shader artifacts: WGSL for the
`WebGPURenderer` WebGPU backend and GLSL for its WebGL 2 backend. Explicit
`.precompile('name')` calls remain available for stable semantic names. Slim
builds replay those artifacts with generated per-frame UBO updaters; full-Three
builds retain the live NodeMaterial/compiler while validating and registering
the capture.

Pairs with [`@tsl-precompile/runtime`](https://www.npmjs.com/package/@tsl-precompile/runtime).

## Status

Experimental.

## Install

```sh
pnpm add -D vite-plugin-tsl-precompile@alpha
pnpm add @tsl-precompile/runtime@alpha three@0.185.1 --save-exact
```

TypeScript projects must also install the exact matching declarations:

```sh
pnpm add -D @types/three@0.185.1 --save-exact
```

Required peer deps: `three 0.185.1`, `vite >= 6.4.3 < 9`, and the matching
`@tsl-precompile/runtime`. `@types/three 0.185.1` is an optional peer for
JavaScript consumers and required when TypeScript checks the Three surface.
The alpha intentionally pins Three exactly; `0.185.x` requires the documented
re-vendoring and artifact recapture workflow before it can be supported.

The renderer must remain `WebGPURenderer` from `three/webgpu`. Its default
WebGPU backend, `{ forceWebGL: true }` WebGL 2 backend, and automatic WebGL 2
fallback are supported. Classic `WebGLRenderer` is not. Capture every
route/topology on each backend production can select; native shader variants
are backend-specific and a language/backend mismatch fails closed.

For agent-led adoption, install the packaged project skill first and use the
prompt printed by the command:

```sh
pnpm exec tsl-precompile-install-skill --json
```

Audit an existing app without changing it:

```sh
pnpm exec tsl-precompile-doctor --source src
pnpm exec tsl-precompile-doctor --json --source src
pnpm exec tsl-precompile-doctor --json --compact --source src
```

The doctor checks package versions, Vite/setup wiring, discoverable markers,
and source-aware artifact coverage. It deliberately reports the production
build, route/topology/backend coverage, and production previews as separate
remaining gates and emits their dependency-aware `nextActions` when setup is
ready. It never proves that slim mode is safe.

For large repositories, `--compact` preserves every check, next action, proof,
and remaining gate while sampling bulky evidence lists and reporting how many
items were omitted.

The skill-installer, doctor, recapture, and verifier `--json` modes reserve
stdout for one schema-versioned object with `ok`, `status`, `command`, and
`nextActions`. Agents should parse it even after a nonzero exit and spawn each
command action's `argv` directly in its absolute `cwd`. Passing checks omit
`remediation` and `nextAction`; warn and fail checks carry them. Prose is
explanatory, not a shell command; manual actions intentionally have `argv: null`.
When a manual action provides `argvByPackageManager`, resolve its
`packageManager` input and select exactly one matching argv; never execute
every alternative or assume npm.

After development capture, validate generated inputs deterministically:

```sh
pnpm exec tsl-precompile-verify --source src --source-root . artifacts
pnpm exec tsl-precompile-verify --json --source src --source-root . artifacts
```

The source-aware form compares every authored marker and exact generated
auto-marker name with the manifest, reports missing coverage as
`source:line:column`, and exits nonzero. `--json` is the stable CI output;
repeat `--source` for multiple source roots.

## Use

```js
// vite.config.js
import { defineConfig } from 'vite';
import tslPrecompile from 'vite-plugin-tsl-precompile';

export default defineConfig( {
	// Start in full-Three compatibility mode. Enable `slim: 'source'` only
	// after capture, build, and production preview prove route coverage.
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
import { WebGPURenderer, MeshStandardNodeMaterial } from 'three/webgpu';
import { color, mix, uv } from 'three/tsl';
import { setupPrecompile } from '@tsl-precompile/runtime/setup';

const renderer = new WebGPURenderer();
const setup = setupPrecompile( { renderer } );
await renderer.init();
await setup.ready;

const water = new MeshStandardNodeMaterial();
water.colorNode = mix( color( '#002' ), color( '#4af' ), uv().y );
water.precompile( 'ocean-water' );      // optional stable-name override
```

Keep the application's renderer options. Use `new WebGPURenderer({ forceWebGL:
true })` when WebGL 2 is the intended backend; do not replace it with classic
`WebGLRenderer`. If production permits WebGPU plus automatic WebGL 2 fallback,
run development recapture with `--backends webgpu,webgl`, then use the
application's backend switch to repeat production preview for the same matrix.
The artifact family retains both WGSL and GLSL variants.

In dev, the default automatic marker (or the explicit stable-name override
above) runs the real extractor on the live material and writes an artifact. In
every production build the plugin rewrites that marker and enforces the artifact
hash/source freshness gates. With the default `slim: false`, the original live
NodeMaterial and stock Three compiler remain authoritative; the artifact is
registered as passive diagnostics metadata. `slim: 'source'` is the recommended
compiler-free mode for new Vite apps whose production paths are captured: it
adopts the baked native WGSL/GLSL and generated updater, and exposes the guarded source
surface to the application bundler for finer tree shaking. `slim: true` selects
the same replay surface from the checked single-file prebuilt runtime. Source
mode is production-only, checks the plugin/runtime policy revision, and fails
the build if compiler, stock replay, retained Node/TSL, or split Three-identity
modules remain reachable.

In either slim mode, `setupPrecompile()` automatically captures the exact
renderer-output transform after successful real renders in dev. It deduplicates
each tone-mapping/color-space/sampled-texture/multiview topology and captures a
new one when that topology changes. Other auxiliary features remain opt-in.

Projects that use MRT / `RenderPipeline` should also capture aux artifacts
after the pass graph is built. `setupPrecompile({ aux: true })` exposes
`captureAux(extraOpts)`, so a `pass(scene, camera).setMRT(...)` pipeline can
be captured with its real target topology.

For deterministic browser automation, take `setup.captureStatus()` before the
render that reveals the marked materials, then await
`setup.waitForCaptureSettled({ since: status })`. The promise waits for a new
accepted outcome and a zero pending count, and rejects on capture failure or
timeout; no fixed sleep is required.

### Development capture trust boundary

The capture endpoint mutates the local artifact directory, so it is intentionally
not a general HTTP ingestion API. It accepts only `application/json` POSTs with
a same-origin `Origin` whose protocol and host agree with the dev server's
`Host`; when `Sec-Fetch-Site` is present it must also be `same-origin`. Both
declared and streamed bodies are capped at 32 MiB, and aborted or rejected
uploads cannot publish a partial artifact.

Legacy unsigned user-material payloads remain accepted only to migrate captures
created before content-addressed signing. That compatibility exists inside the
same-origin local-development trust boundary; it does not waive the HTTP checks,
apply to signed auxiliary families, or make unsigned JSON suitable as remote or
release provenance. Current signed payloads still pass exact toolchain,
content-integrity, schema, and family validation before their durable manifest
update.

Capture settlement proves that the local artifact write finished; it is not by
itself visual-release evidence. The repository's exact batch campaign applies
`tslp-e2e-semantic-evidence-gate@3`: stock, capture, and replay must explicitly
complete their freeze boundary with no unexpected browser/runtime or GPU errors
and no `[tslp*]` or `[tsl-precompile*]` warnings. Each phase must positively prove GPU hook/device
observation and a submitted-work fence. Its complete operation registry makes
required replay operations fail closed, while only auxiliary-capture outcomes
may remain optional; recovery requires an ordered, exact failure record and a
distinct later render/presentation for every failure. The
campaign also verifies the exact stored artifact bytes and manifest bindings.
A fresh exact campaign is required after any fingerprinted harness or source
change; the v2 update does not inherit a final 254-route claim from older
evidence.

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
   npx --no-install tsl-precompile-recapture

   # Agent/CI form: the successful verifier action preserves this exact context
   npx --no-install tsl-precompile-recapture --json \
     --backends webgpu,webgl \
     --source src --source-root . --artifacts artifacts
   ```

### Recapture CLI Options

| Option | Default | Description |
|---|---|---|
| `-u, --url <url>` | `http://localhost:5173` | Base URL of the running dev server |
| `-p, --paths <paths>` | `/` | Comma-separated paths/routes to visit |
| `--backends <names>` | app-selected | Comma-separated `webgpu`, `webgl`, or both; each route is visited once per requested backend |
| `-t, --timeout <ms>` | `10000` | Max time to wait per page in milliseconds |
| `-s, --settle <ms>` | `1000` | Settle delay in milliseconds after all captures finish |
| `--allow-empty` | (disabled) | Accept a route where no capture activity is observed |
| `--no-headless` | (headless) | Run the browser in headful mode (visible window) |
| `--headless` | enabled | Explicitly run the browser headlessly |
| `--json` | (disabled) | Reserve stdout for one machine-readable result; progress goes to stderr |
| `-b, --browser <name>` | `chromium` | `chromium` is validated; `firefox` and `webkit` are experimental |
| `--source <path>` | `src` | Source file/directory for the verification follow-up; repeatable |
| `--source-root <path>` | `.` | Source root used for stable marker ownership in verification |
| `--artifacts <path>` | `artifacts` | Artifact directory passed to the successful verification action |
| `--no-auto-mark` | (disabled) | Match a plugin configuration with automatic markers disabled |
| `--auto-mark-prefix <prefix>` | `auto` | Match the plugin's automatic marker prefix |

Use `--backends webgpu,webgl` for one fail-closed backend sweep. The WebGPU pass
loads the application normally. For the WebGL pass, the isolated browser
context asks Three's own WebGPU-to-WebGL fallback to initialize its real WebGL
2 backend without masking `navigator.gpu` or changing application feature
branches. Each report row includes the requested backend, observed post-init
backend, and fallback-control evidence; opposite, mixed, unknown, or
uninitialized evidence fails the command. Omitting `--backends` preserves the
legacy app-selected single pass.

## Options

| Option | Default | Description |
|---|---|---|
| `artifactsDir` | `'./artifacts'` | Where captured artifacts live on disk. |
| `fail` | `'error'` | In full-Three compatibility mode, `'warn'` keeps the live material when a named artifact is missing and continues rewriting captured siblings. Slim modes reject warning recovery. |
| `autoMark` | `true` | Auto-chain `.precompile('auto-<n>')` onto every `new *NodeMaterial(...)`. Set to `false` to require explicit markers. |
| `autoMarkPrefix` | `'auto'` | Prefix used by `autoMark`. |
| `slim` | `false` | `false` preserves the live NodeMaterial and stock compiler while validating/registering artifacts; `'source'` is the recommended guarded, tree-shaken compiler-free entry for new Vite apps; `true` selects the checked single-file prebuilt runtime. Dev keeps full Three for capture. |
| `minifyWgsl` | `true` | Compact WGSL only in emitted virtual modules; captured artifact JSON stays readable. |
| `dedupeWgsl` | `true` | Hoist repeated native shader strings into the legacy-named `virtual:tsl-precompile/__wgsl` pool for tree-shakeable reuse; GLSL bytes are preserved. |
| `threeVersion` | auto-detect | Override the three.js version used in rewrite hashes. |

`minifyWgsl` compacts WGSL only. `dedupeWgsl` can pool repeated shader strings
in either language without changing GLSL bytes. Both affect production virtual
modules only; captured JSON stays diffable and useful for debugging.

Replay-only `uniform.live` snapshot diagnostics are emitted only for a slim
production build. The default full-Three compatibility build keeps the live
NodeMaterial/compiler authoritative, so a generated replay updater cannot
freeze those values there. See the public
[troubleshooting guide](https://github.com/Makio64/vite-plugin-tsl-precompile#troubleshooting)
for the slim fallback choices.

## More

Adoption modes (`autoMark`, `slim`), troubleshooting, and the live coverage
matrix:
**https://github.com/Makio64/vite-plugin-tsl-precompile**

## License

[MIT](https://github.com/Makio64/vite-plugin-tsl-precompile/blob/main/LICENSE)
