# getting-started — tsl-precompile

The smallest repository example using `vite-plugin-tsl-precompile`:

- one renderer, one scene, and one lit `MeshStandardNodeMaterial`
- one optional `.precompile('getting-started')` stable-name override
- compatibility mode first: artifacts are validated while stock Three remains
  authoritative
- one `setupPrecompile()` call, using the renderer that performs real draws

This package intentionally uses `workspace:*`; it runs from this monorepo and is
not a standalone published template.

## Capture in development

From the repository root:

```sh
pnpm install
pnpm dev:getting-started
```

The dev server opens `http://localhost:5174`. In a WebGPU browser, wait for the
torus knot to render. The capture writes
`./artifacts/getting-started.<hash>.json`; commit generated artifacts as build
inputs and never edit their JSON.

Keep dev running. In a second terminal, verify this example's actual root-level
source file:

```sh
pnpm --filter examples-getting-started exec tsl-precompile-doctor \
  --root . \
  --source main.js
pnpm --filter examples-getting-started exec tsl-precompile-verify \
  --source main.js \
  --source-root . \
  artifacts
```

Then stop dev, build, and keep preview running:

```sh
pnpm --filter examples-getting-started build
pnpm --filter examples-getting-started preview
```

Open the preview URL in a WebGPU browser and confirm nonblank changing pixels
with no page, console, request, capture, or GPU validation errors.

## Optional slim proof

Only after the compatibility sequence passes, change the plugin option to
`slim: 'source'`, recapture, verify, rebuild, and replay the same scene. Slim
mode also captures the renderer-output topology used for tone mapping and color
space, then removes NodeBuilder from the covered production path.

## Refreshing the artifact

The artifact's hash is keyed on the TSL graph **and** the installed three.js
version. Re-run `dev` to refresh it after either:

- changing the `material.colorNode` expression, or
- bumping `three` in `package.json`, or
- exercising a new renderer output topology such as another tone mapping or
  output color space.

The plugin's build will fail with "no artifact for 'getting-started'" or a
hash-mismatch warning if the committed artifact is stale.

## Small full-vs-precompiled comparison

```sh
pnpm --filter examples-getting-started compare
```

Requires local Chrome and the workspace's batch Playwright dependency. Builds the
existing scene in full compatibility and source-slim production modes, measures
them sequentially in Chrome, then serves a live comparison at
`http://127.0.0.1:5186`. Use `TSLP_DEMO_PORT` to select another port. Stop with Ctrl-C.
The comparison leaves captured artifacts unchanged.

Each mode gets three alternating rounds at 640×480 with DPR 1, 30 warm-up frames
and 90 samples per round. The table reports median-of-round medians and p95s;
raw samples and two same-pose screenshots live in `dist/comparison/`. GPU timing
uses WebGPU timestamp queries; CPU timing excludes GPU readback. Shader-node count
means unique nodes processed by NodeBuilder during startup, not scene objects or
all retained JavaScript objects. First-render CPU is instrumented and can benefit
from browser/driver caches. These short runs describe this scene and machine.

`compare -- --skip-build` reuses the builds for another measurement.
`compare -- --skip-build --serve-only` reopens the saved report without measuring.
