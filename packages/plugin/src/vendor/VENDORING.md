# Vendoring

Files in this directory are copies of code from the three.js fork branch `tsl-precompile` (at github.com/Makio64/three.js/tree/tsl-precompile).

We vendor instead of depending on the fork as an npm package because the plugin's stated goal is "works with any three.js project" — users install stock `three` + this plugin, not a forked three.

## Current vendored files

| File | Upstream | Version tag | Reason to vendor |
|---|---|---|---|
| `compileTSL.js` | `src/nodes/precompile/compileTSL.js` | tsl-precompile @ dc09e30 | Extractor core — walks `renderer._nodes.nodeBuilderCache` and emits JSON artifacts. |
| `extractUniformPlan.js` | `src/nodes/precompile/extractUniformPlan.js` | tsl-precompile @ dc09e30 | Classifies every TSL update node into a serializable `source` descriptor. |

`render-object-observer.js` is a local dev-only adapter, not an upstream copy.
It is the single owner of the private `renderer._nodes.getForRender` build tap
and `renderer._objects.get` cached-request tap used by extraction. Keep new
live-capture subscribers on that adapter so HMR and duplicate plugin copies
cannot stack independent wrappers.

The adapter also owns the direct-harvest compatibility seam. The installed
Three revision reuses each `RenderContext` and mutates its `renderTarget`,
`activeCubeFace`, `activeMipmapLevel`, attachment, sample, and MRT fields
between requests, so the adapter copies those fields and creates the canonical
render-object selector synchronously when `RenderObjects.get()` returns. A
cached RenderObject may skip `NodeManager.getForRender`; in that case the
adapter reads `renderer._nodes.nodeBuilderCache.get(cacheKey)`. New/async
states are correlated later by the pair `(renderObject.material, cacheKey)`.
`beginRenderObjectHarvest(renderer)` exposes one bounded epoch whose completed
families can be passed to `compileTSL(..., { renderObjectHarvest })`. Consumers
must adopt a complete family atomically; an unavailable state or selector makes
the whole material family fall back to synthetic extraction.
`compileTSL.js` re-exports that factory so the browser marker can preload the
one Vite-aliased dev module instead of introducing another private-source alias.

`RenderObjects.get()` returns before Renderer assigns the current geometry
group to `renderObject.group`, and shadow rendering has already replaced the
caster material by then. The adapter therefore also owns one Symbol-shared
`renderer.renderObject(...)` wrapper. A nested synchronous dispatch stack lets
the inner `RenderObjects.get()` snapshot copy the exact pre-override object,
selected material, geometry, and group scalars. Requests emitted outside that
dispatch (including some synthetic compile paths) remain explicitly inexact;
they may preserve compatibility evidence but cannot stamp durable
`shadow-caster` binding ownership. Keep this as the only Renderer call-site
patch so duplicate plugin copies and HMR cannot stack competing wrappers.
An active legacy v1 request wrapper is reused rather than replaced during an
HMR handoff; its requests remain ownership-incomplete until that bounded
capture epoch finishes, which fails closed instead of creating a second
private-method wrapper or guessing caster ownership.

Local assumption: Three r184's `Renderer._getShadowNodes()` represents a
caster `map` with a plain `ReferenceNode` whose stable `.object` is the exact
source material. `Renderer.renderObject()` instead copies `alphaMap` and
`alphaTest` onto the shared shadow override before its implicit
`MaterialReferenceNode`s run; it does not copy `opacity`. Extraction therefore
uses the full exact-owner identity set, never texture UUIDs or the mutable
`.reference` field. The artifact's `shadow-caster` owner is the compact
default, while shader-owned material inputs such as opacity serialize a
source-local `render-material` exception. Update both the copied-property
contract and the real shadow fixture if an upstream Three bump changes this
call-site behavior.

Exact shadow ownership also qualifies serialized graph paths. A
caster-owned `uniform.live.nodePath`, node-attribute `userPath`, or storage
buffer `userPath` is recorded relative to the process-local exact caster Set,
never the shared shadow override. A path is serialized only when every caster
exposes a compatible resource at the same public node path; otherwise capture
omits it and replay uses its owner-local snapshot/shape fallback. Source-local
`render-material` live uniforms continue to resolve paths against the override.

Shadow material cache keys are local to each renderer-owned per-light material
family; r184 can reuse the same numeric key for equivalent directional and
point-shadow payloads even though their render-target selectors differ. Aux
capture must merge every observed shadow family through the shared artifact
variant contract. Equivalent same-key payloads canonical-union their semantic
selectors; divergent same-key payloads fail closed because the serialized
`variants` map cannot represent both without a contract migration. Never use a
last-writer-wins cache-key assignment here: it silently drops cube-face point
shadow coverage.

Slim replay has a separate build-time AST seam at r184's direct
`material = overrideMaterial` assignment. At that expression the right-hand
`material` is still the exact selected caster (including an array/group
selection), while the override already holds Three's copied `alphaTest`,
`alphaMap`, `transparent`, and `side`. The rewrite replaces only that handoff
with `createReplayShadowMaterial( overrideMaterial, material )` and unwraps
only the `onAfterRender` material argument. Keep both shapes gated exactly
once; do not move ownership recovery into `_renderObjectDirect()`, where
`RenderObject` has already been keyed by the shared override.

