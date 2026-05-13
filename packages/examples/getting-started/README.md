# getting-started — tsl-precompile

The smallest possible app using `vite-plugin-tsl-precompile`:

- one renderer, one scene, one lit `MeshStandardNodeMaterial`
- one `.precompile('getting-started')` marker
- the new `setupPrecompile()` helper — no hand-wired
  `installPrecompileMarker` / `setDevRenderer` / ordering footgun

## Run

```sh
pnpm install   # from the repo root, once
pnpm --filter examples-getting-started dev
# → opens http://localhost:5174
```

The first dev run captures `./artifacts/getting-started.<hash>.json`.
Commit it so the build step has something to bake.

```sh
pnpm --filter examples-getting-started build
pnpm --filter examples-getting-started preview
```

## Refreshing the artifact

The artifact's hash is keyed on the TSL graph **and** the installed three.js
version. Re-run `dev` to refresh it after either:

- changing the `material.colorNode` expression, or
- bumping `three` in `package.json`.

The plugin's build will fail with "no artifact for 'getting-started'" or a
hash-mismatch warning if the committed artifact is stale.
