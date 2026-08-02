---
name: integrate-tsl-precompile
description: Install, configure, capture, debug, and validate vite-plugin-tsl-precompile in an existing Vite + three.js WebGPURenderer/TSL application using its WebGPU or WebGL 2 backend. Use when an agent is asked to add TSL ahead-of-time shader precompilation, migrate an app to .precompile() markers, fix missing or stale capture artifacts, automate route recapture, or safely evaluate compiler-free slim mode.
---

# Integrate TSL Precompile

Make the target application work end to end: install compatible packages, wire
development capture, confirm automatic detection of real TSL materials, add
explicit marker overrides only where needed, generate artifacts from actual
rendered scenes, and pass the production build. Start in compatibility mode;
treat compiler-free slim mode as a separate, stricter optimization.

## Guardrails

- Confirm the app uses Vite, `WebGPURenderer`, and TSL `NodeMaterial` classes.
  The renderer's WebGPU and WebGL 2 backends are supported, including
  `forceWebGL: true` and automatic fallback. Classic `WebGLRenderer` is not;
  do not silently migrate it or a non-Vite app.
- Inspect the lockfile, package scripts, Vite config shape, renderer bootstrap, material factories, routes, and existing artifacts before editing.
- Preserve the project's package manager and code style. Merge config arrays and objects; do not replace unrelated plugins, aliases, build options, or initialization logic.
- Use compatibility-first sequencing for new or broken integrations. If an app is already intentionally configured for slim mode and has current capture/build evidence, preserve that mode and validate it in place; do not downgrade it merely to replay this workflow.
- Keep `three` on the exact peer version required by the installed plugin and runtime. The current alpha requires `three@0.185.1`, Vite `>=6.4.3 <9`, and Node `>=24.0.0`; never use `^` or `~` for `three`. TypeScript projects must also install exact matching declarations, currently `@types/three@0.185.1`.
- Install `vite-plugin-tsl-precompile` and `@tsl-precompile/runtime` at matching releases when versions are explicitly selected.
- Never create or hand-edit capture JSON. Artifacts are generated build inputs and should be committed.
- Do not claim completion merely because the source builds. A real render on
  each production `WebGPURenderer` backend must generate its required native
  shader variant (WGSL for WebGPU, GLSL for WebGL 2).
- Let the plugin's development transform install the marker bootstrap before
  application imports execute. Do not add prototype patches, delayed imports,
  or a second manual `installPrecompileMarker()` call to work around eager
  material construction.

## Agent execution loop

Use one ordered evidence loop instead of treating setup, capture, and build as
independent successes:

1. Run the doctor from the Vite application root and parse its JSON even when
   it exits nonzero:

   ```sh
   pnpm exec tsl-precompile-doctor --json --compact --source src
   ```

2. Execute each `kind: "command"` item in `nextActions` from its absolute `cwd`
   after its `dependsOn` items are complete. Resolve each manual action's
   required inputs; in particular, write down the complete
   route/state list and advanced-topology matrix before
   capture.
3. Start the application's existing development script in a separate process,
   exercise that exact matrix, and run route automation plus source-aware
   verification:

   ```sh
   pnpm exec tsl-precompile-recapture --json \
     --url http://localhost:5173 \
     --paths /,/viewer,/effects \
     --backends webgpu,webgl \
     --source src \
     --source-root . \
     --artifacts artifacts
   pnpm exec tsl-precompile-verify --json \
     --source src \
     --source-root . \
     artifacts
   ```

   Replace the URL, route list, source roots, and artifact directory with the
   values discovered in step 1. Prefer the verifier action returned by a
   successful recapture because it preserves those exact inputs.
4. Re-run the doctor. When its static state is `ready-compatibility` (or
   `slim-proof-required` for an intentionally established slim app), execute
   its `production-build` action. Serve that build with the application's
   existing preview script and replay the same route/state/topology matrix in a
   browser that provides the backend under test. Repeat for every backend the
   application can select. Require nonblank changing pixels and zero page,
   console, request, capture, or GPU validation errors.
5. Do not point `tsl-precompile-recapture` at the production preview. It is a
   development-capture client and expects the dev-only endpoint; production
   replay is a separate browser proof.

When changing this plugin repository itself, add one focused advanced
capture/replay proof after the consumer-style loop. This command is
maintainer-only; it is not available in an installed consumer project:

```sh
node packages/examples/batch/run-hard-scene.mjs \
  --plan \
  --case=webgpu_postprocessing_ssr_denoise.html \
  --three-repo=/absolute/path/to/clean-three-r185
```

