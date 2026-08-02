# Migration guide

Two audiences:

1. **Users coming from `precompileScene()` or stock three.js** — see [Switching to `.precompile(name)`](#switching-to-precompilename) below.
2. **Existing users bumping `three`, `vite-plugin-tsl-precompile`, or `@tsl-precompile/runtime`** — see [Version-bump contract](#version-bump-contract). Captured artifacts are pinned to specific versions; bumping any of them invalidates the on-disk artifact and the build will fail loudly until you re-capture.

---

## Version-bump contract

### Why artifacts are versioned

A captured artifact (`artifacts/<name>.<hash>.json`) is a frozen snapshot of
three.js's native shader-emitter output for a specific material, render
topology, and `WebGPURenderer` backend. It contains:

- WGSL for the WebGPU backend or GLSL for the WebGL 2 backend, produced by
  Three's matching TSL node builder,
- a uniform plan describing how to push per-frame UBO bytes for every binding,
- a binding layout that the runtime hands directly to the GPU,
- captured value snapshots for nodes that aren't live-bound.

Three things determine whether that snapshot is binary-compatible with what's running at execution time:

| Versioned input | Why a bump invalidates artifacts |
|---|---|
| `three` | The TSL → WGSL/GLSL emitters, NodeBuilders, uniform group layout, and binding kinds all live in three.js. Even a patch bump can shift uniform offsets or rename a binding kind. |
| `vite-plugin-tsl-precompile` | Owns the artifact schema and the codegen for the per-frame updater. Schema changes (new field, renamed kind, different snapshot encoding) invalidate older artifacts. |
| `@tsl-precompile/runtime` | Owns `__applyPrecompiled`, the hydrator, and the writers. A runtime release that expects a new artifact field will reject older artifacts at app init. |
| Material schema | The user's TSL graph itself — every `*Node` slot, every uniform value, every texture uuid. Editing the source of a material invalidates its artifact. |

The runtime fails loudly on any mismatch. Silent fallback to "render whatever ships" would produce visual regressions long after the bump.

### Three layers that catch staleness

Implemented in code today:

1. **Separate source and runtime-content identities.** Capture records a
   `sourceGraphHash` for the normalized author graph, exact call-site owners
   with module revisions, and an artifact-content signature over the replay
   payload, shape, Three version, and toolchain version. The envelope stores
   that content signature as `__hash`. See
   [`packages/plugin/src/hash.js`](./packages/plugin/src/hash.js).
2. **Build-time mismatch error from the Babel transform.** [`packages/plugin/src/babel-transform.js`](./packages/plugin/src/babel-transform.js) reads each captured artifact's hash from the manifest and bakes it into the rewritten call site as a string literal. If the manifest lookup fails (no artifact for that name), the transform throws at build:
   ```
   [tsl-precompile] <file>:<line>:<col> .precompile("<name>"): no captured artifact found. Run dev mode once to capture it, then rebuild.
   ```
3. **Runtime assertion in `__applyPrecompiled`.** [`packages/runtime/src/apply-precompiled.js`](./packages/runtime/src/apply-precompiled.js) compares the hash baked into the bundle (`expectedHash`) against the hash on the loaded artifact module (`artifactModule.__hash`). Mismatch throws at app init, before any frame is rendered:
   ```
   [tsl-precompile] stale artifact detected for "<name>": expected hash <baked>, bundle shipped <loaded>. Rebuild — the on-disk artifact is out of sync with source.
   ```

Two additional gates back this up: the dev-capture server hot-re-extracts on
file save, and the source-aware verifier checks artifact/manifest integrity,
exact toolchain provenance, content signatures, and coverage for every
authored or generated marker:

```sh
pnpm exec tsl-precompile-verify --source src --source-root . artifacts
```

Use `--json` in CI. This verifier does not launch the app or prove route
or renderer-backend coverage; the production build and backend-matched
production-preview route sweeps remain separate gates.

### What to do on a `three` version bump

1. Bump `three` in your `package.json` and run `pnpm install`.
2. Run `pnpm dev` (or your equivalent dev server). The plugin auto-detects the new three version (see `detectThreeVersion()` in [`packages/plugin/src/index.js`](./packages/plugin/src/index.js)) and feeds it into the hash.
3. **Re-trigger every `.precompile()` call site.** In dev mode, the marker fires the in-browser extractor and writes a new `artifacts/<name>.<new-hash>.json`. Visit every page / route that constructs a precompiled material so each call site captures.
4. Delete the old `artifacts/<name>.<old-hash>.json` files (or run `pnpm verify` then `git status` to see which are now orphaned).
5. Commit the new artifacts.

There is **no auto-migration**. The artifact format is not backward-compatible
across three.js minor versions because three.js itself can change WGSL or GLSL
emission rules between releases. Bumping three requires a fresh capture; the
runtime will refuse to load a stale artifact rather than silently render the
wrong shader.

### What to do when renderer backend coverage changes

The supported renderer remains `WebGPURenderer`. Its WebGPU and WebGL 2
backends produce different native shader languages, so changing
`forceWebGL`, adding automatic fallback, or beginning to ship both backends is
a capture-matrix change:

1. If WebGPU is a production path, capture every shipped route/state/topology
   with the normal `WebGPURenderer` backend to produce WGSL variants.
2. Exercise the same matrix with `new WebGPURenderer({ forceWebGL: true })` to
   produce GLSL variants whenever WebGL 2 is a production path.
3. Run source-aware verification, build, and preview each backend before
   committing the updated artifact families.

Runtime selection fails closed when an artifact's shader language does not
match the active backend. A WGSL capture is not migrated into a GLSL capture,
and vice versa. Classic `WebGLRenderer` is outside this support surface; moving
an app from it to `WebGPURenderer` + TSL is a renderer migration, not an
artifact migration.

### What to do on a plugin or runtime version bump

Same procedure as a `three` bump:

1. Read the relevant CHANGELOG (the plugin's, the runtime's, or both) for the line **"artifact schema bumped"** — pre-1.0, treat every minor bump as schema-changing.
2. Re-run dev capture for every `.precompile()` site.
3. Commit the regenerated artifacts.

If the schema changed, the build or verifier fails before the artifact can be
trusted. Do not infer compatibility from a package bump looking small: keep the
plugin/runtime versions paired and recapture whenever the release notes or
source-aware gates require it.

### How to detect stale artifacts

| Where | Symptom |
|---|---|
| Build (Vite) | `[tsl-precompile] <file>:<line>:<col> .precompile("<name>"): no captured artifact found. Run dev mode once to capture it, then rebuild.` — emitted by the Babel transform when the manifest has no entry for the name + hash combo. |
| App init (browser) | `[tsl-precompile] stale artifact detected for "<name>": expected hash <X>, bundle shipped <Y>. Rebuild — the on-disk artifact is out of sync with source.` — thrown by `__applyPrecompiled` before the first frame. |
| CI | `pnpm verify` exits non-zero on missing `__hash`, invalid JSON, or unknown unsupported kinds. |
| Dev (HMR) | The dev-capture server re-extracts on save and writes a new `artifacts/<name>.<new-hash>.json`. Stale files become orphaned and visible in `git status`. |

The build-time error is the front line — bumping `three` and rebuilding without re-capturing will fail at `pnpm build` long before anything reaches a user.

### Pinning workflow

Captured artifacts are tied to one `three` revision. Pin to keep them valid:

1. **Lock `three` to an exact version** in your `package.json`:
   ```json
   {
     "dependencies": {
       "three": "0.185.1"
     }
   }
   ```
   The alpha plugin and runtime peer dependencies require exactly
   `three@0.185.1` (see [`packages/plugin/package.json`](./packages/plugin/package.json)
   and [`packages/runtime/package.json`](./packages/runtime/package.json)).
   `0.185.x` changes private renderer/rewrite surfaces and remains unsupported
   until the complete upgrade, re-vendoring, artifact re-capture, and visual
   verification workflow below has passed.
2. **Use a lockfile** (`pnpm-lock.yaml`, `package-lock.json`, `yarn.lock`) and commit it. Lockfile + exact version means the same `three` resolves on every machine.
3. **Add a CI gate** that runs `pnpm verify` and (optionally) `pnpm test:batch` so any drift between source and committed artifacts fails the build before it merges.
4. **Treat `three`, `vite-plugin-tsl-precompile`, and `@tsl-precompile/runtime` bumps as a coordinated change.** Bump together, recapture together, commit the new artifacts in the same PR. Never let the lockfile and the artifacts diverge.

If you need to upgrade `three` without re-capturing immediately (e.g. a security
patch on a feature branch), temporarily set `autoMark: false` to keep the
precompile path opt-in. Materials without an explicit `.precompile()` then use
the full TSL pipeline, so only the materials you've explicitly precompiled need
the recapture.

---

## Switching to `.precompile(name)`

For users coming from the `precompileScene()` helper in [Makio64/three.js@tsl-precompile](https://github.com/Makio64/three.js/tree/tsl-precompile), or from no precompile at all.

### From `precompileScene(renderer, scene, camera, …)`

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

Preserve the application's backend choice in this migration. Both the default
WebGPU path and `new WebGPURenderer({ forceWebGL: true })` are supported, but
they require their own WGSL or GLSL captures. Do not substitute classic
`WebGLRenderer` in either example.

**After:**

```js
import { WebGPURenderer, MeshStandardNodeMaterial } from 'three/webgpu';
import { setupPrecompile } from '@tsl-precompile/runtime/setup';

const renderer = new WebGPURenderer();
const setup = setupPrecompile( { renderer } );
await renderer.init();
await setup.ready;

const water = new MeshStandardNodeMaterial();
water.colorNode = mix(deepBlue, foamWhite, uv().y);
water.precompile('ocean-water');   // <-- author marker, replaces precompileScene

const mesh = new Mesh(geom, water);
scene.add(mesh);

renderer.render(scene, camera);
```

Add `vite-plugin-tsl-precompile` to your Vite config.

#### Key differences

- **No `await precompileScene(...)` call.** Each material opts in via `.precompile('name')`, called wherever the material is constructed — including inside loaders, async callbacks, conditional branches.
- **No scene curation.** Dynamic / lazy-loaded materials Just Work, as long as their construction site reaches a `.precompile()` call.
- **Explicit names are stable and authoritative.** Automatic direct-constructor
  detection is enabled by default, but an explicit name is the project-global
  artifact ID. Pick a stable literal; do not generate it.
- **Source- and content-gated.** Source ownership/revision, graph identity,
  artifact content, and exact toolchain provenance are checked before replay.
  See the [Version-bump contract](#version-bump-contract) above.

### From no precompile (stock three.js)

The plugin is opt-in per material. To start small, mark just one expensive material:

1. Install the prerelease packages with
   `pnpm add -D vite-plugin-tsl-precompile@alpha`, then
   `pnpm add @tsl-precompile/runtime@alpha three@0.185.1 --save-exact`.
2. Add the plugin to `vite.config.js` (see [README.md](./README.md)).
3. In your code, after creating the renderer:
   ```js
   import { setupPrecompile } from '@tsl-precompile/runtime/setup';
   const setup = setupPrecompile( { renderer } );
   await renderer.init();
   await setup.ready;
   ```
4. Pick your worst-offender material, add `.precompile('something-meaningful')` after the last node assignment.
5. Run `pnpm dev` once — watch the console for `[tsl-precompile] captured "something-meaningful"`. An `artifacts/something-meaningful.<hash>.json` file appears.
6. Run
   `pnpm exec tsl-precompile-verify --source src --source-root . artifacts`,
   then build and smoke-test the production preview on every captured
   `WebGPURenderer` backend.
7. **Commit `artifacts/`.** They are generated build inputs: PR diffs stay
   visible and CI can verify them without fabricating or hand-editing JSON.

Repeat for additional materials at your own pace. To keep this gradual opt-in
workflow, configure `autoMark: false`; otherwise the default automatic detection
also marks direct `new *NodeMaterial(...)` constructors.

---

## Common errors

### `[tsl-precompile] no captured artifact for "<name>"`

Build-time: the Babel transform found `.precompile('foo')` in source but no `artifacts/foo.<hash>.json`. Run `pnpm dev` once to capture. Most often happens after a `three` or plugin version bump — see [Version-bump contract](#version-bump-contract).

### `[tsl-precompile] stale artifact detected for "<name>"`

Build-time or runtime: the source's hash changed since the artifact was captured. Run `pnpm dev` once to recapture. Source: [`packages/runtime/src/apply-precompiled.js`](./packages/runtime/src/apply-precompiled.js).

### `TSLP_SHADER_LANGUAGE_MISMATCH`

Slim replay selected WGSL for an active WebGL backend or GLSL for an active
WebGPU backend. Capture the same material/topology using the active
`WebGPURenderer` backend, run source-aware verification, and rebuild. Do not
edit the artifact or substitute classic `WebGLRenderer`.

### `[tsl-precompile] .precompile("<name>") was called but no dev endpoint`

The runtime marker fired in production, meaning the Babel transform didn't run. Check that `vite-plugin-tsl-precompile` is in your `vite.config.js` and the plugin's `enforce: 'pre'` isn't being overridden.

### `[tsl-precompile] no dev renderer registered`

Use the recommended conditional setup entry and await its gate:

```js
import { setupPrecompile } from '@tsl-precompile/runtime/setup';
const setup = setupPrecompile( { renderer } );
await renderer.init();
await setup.ready;
```

If an advanced integration intentionally uses the lower-level runtime barrel,
it must call `setDevRenderer(renderer)` itself.

### `unsupported source.kind: <kind>`

The extractor saw a TSL primitive the AOT codegen doesn't yet handle. Open an issue with the offending kind — Phase 5's coverage matrix tracks these.
