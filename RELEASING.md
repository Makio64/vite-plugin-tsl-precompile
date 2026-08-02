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

The three public packages move in lockstep, including the complete prerelease
identifier. Both `plugin` and `runtime` depend on `contract` via `workspace:*`;
a contract change implies bumping the other two so the rewritten dependency
version matches at publish time.

The first npm release should therefore set all three packages to
`0.1.0-alpha.0`. Subsequent alpha builds increment the prerelease number
(`0.1.0-alpha.1`, `0.1.0-alpha.2`, and so on) in all three manifests. Do not
mix stable and prerelease versions within the publish set.

Do **not** touch:

- `_shared/constants.js` `PLUGIN_VERSION`
- the `'0.0.0'` strings in `precompile-marker.js` / `aux-marker.js`

Those are hash-schema versions, deliberately decoupled from the npm version.

## `workspace:*` rewriting

Both `plugin` and `runtime` carry `"@tsl-precompile/contract": "workspace:*"`.
`pnpm publish` / `pnpm pack` rewrites `workspace:*` to the matching real
version exactly at pack time (`0.1.0-alpha.0` for the first alpha), not to a
caret range. You do not need to commit a different dependency specifier.

## Pre-flight

1. Start from an up-to-date checkout on `main`.
2. Run `pnpm install --frozen-lockfile` — important so the slim rollup build
   resolves three.js from the locked version, not whatever the
   `three-compat.yml` workflow last installed.
3. Bump all three publishable `package.json` files to the same target SemVer.
   For the first npm alpha, use `0.1.0-alpha.0` in every package.
   Keep the plugin/runtime `three` peer pinned to the exact revision that passed
   the strict rewrite and visual gates (`0.185.1` for this alpha). Do not widen
   it while the nightly `three@latest` compatibility probe is red.
4. Finalize `CHANGELOG.md`, then generate the two tracked publication inputs:
   ```sh
   TSLP_FAIL_ON_REWRITE_WARNING=1 pnpm --filter @tsl-precompile/runtime build:slim
   node packages/plugin/scripts/sync-agent-skill.mjs
   ```
   Review and commit the version, lockfile, slim bundle + provenance, published
   skill, and every other intentional release change. `pnpm release:check`
   deliberately refuses a dirty or detached checkout; it never decides which
   generated changes should belong to a release.
5. Check out the official `r185` Three corpus at commit
   `2431a09f46f34c560bc8e44b33be0e567723d5b9` and expose its absolute path as
   `TSLP_THREE_REPO`. Canonical evidence rejects any other commit or a dirty
   checkout. Install Playwright Chromium once if needed:
   ```sh
   export TSLP_THREE_REPO=/absolute/path/to/three-r185
   pnpm exec playwright install chromium
   ```
6. Run `pnpm release:check`. It pins the whole run to the starting `main`
   commit and requires a clean worktree after every gate, including the runtime
   build and plugin `prepack` skill synchronization. It runs package/site builds,
   the complete package test suites, slim production budgets, batch diagnostics,
   a fresh live tier-1 capture/replay/PSNR gate, every example production
   build, the ocean and showcase preview smokes, artifact verification, a
   packed-tarball install/capture/build/preview smoke at the current and
   declared-minimum Vite surfaces, and dry package creation. CI separately
   exercises the package and packed-consumer gates on Node 20.19. The packed
   smokes install exact public dependencies from the npm registry, so run this
   gate with registry access. Browser-smoke evidence and release tarballs are
   written under the unique private temporary directory printed by
   `release:check`, never into tracked example result directories or shared
   `/tmp` filenames.
   The visual summary rehashes the recorded repository sources and slim bundle,
   reconciles report totals with every case status, and grades only
   manifest-bound capture/replay pairs from that run.
   Unsigned legacy material artifacts are intentionally rejected: recapture
   every reachable route with the current plugin and commit its generated JSON
   before treating `pnpm verify` as a release gate.
7. Inspect the `release-tarballs/` directory below the unique path printed by
   `release:check`:
   To reproduce only the packing and integrity steps, choose a fresh private
   directory and pass the same absolute path to both commands:
   ```sh
   pnpm pack:dry --directory=/absolute/private/empty/release-tarballs
   pnpm release:integrity --directory=/absolute/private/empty/release-tarballs
   ```
   The pack helper refuses a non-empty explicit directory, so each standalone
   run starts from an unambiguous tarball set instead of shared `/tmp` names.
   The integrity guard opens every archive, requires canonical gzip encoding,
   constrained tar metadata, and zero padding, and rejects duplicate, linked,
   ignored, untracked, omitted, or out-of-surface entries. The exact file set
   is derived from the committed `package.json` publish surface. Every ordinary
   byte and executable mode must match Git `HEAD`; the three explicitly
   enumerated plugin-skill files must match their committed canonical skill
   sources.
   - Every public package contains its package-local `LICENSE`.
   - The plugin and runtime also contain `THIRD_PARTY_NOTICES.md` with the
     complete three.js r185 MIT notice and their package-specific provenance.
   - `vite-plugin-tsl-precompile` — `src/` + `types/` + `skill/` (no `test/`;
     `vendor/VENDORING.md` is included as extractor provenance).
   - `@tsl-precompile/runtime` — `src/` + `types/` +
     `build/three.webgpu.slim.js` + its `.meta.json` provenance. Confirm the
     checked bundle is the committed one and gzip stays within the documented
     268,000-byte cap in `packages/runtime/build-tools/slim-budget.json`.
   - `@tsl-precompile/contract` — package metadata + `README.md` + `LICENSE` +
     `src/`.
   - Inspect each packed `package.json`: all three versions match; rewritten
     contract dependencies are exact (no `workspace:` protocol); `three`,
     `@types/three`, and Vite constraints match the tested release surface.
   - Recheck and save the final integrity output, passing that exact directory:
     ```sh
     pnpm release:integrity --directory=/printed/release-check/path/release-tarballs
     ```
     Its npm-compatible `integrity` and `shasum` values describe the exact bytes
     the publish wrapper sends to the registry.
