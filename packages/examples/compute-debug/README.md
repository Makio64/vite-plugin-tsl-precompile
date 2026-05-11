# examples-compute-debug

Tiny WebGPU compute repro scenes for isolating compute-shader / storage-buffer /
storage-texture failures without the larger upstream `webgpu_compute_*` examples.
Ordered simplest first.

Pages (simplest → most complex; the per-page mechanic and its closest upstream
analogue in parentheses):

- `/particles.html` — a storage buffer (`attributeArray`) of particle positions
  advanced by a compute kernel, rendered as `THREE.Points`. The minimal
  compute-buffer → render-attribute path (`webgpu_compute_particles*`).
- `/instanced.html` — an `InstancedMesh` whose per-instance offsets live in a
  storage buffer that a compute kernel orbits each frame (`webgpu_compute_birds`
  — the `compute-instance-mesh-buffer` slice).
- `/texture.html` — a compute kernel writes an animated pattern into a
  `StorageTexture` via `textureStore()`; a plane samples it
  (`webgpu_compute_texture*` — the `compute-storage-texture-sync` slice).
- `/reduce.html` — a compute kernel reduces a storage buffer to a single scalar
  that drives a material uniform (`webgpu_compute_reduce`).

Each render material is marked with `.precompile('compute-debug-<page>')`; the
compute kernels run as raw TSL `ComputeNode`s (the batch harness routes them
through a separate full renderer and syncs storage buffers/textures into slim
during replay — those sync paths are exactly what these scenes exercise).
Motion is driven by the TSL `time` node, which the E2E harness virtualizes so
capture and replay see the same clock.

These are deliberately the *minimal* version of each mechanic — extend a page
toward its upstream analogue (sprite quads, ping-pong buffers, 3D textures,
parallel reductions, …) to bisect where slim replay diverges. As of writing,
`particles` / `instanced` / `texture` replay byte-for-byte (PSNR ∞) and
`reduce` is just under the PSNR gate (~28.6 dB) — a small storage-buffer →
uniform feedback drift between the compute renderer's clock and replay.

Run:

```sh
pnpm --filter examples-compute-debug dev
```

Build (run `dev` once first so `.precompile()` captures the artifacts under
`./artifacts/`, then):

```sh
pnpm --filter examples-compute-debug build
```

Capture and slim-replay E2E:

```sh
pnpm --filter examples-compute-debug test:e2e
```

The E2E runner reuses the batch harness and the `e2e-cases.json` matrix. It
saves capture/replay PNGs under `packages/examples/batch/results/shots/` and
writes `packages/examples/batch/results/compute-debug-e2e-report.json`.

Use `--no-pixel-gate` when you only want to confirm that capture and replay
produce frames:

```sh
pnpm --filter examples-compute-debug test:e2e -- --no-pixel-gate
```

Iterate on a single repro:

```sh
pnpm --filter examples-compute-debug test:e2e -- --filter=texture.html
```