Choose the exact filename from the plan's checked `cases` by its `features`.
Only when the plan reports `status: "ready"` should an agent spawn
`nextAction.argv` directly from `nextAction.cwd`. A passing upstream hard-scene
case is focused plugin regression evidence; it never replaces the target
application's production backend-matched replay.

## 1. Audit the application

Find:

1. The active Vite config and package-manager lockfile.
2. Every `WebGPURenderer` construction, its `forceWebGL`/fallback selection,
   and every `renderer.init()` call.
3. Every reachable `*NodeMaterial` construction or factory and the last TSL graph assignment for each material.
4. Routes, lazy states, camera types, light/shadow modes, geometry variants, clipping, instancing/skinning, MRT, post-processing, backgrounds, PMREM, and compute paths that may change shader topology.
5. Existing `.precompile()` calls, `setupPrecompile()`, `artifacts/`, or plugin configuration. Extend valid integration instead of duplicating it.

If the project uses classic `WebGLRenderer`, is not Vite-based, or does not use
TSL materials, stop and explain that the plugin does not apply without a
deliberate application migration. Do not reject an app merely because its
`WebGPURenderer` intentionally selects the WebGL 2 backend.

When the packages are already installed, use the read-only doctor as the first
machine checkpoint:

```sh
pnpm exec tsl-precompile-doctor --json --compact --source src
```

Run it from the Vite application root or pass `--root`. Replace `src` with, or
repeat `--source` for, the application's actual JavaScript/TypeScript source
roots. The initial audit normally exits nonzero with `needs-setup` or
`needs-capture`; parse its JSON regardless of exit status. Those states are an
action plan, not evidence that integration is impossible.

On a large repository, add `--compact`: it keeps every check, next action,
proof, and remaining gate while sampling bulky evidence lists and reporting
explicit omission counts.

Use the equivalent `npx --no-install`, `yarn exec`, or `bunx --bun` invocation
for the owning lockfile. Read `checks[].code`, `status`, `evidence`, and
`remediation`; passing checks omit `remediation` and `nextAction`, while warn
and fail checks carry them. For each `nextActions[]` item with `kind: "command"`, execute its
`argv` array directly in its absolute `cwd` only after every `dependsOn` action
is complete; never pass the prose `action` or `reason` through a shell. Items
with `kind: "manual"` deliberately have `argv: null`. Resolve their
`requiresInput` values and replace every placeholder in `commandTemplate`
before running it. If a manual action supplies `argvByPackageManager`, resolve
its `packageManager` input first and select exactly one matching argv; never
execute every alternative or assume npm. `ready-compatibility` means
configuration and captured source ownership are coherent. It deliberately
leaves route coverage, advanced render topologies, production build, preview,
and all slim-mode proof unverified.

The skill-installer, doctor, recapture, and verifier `--json` modes reserve
stdout for exactly one schema-versioned object. Operational results share
`ok`, `status`, `command`, and `nextActions`; parse the object even when the
process exits nonzero. Spawn a `kind: "command"` action's `argv` array directly
in its absolute `cwd`, without joining it into a shell string. `commands` is
an additive compatibility alias for clients that consumed grouped command
arrays. A `kind: "manual"` action has `argv: null` because inspection or user
input is required.

The doctor's `agent-skill` check passes only when every discovered known-path
skill tree matches `evidence.expectedDigest`. Inspect
`evidence.candidates[]` for each location's `current`, `stale`, or `unsafe`
status. A stale, locally altered, or unsafe tree remains untouched and emits
the ordinary non-forcing skill-installer remediation; do not add `--force`
without explicit user approval.

## 2. Install compatible dependencies

Use the detected package manager. Keep the plugin in `devDependencies`; keep the runtime and exact Three version in `dependencies`. Use the matching pair below for the current alpha:

```sh
# pnpm
pnpm add -D vite-plugin-tsl-precompile@alpha
pnpm add @tsl-precompile/runtime@alpha three@0.185.1 --save-exact
# TypeScript projects only:
pnpm add -D @types/three@0.185.1 --save-exact

# npm
npm install --save-dev vite-plugin-tsl-precompile@alpha
npm install --save-exact @tsl-precompile/runtime@alpha three@0.185.1
# TypeScript projects only:
npm install --save-dev --save-exact @types/three@0.185.1

# yarn
yarn add --dev vite-plugin-tsl-precompile@alpha
yarn add --exact @tsl-precompile/runtime@alpha three@0.185.1
# TypeScript projects only:
yarn add --dev --exact @types/three@0.185.1

# bun
bun add --dev vite-plugin-tsl-precompile@alpha
bun add --exact @tsl-precompile/runtime@alpha three@0.185.1
# TypeScript projects only:
bun add --dev --exact @types/three@0.185.1
```