8. Smoke-check the `setupPrecompile()` snippet from the README still
   types/parses (`pnpm --filter examples-getting-started build` after a
   fresh dev capture).

`prepublishOnly` is an additional safety net for all three public packages:
`runtime` rebuilds the slim bundle with `TSLP_FAIL_ON_REWRITE_WARNING=1` and
runs its full test suite, while `plugin` and `contract` run their full suites.
The root `release:check` remains required for the complete lockstep publish set.

## Publish

Publication is intentionally tied to the clean commit that passed the gate:

```sh
git push origin main
git tag -a v0.1.0-alpha.0 -m "v0.1.0-alpha.0"
git push origin v0.1.0-alpha.0
pnpm release:assert-ready
pnpm release:publish --tag=alpha
```

Use `git tag -s` instead of `git tag -a` when release signing is configured.
The guard requires that exact annotated/signed tag on the current clean `main`
commit and requires local `main` to equal its configured upstream. The publish
guard also verifies that the configured remote already contains the annotated
or signed tag peeled to that exact commit. The publish wrapper reruns the
complete release gate on that tagged commit, regenerates the tracked slim/skill
inputs once more before the first registry write, and fails on any diff. It
pins `https://registry.npmjs.org/`, checks all three live target dist-tags before
any write, overrides scoped registry configuration, verifies the authenticated
publisher's package/scope access, rejects version downgrades, and permits a
partial-release resume only when registry integrity exactly matches the private
checked tarball. It then
publishes those exact `.tgz` bytes in dependency order (contract, runtime,
plugin) and verifies registry integrity and the target tag after every write,
with bounded retries for registry propagation.
The `alpha` dist-tag keeps this prerelease off npm's default `latest` channel.

Do not call `pnpm publish`, `npm publish`, or publish the three package
directories independently. npm publication is not transactional; if a registry
write fails after contract has landed, diagnose and rerun the wrapper from the
same exact version/tag. Its integrity-identical resume path skips or retags
bytes already present instead of repacking them.

After publish:

1. For all three packages, run
   `npm view <package>@<version> version dist.integrity dist.shasum gitHead`
   and independently compare the reported version, integrity, and (when
   exposed) `gitHead` with the saved private-tarball integrity output and tagged
   commit. Also inspect
   `npm view <package> dist-tags`: `alpha` must point to the new version while
   `latest` remains unchanged or absent.
2. Download each registry package with `npm pack <package>@<version> --json`
   and inspect the returned file list. This independently confirms the bytes
   consumers can fetch, instead of trusting only the pre-publication tarball.
3. Scratch-dir smoke:
   ```sh
   mkdir /tmp/tslp-smoke
   cd /tmp/tslp-smoke
   npm init -y
   npm install --save-dev vite@6.4.3 typescript@5.9.3 \
     @types/three@0.185.1 vite-plugin-tsl-precompile@alpha
   npm install three@0.185.1 @tsl-precompile/runtime@alpha
   ```
   Then paste the README quickstart, run `npx vite` once, commit the artifact,
   and run `npx vite build`. Both should succeed.

## Promote an alpha to stable

Promotion is a new lockstep release, not a retag of prerelease package bytes:

1. Choose the stable version, normally `0.1.0`, and set it in all three public
   package manifests. Change their prerelease `publishConfig.tag` from `alpha`
   to `latest` in the same reviewed commit. Update every consumer install
   command in the root/package READMEs, BYO guide, migration guide,
   announcement, and canonical integration skill from `@alpha` to the stable
   channel (untagged or explicit `@latest`), then run
   `pnpm --filter vite-plugin-tsl-precompile prepack` to synchronize the
   packaged skill.
2. Finalize the changelog and run `pnpm release:check` again from a clean
   `main` checkout.
3. Push `main`, create and push the annotated/signed `v0.1.0` tag on that
   checked commit, then run `pnpm release:publish --tag=latest`.
4. After publication succeeds, verify that `latest` points to `0.1.0` for all
   three packages. The old `alpha` tag may remain for
   reproducibility or be removed after alpha users have migrated.

## Inspector panel + site

`@tsl-precompile/inspector-panel` (still `0.0.0`) and `@tsl-precompile/site`
stay unpublished until they have their own release stories. They are
referenced from the `runtime` (optional dynamic import) and the docs site
respectively; nothing in the publish set requires them.
