# Releasing

How to cut a release of the `tsl-precompile` packages to npm.

## Publish set

Three packages move together to npm:

| Package | npm name |
|---|---|
| `packages/plugin` | `vite-plugin-tsl-precompile` |
| `packages/runtime` | `@tsl-precompile/runtime` |
| `packages/contract` | `@tsl-precompile/contract` |

**Not published:** `@tsl-precompile/inspector-panel`, `@tsl-precompile/site`,
everything under `packages/examples/*` (all `"private": true`).

## Versioning

The three packages move in lockstep. Both `plugin` and `runtime` depend on
`contract` via `workspace:*`; a contract change implies bumping the other
two so the rewritten dep version matches at publish time.

Bump all three to the same SemVer. `0.1.0` is the current floor; the next
release is `0.1.x` (patch — DX / docs / additive runtime helpers) or
`0.2.0` (any change that crosses the contract boundary).

Do **not** touch:

- `_shared/constants.js` `PLUGIN_VERSION`
- the `'0.0.0'` strings in `precompile-marker.js` / `aux-marker.js`

Those are hash-schema versions, deliberately decoupled from the npm version.

## `workspace:*` rewriting

Both `plugin` and `runtime` carry `"@tsl-precompile/contract": "workspace:*"`.
`pnpm publish` / `pnpm pack` rewrites `workspace:*` to the matching real
version (`^0.1.x`) at pack time. You do not need to commit a different value.

## Pre-flight

1. Start from a clean checkout on `main`.
2. `pnpm install --frozen-lockfile` — important so the slim rollup build
   resolves three.js from the locked version, not whatever the
   `three-compat.yml` workflow last installed.
3. Bump versions in the three publishable `package.json` files to the
   target SemVer (and update any `dependencies` block that pins another
   workspace package).
4. `pnpm release:check` — runs `pnpm build && pnpm test && pnpm verify &&
   pnpm pack:dry`. This is also what each `prepublishOnly` runs in
   miniature.
5. Inspect the dry-run tarball contents:
   - `vite-plugin-tsl-precompile` — `src/` + `types/` (no `test/`; `vendor/VENDORING.md` is included as extractor provenance).
   - `@tsl-precompile/runtime` — `src/` + `types/` + `build/three.webgpu.slim.js`. Confirm
     the slim bundle was rebuilt by `prepublishOnly` and gzip stays under the
     300 KB ceiling.
   - `@tsl-precompile/contract` — `src/` only.
6. Smoke-check the new `setupPrecompile()` snippet from the README still
   types/parses (`pnpm --filter examples-getting-started build` after a
   fresh dev capture).

`prepublishOnly` is the safety net: even if you skip `release:check`,
`pnpm publish` for `runtime` rebuilds the slim bundle with
`TSLP_FAIL_ON_REWRITE_WARNING=1` and runs the test suite first; `plugin`
runs its test suite.

## Publish

Contract must reach npm first (or in the same `pnpm -r publish` pass), or
plugin/runtime can't resolve their rewritten dep on a clean install:

```sh
pnpm -r \
	--filter '{packages/contract}' \
	--filter '{packages/runtime}' \
	--filter '{packages/plugin}' \
	publish --access public
```

pnpm publishes in dependency order, so this single command lands contract
before runtime/plugin.

After publish:

1. `git tag v<version> && git push --tags`.
2. `npm view vite-plugin-tsl-precompile dist-tags` — confirm `latest` matches.
3. Scratch-dir smoke:
   ```sh
   mkdir /tmp/tslp-smoke && cd /tmp/tslp-smoke
   pnpm init -y
   pnpm add -D vite vite-plugin-tsl-precompile
   pnpm add three @tsl-precompile/runtime
   ```
   Then paste the README quickstart, `pnpm vite` once, commit the artifact,
   `pnpm vite build`. Both should succeed.

## Inspector panel + site

`@tsl-precompile/inspector-panel` (still `0.0.0`) and `@tsl-precompile/site`
stay unpublished until they have their own release stories. They are
referenced from the `runtime` (optional dynamic import) and the docs site
respectively; nothing in the publish set requires them.