Run only the commands for the lockfile that owns the project. If packages are already present, reconcile versions rather than adding duplicates. Confirm the resolved versions satisfy both packages' peer dependencies before continuing.

## 3. Configure Vite in compatibility mode

Adapt the existing config rather than copying it blindly:

```js
import { defineConfig } from 'vite';
import tslPrecompile from 'vite-plugin-tsl-precompile';

export default defineConfig( {
	plugins: [ tslPrecompile() ],
	build: { target: 'esnext' },
	optimizeDeps: {
		include: [ 'three', 'three/webgpu', 'three/tsl' ],
	},
} );
```

For a new adoption, keep `slim` unset at first. Compatibility mode validates and registers captures while retaining the live NodeMaterial and stock Three compiler, so uncaptured application behavior remains available during adoption. Preserve an established slim configuration when the audit shows that compiler-free delivery is already an intentional, tested requirement; use compatibility mode only as a diagnostic if that integration is failing.

## 4. Wire the live renderer once

Use the conditional setup entry with the same renderer that performs real draws:

```js
import { setupPrecompile } from '@tsl-precompile/runtime/setup';

const renderer = new WebGPURenderer( rendererOptions );
const precompile = setupPrecompile( { renderer } );
await renderer.init();
await precompile.ready;
```

Preserve `rendererOptions`. `forceWebGL: true` is a supported
`WebGPURenderer` configuration; replacing it with classic `WebGLRenderer` is
not. If automatic fallback is a production path, establish an app-owned way to
exercise the same matrix on WebGPU and with `forceWebGL: true` for WebGL 2.

Do not initialize the renderer twice. If bootstrap already lives in an async function, keep it there; top-level await is not mandatory. `setupPrecompile()` may be called before or after `renderer.init()`, but await `precompile.ready` before relying on capture.

The plugin injects a development-only marker bootstrap ahead of application
imports. A statically imported module may therefore construct an automatically
detected or explicitly marked NodeMaterial before this setup body runs.
Production resolves that bootstrap to an empty module.

## 5. Confirm automatic detection and add deliberate overrides

`tslPrecompile()` automatically marks direct `new *NodeMaterial(...)`
constructors in application source. Keep that default for ordinary adoption.
Add an explicit marker after the material's complete TSL graph has been
assigned only when a stable semantic name is valuable or automatic detection
cannot see the constructor:

```js
const material = new MeshStandardNodeMaterial();
material.colorNode = buildColorGraph();
material.precompile( 'product-card-surface' );
```

Use a unique, stable, project-global literal containing only letters, digits,
`.`, `_`, or `-`. Derive names from semantic ownership, not array order or
runtime data. Explicit markers take precedence over automatic detection. Do not
mark classic non-node materials just to increase coverage.

Generated automatic names are positional and can change after source
reordering. Use `tslPrecompile({ autoMark: false })` only when the application
intentionally requires explicit markers everywhere.

## 6. Capture real render paths

Start the project's normal Vite development command. Open the app in a browser
capable of the selected `WebGPURenderer` backend and exercise every route and
state that owns a marker. A marker captures only after its material participates
in a real `renderer.render(scene, camera)` call, because the backend, scene,
camera, object, geometry, lighting, shadows, clipping, and render-target
topology affect the shader. Repeat the complete matrix for every backend that
production can select—prefer the explicit dual-backend recapture command below:
WebGPU captures WGSL, while WebGL 2 captures GLSL. Never assume one language
can replay on the other backend.

Verify all of the following:

- The browser console has no capture errors.
- An artifact exists for every intended automatic or explicit marker.
- Each production backend has the matching WGSL or GLSL variants for every
  shipped route/topology.
- The manifest points to the current artifact families.
- Lazy routes and materially different render topologies were exercised.
- Generated artifacts appear in version-control status and are not ignored.

Then run the package's deterministic integrity gate:

```sh
pnpm exec tsl-precompile-verify --source src --source-root . artifacts
```

Use `npx --no-install`, `yarn exec`, or `bunx --bun` with
`tsl-precompile-verify` when that tool owns the lockfile. Replace `src` with,
or repeat `--source` for, the application's actual JavaScript/TypeScript source
roots. The source-aware gate reports the exact automatic and authored marker
name plus `source:line:column` for any missing capture. Use `--json` for stable
CI output. A skipped or empty directory is not evidence of capture; inspect
the command's checked artifact and expected-marker counts.

