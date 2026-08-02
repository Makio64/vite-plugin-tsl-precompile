# preview-smoke

Playwright smoke for the production-preview pipeline. Builds an example with `vite build`, spawns `vite preview`, drives Chromium under Vulkan/SwiftShader, and asserts:

1. The render canvas PNG decodes to finite RGBA samples with meaningful RGB, luminance, and background-relative content variation — guards against blank or uniform canvases.
2. Two decoded canvas frames have a minimum changed-pixel fraction and mean RGB delta — guards against frozen-frame regressions.
3. Zero `pageerror` events — guards against silent runtime crashes.

## Running locally

```
pnpm --filter examples-preview-smoke test:preview
```

Defaults to `--example=ocean`. Override with `--example=getting-started` when other examples are wired up.

## Adding a new example

Pass `--example=<name>`. Requires `pnpm --filter examples-<name> build` and `pnpm --filter examples-<name> preview` to work.

## CI

Wired into [`.github/workflows/ci.yml`](../../../.github/workflows/ci.yml) as
part of the `example-production` job, alongside batch diagnostics, the
non-visual example builds, and the showcase preview smoke. Runs on every PR.
