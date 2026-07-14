# getting-started — tsl-precompile

The smallest possible app using `vite-plugin-tsl-precompile`:

- one renderer, one scene, one lit `MeshStandardNodeMaterial`
- one `.precompile('getting-started')` marker
- compiler-free, application-tree-shaken `slim: 'source'` production
- the new `setupPrecompile()` helper — no hand-wired
  `installPrecompileMarker` / `setDevRenderer` / ordering footgun

## Run

```sh
pnpm install   # from the repo root, once
pnpm --filter examples-getting-started dev
# → opens http://localhost:5174
```

The first dev run captures `./artifacts/getting-started.<hash>.json` and, after
the first successful real render, one `aux-render-output-<hash>.json`. The
second artifact is the exact tone-mapping/color-space output material that
three.js normally builds internally. Slim mode deduplicates that topology and
would capture another output artifact if the renderer later changed tone
mapping, color space, sampled-texture dimension, or multiview. It does not
sweep backgrounds, shadows, PMREM, or passes. Commit the captured files so the
build step has everything needed for compiler-free replay.

```sh
pnpm --filter examples-getting-started build
pnpm --filter examples-getting-started preview
```

## Refreshing the artifact

The artifact's hash is keyed on the TSL graph **and** the installed three.js
version. Re-run `dev` to refresh it after either:

- changing the `material.colorNode` expression, or
- bumping `three` in `package.json`, or
- exercising a new renderer output topology such as another tone mapping or
  output color space.

The plugin's build will fail with "no artifact for 'getting-started'" or a
hash-mismatch warning if the committed artifact is stale.
