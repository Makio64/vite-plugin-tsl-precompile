# @tsl-precompile/site

Landing site and generated compatibility browser for [`vite-plugin-tsl-precompile`](../plugin/).

Vanilla Vite + HTML/CSS/JS. The overview and explainer intentionally use CSS-only product visuals, so the marketing shell does not download Three.js for decoration. The evidence page loads stock Three.js only when a visitor explicitly runs its WebGPU cold-path explorer.

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

The build also runs a content guard that checks the multi-page output, GitHub Pages-safe navigation, working quickstart, generated evidence fallbacks, social metadata, and the overview's no-Three.js dependency boundary.
