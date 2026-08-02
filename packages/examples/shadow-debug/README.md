# examples-shadow-debug

Tiny WebGPU shadow repro scenes for isolating shadow failures without the
larger upstream examples.

Each page contains only:

- one floor plane
- one cube
- one sphere
- one shadow-casting light
- plain `MeshStandardNodeMaterial` materials marked with `.precompile()`

Run:

```sh
pnpm --filter examples-shadow-debug dev
```

Build:

```sh
pnpm --filter examples-shadow-debug build
```

The production build uses `slim: 'source'`. Directional and spot VSM pages call
`createPrecompiledShadowSupport()` before the presentation draw, so captured
depth → vertical → horizontal passes run without a full renderer or NodeBuilder.
The direct support entry has no fallback path.

Capture the full light/filter matrix with WebGPU-enabled Chromium before
building. With the dev server running on its configured port:

```sh
pnpm --filter vite-plugin-tsl-precompile recapture \
  --url http://127.0.0.1:5183 \
  --paths 'directional.html?shadow=basic,directional.html?shadow=pcf,directional.html?shadow=pcf-soft,directional.html?shadow=vsm,spot.html?shadow=basic,spot.html?shadow=pcf,spot.html?shadow=pcf-soft,spot.html?shadow=vsm,point.html?shadow=basic,point.html?shadow=pcf,point.html?shadow=pcf-soft,point.html?shadow=vsm' \
  --timeout 60000
```

Generated VSM artifacts are selected by `shadow-vsm-support@1` depth/moments
binding topology. Directional versus spot light, map size, blur radius, and
sample count remain live values and reuse the same family; native WebGPU depth
and compatibility-mode unfilterable-float inputs remain distinct.
WebGL2-fallback selectors are intentionally rejected by production.

`pnpm recapture:examples --example shadow-debug` now builds the source-slim
fixture and previews both Directional and Spot VSM routes before it commits the
new artifact directory. The gate requires a successful captured scheduler
receipt, zero capture requests, no browser/WebGPU failures, and nonblank decoded
pixel evidence.

Capture and slim-replay E2E:

```sh
pnpm --filter examples-shadow-debug test:e2e
```

The E2E runner reuses the batch harness and the `e2e-cases.json` matrix to
exercise directional, spot, and point lights across Basic, PCF, PCF Soft, and
VSM shadow-map modes. It saves capture/replay PNGs under
`packages/examples/batch/results/shots/`, and writes
`packages/examples/batch/results/shadow-debug-e2e-report.json`.
That broad harness still has a full-renderer shadow fallback. Use this package's
source-slim build/preview for the strict compiler-free VSM gate.

Use `--no-pixel-gate` when you only want to confirm that capture and replay
produce frames:

```sh
pnpm --filter examples-shadow-debug test:e2e -- --no-pixel-gate
```

Pages:

- `/directional.html`
- `/spot.html`
- `/point.html`
- `/vsm.html`

The directional, spot, and point pages accept `?shadow=basic`, `?shadow=pcf`,
`?shadow=pcf-soft`, or `?shadow=vsm`.
