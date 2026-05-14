# preview-smoke

Playwright smoke for the production-preview pipeline. Builds an example with `vite build`, spawns `vite preview`, drives Chromium under Vulkan/SwiftShader, and asserts:

1. Canvas has non-trivial pixel content (≥ 50% non-zero bytes in the scene region) — guards against blank-canvas regressions.
2. Two frames captured ~3s apart differ by ≥ 5% — guards against frozen-frame regressions.
3. Zero `pageerror` events — guards against silent runtime crashes.

## Running locally

```
pnpm --filter examples-preview-smoke test:preview
```

Defaults to `--example=ocean`. Override with `--example=getting-started` when other examples are wired up.

## Adding a new example

Pass `--example=<name>`. Requires `pnpm --filter examples-<name> build` and `pnpm --filter examples-<name> preview` to work.

## CI

Wired into [`.github/workflows/ci.yml`](../../../.github/workflows/ci.yml) as the `preview-smoke-ocean` job. Runs on every PR. If hosted-runner WebGPU flake materializes, demote to a scheduled workflow.
