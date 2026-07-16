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

The production build uses `slim: 'source'`: its checked artifacts hydrate the
scene, shadow-depth, and renderer-output programs without shipping NodeBuilder.
Capture the full light/filter matrix with WebGPU enabled before replacing those
artifacts; WebGL2-fallback selectors are intentionally rejected by the
production runtime.

Capture and slim-replay E2E:

```sh
pnpm --filter examples-shadow-debug test:e2e
```

The E2E runner reuses the batch harness and the `e2e-cases.json` matrix to
exercise directional, spot, and point lights across Basic, PCF, PCF Soft, and
VSM shadow-map modes. It saves capture/replay PNGs under
`packages/examples/batch/results/shots/`, and writes
`packages/examples/batch/results/shadow-debug-e2e-report.json`.

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
