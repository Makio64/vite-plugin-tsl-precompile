# Vendoring

Files in this directory are copies of code from the three.js fork branch `tsl-precompile` (at github.com/Makio64/three.js/tree/tsl-precompile).

We vendor instead of depending on the fork as an npm package because the plugin's stated goal is "works with any three.js project" — users install stock `three` + this plugin, not a forked three.

## Current vendored files

| File | Upstream | Version tag | Reason to vendor |
|---|---|---|---|
| `compileTSL.js` | `src/nodes/precompile/compileTSL.js` | tsl-precompile @ dc09e30 | Extractor core — walks `renderer._nodes.nodeBuilderCache` and emits JSON artifacts. |
| `extractUniformPlan.js` | `src/nodes/precompile/extractUniformPlan.js` | tsl-precompile @ dc09e30 | Classifies every TSL update node into a serializable `source` descriptor. |

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
4. Run `pnpm test:coverage` — every covered source.kind must still pass its fixture.
5. Run `pnpm verify` AFTER — artifact hashes WILL change because the three-version is part of the hash. Expected. Update the "Version tag" column above.

## Why not publish `@tsl-precompile/three-core`?

We considered publishing a forked three as an npm package and depending on it. Rejected because:

- Users would need to install a custom three, breaking ecosystem tools (glTFLoader, addons, other plugins) that pin on `three` peer-deps.
- Version drift with upstream becomes a sustained maintenance burden.
- Vendoring isolates the plugin's "dangerous" imports from the user's three — user upgrades three freely; plugin tracks at its own pace.

Trade-off: a three.js internal API change (e.g. `renderer._nodes.nodeBuilderCache` renamed) silently breaks the plugin until we re-vendor. Mitigation: CI runs the Node harness against three.js's current `latest` tag nightly; regressions are caught before users hit them.