Use `tsl-precompile-recapture` when Playwright is already available or automation is requested. Start Vite separately, then visit every relevant route:

```sh
pnpm exec tsl-precompile-recapture --json \
  --url http://localhost:5173 \
  --paths /,/viewer,/effects \
  --backends webgpu,webgl \
  --source src \
  --source-root . \
  --artifacts artifacts
```

In JSON mode, stdout is one versioned result object and progress stays on
stderr. Inspect each route's capture starts, accepted/failed posts,
cold-reload recovery, elapsed time, requested backend, observed post-init
backend, and coded failures. `--backends webgpu,webgl` visits every declared
route in two fresh contexts. The WebGPU pass uses the browser normally and
fails if Three silently falls back. The WebGL pass asks Three's own
WebGPU-to-WebGL fallback to initialize the real WebGL 2 backend without
changing `navigator.gpu` or application feature branches. The command fails on
opposite, mixed, unknown, or uninitialized renderer evidence. Chromium is the
validated automated path; Firefox and WebKit are experimental. Do not assume
headless WebGPU is available. Retry headful when possible; if the environment
still cannot provide WebGPU, leave the code changes in place and report the
exact command as the remaining verification step.
The successful result's verifier action preserves the repeatable `--source`,
`--source-root`, `--artifacts`, `--no-auto-mark`, and `--auto-mark-prefix`
inputs supplied to recapture. Successful route activity is not source
coverage, so execute that action afterward.

For a custom browser harness, take `setup.captureStatus()` before the render
that reveals the materials and await
`setup.waitForCaptureSettled({ since: status })`. Do not substitute a fixed
sleep when this signal is available.

For post-processing, backgrounds, PMREM, MRT, compute, or compiler-free adoption, read [advanced-capture.md](references/advanced-capture.md) before changing setup.

## 7. Build and smoke-test

Run the project's production build. Fix missing/stale-artifact errors by
returning to development capture; never weaken `fail`, alter hashes, or
fabricate artifacts to make the build green. When feasible, run the production
preview with each supported `WebGPURenderer` backend and check the same
representative routes for rendering and console errors.

Prove the selected backend without relying on a constructor name that
production minification may rename. Confirm the live renderer is the
application's `WebGPURenderer`; for WebGPU confirm `navigator.gpu` is available,
and for WebGL 2 confirm the exercised application configuration selects
`forceWebGL: true` or expose an app-owned diagnostic based on
`renderer.backend.isWebGLBackend`. In both cases require a non-blank primary
canvas that changes across representative frames and no console, request,
native-shader/backend-mismatch, or uncaptured-topology errors.

Report:

- dependency and configuration changes;
- renderer wiring and explicit marker overrides changed;
- artifacts generated, or why browser capture remains pending;
- development capture, production build, and preview results;
- whether the app remains in compatibility mode or was separately validated in slim mode.

## 8. Consider slim mode only after success

For a new adoption, offer `tslPrecompile({ slim: 'source' })` as an opt-in
optimization only after compatibility capture, build, and preview all pass. Do
not enable it implicitly for an existing application. Slim production removes
the live TSL compiler, so every reachable material, auxiliary topology, and
renderer backend must be captured or supported explicitly. After changing
modes, re-run development capture, source-aware verification, the production
build, and the representative preview on every production backend. For an app
that began the task in a verified slim mode, keep it there and apply the slim
checklist directly.

## Definition of done

Do not hand off the integration as complete until:

- the resolved plugin/runtime versions match and Three resolves exactly to the
  supported peer version;
- each live renderer is registered once and each intended NodeMaterial is
  covered by automatic detection or an explicit marker;
- every reachable route, production renderer backend, and materially different
  render topology has been exercised in development;
- source-aware `tsl-precompile-verify` reports the expected non-zero artifact
  family, no missing automatic/authored markers, and no integrity errors;
- the final `tsl-precompile-doctor --json --compact` state matches the configured mode:
  `ready-compatibility` for compatibility, or `slim-proof-required` with no
  failed static checks for slim. The latter is expected but is not completion
  evidence by itself; keep all route/topology/build/preview/slim proof fields
  as work items;
- the production build passes without missing or stale captures;
- a backend-matched production preview renders representative routes for every
  supported production backend without page, console, network-capture,
  shader-language/backend-mismatch, or blank-canvas failures;
- the handoff states whether production remains in compatibility mode or was
  separately proven compiler-free with `slim: 'source'`.