Local assumption: `Object3DNode` instances with an explicit `object3d.isCamera`
target are serialized as `object3d.*` sources with `target: "camera"`. This
preserves TSL like `objectPosition(camera)` in post-processing passes, where
replay's draw object and render camera are the fullscreen quad rather than the
source scene camera.

Local assumption: analytic-light sources carry a Symbol-keyed capture record
from `@tsl-precompile/contract/light-identities` until `extractArtifact()`
normalizes them into one variant-local `lightIdentities` table. The public
`Light`, `LightShadow`, and shadow-camera properties are read for matching
evidence; process-local `Object3D.id` is never persisted as durable identity.

Local assumption: stock Three exports `UniformNode` from `three/webgpu`, and
the high-precision model-view, normal-view, and shadow-model UniformNodes are
created lazily after `extractUniformPlan.js` loads. The extractor installs one
identity-scoped `UniformNode.onUpdate` wrapper that retains original callbacks
in a WeakMap. It classifies only exact r184 callback shapes; it never executes
arbitrary object-update callbacks. The exact stock shadow callback may be
evaluated once against a detached result matrix to recover its closed-over
light-shadow matrix identity. Update the callback-shape fixtures whenever an
upstream Three bump changes these bodies.

## Import rewrites

The vendored files originally imported from relative paths inside `three/src/nodes/**`. Those paths don't exist in the stock `three` package the plugin depends on. Rewrites:

| Vendored file | Original import | Rewritten to |
|---|---|---|
| `extractUniformPlan.js` | `'../accessors/ModelNode.js'` (`modelNormalMatrix`, `modelWorldMatrixInverse`) | `'three/tsl'` |
| `extractUniformPlan.js` | `'../utils/Timer.js'` (`time`, `deltaTime`, `frameId`) | `'three/tsl'` |

If a future `three` release drops any of these exports from `three/tsl`, bump the version row above and add a compat shim in `_shared/three-compat.js`.

## Upgrade procedure

When bumping to a newer three.js version:

1. Run `pnpm verify` BEFORE re-vendoring to snapshot current artifact hashes.
2. Copy the newer source files into `src/vendor/`.
3. Re-apply the import rewrites above.
4. Run `pnpm test:three-rewrite` — every rewrite shape probe must stay green.
5. Run `TSLP_FAIL_ON_REWRITE_WARNING=1 pnpm --filter @tsl-precompile/runtime build:slim`.
6. Run `pnpm test:coverage` — every covered source.kind must still pass its fixture.
7. Run `pnpm verify` AFTER — artifact hashes WILL change because the three-version is part of the hash. Expected. Update the "Version tag" column above.
8. Recapture example artifacts (`pnpm` example recapture / `packages/plugin/src/cli/recapture-all.js`) and refresh visual baselines only when intentionally updating evidence.

### Current gap: locked `0.184.0` vs latest `0.185.1` (2026-07-10)

Workspace examples and the lockfile pin `three@0.184.0`. Peer ranges already
allow `>=0.184.0`. A bump to `0.185.1` is **not** a drive-by change:

- Artifact content hashes include the three revision → every committed
  `artifacts/*.json` needs recapture.
- Slim bundle must be rebuilt; rewrite probes must pass under
  `TSLP_FAIL_ON_REWRITE_WARNING=1`.
- Visual tier-1 evidence may churn; do not hand-edit `results/shots/**`.

**Checklist to land 0.185.1:**

1. `pnpm --filter @tsl-precompile/runtime add three@0.185.1 --save-dev` (and the same for the plugin package / examples that pin exact versions).
2. Update example `package.json` pins from `0.184.0` → `0.185.1`.
3. Run rewrite + slim build + `pnpm test` + `pnpm test:coverage` + `pnpm verify`.
4. Recapture example artifacts and re-run `pnpm test:e2e:tier1` if visual paths change.
5. Confirm `.github/workflows/three-compat.yml` `latest` matrix is green on the PR.

Until that lands, nightly `three-compat` `latest` remains the early-warning
signal; keep the locked matrix on `0.184.0` for ship confidence.

## Why not publish `@tsl-precompile/three-core`?

We considered publishing a forked three as an npm package and depending on it. Rejected because:

- Users would need to install a custom three, breaking ecosystem tools (glTFLoader, addons, other plugins) that pin on `three` peer-deps.
- Version drift with upstream becomes a sustained maintenance burden.
- Vendoring isolates the plugin's "dangerous" imports from the user's three — user upgrades three freely; plugin tracks at its own pace.

Trade-off: a three.js internal API change (e.g. `renderer._nodes.nodeBuilderCache` renamed) silently breaks the plugin until we re-vendor. Mitigation: CI runs the Node harness against three.js's current `latest` tag nightly; regressions are caught before users hit them.
