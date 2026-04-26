# @tsl-precompile/site

Landing site for [`vite-plugin-tsl-precompile`](../plugin/).

Vanilla Vite + HTML/CSS/JS. The hero background is a TSL `NodeMaterial` on WebGPU (pure three.js — the plugin itself is not registered here, since the site has no `.precompile()` calls in its own source). Falls back to a CSS gradient on non-WebGPU browsers.

## Develop

```sh
pnpm dev:site           # from repo root
pnpm --filter @tsl-precompile/site dev   # or directly
```

## Build

```sh
pnpm build:site
```

Production output goes to `packages/site/dist/`. GitHub Actions ([.github/workflows/deploy-site.yml](../../.github/workflows/deploy-site.yml)) builds and deploys it to GitHub Pages on every push to `main`.
