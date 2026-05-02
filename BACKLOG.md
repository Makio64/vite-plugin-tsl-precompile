# Backlog

A flat, deduplicated list of every open problem/feature gap. Structured so
multiple agents (human or AI) can pick items without colliding on files. See
[MULTI_AGENT.md](./MULTI_AGENT.md) for the parallel-agent workflow.

Each task lists:
- **ID** — short stable handle (`bg-blur`, `lights`, etc.).
- **Files** — paths the task is expected to touch. **If two tasks share a
  file, run them sequentially**, not in parallel.
- **Why** — what the user sees today and the suspected root cause.
- **Done when** — concrete checkable outcome.
- **Reference** — examples that exercise the bug.

Pri legend: **P0** breaks rendering, **P1** wrong output, **P2** correctness/polish, **P3** nice-to-have.

> Round 1 landed 11 tasks. Round 2 landed 5 more. Round 3 landed 12 more:
> `hydrator-toneMappingExposure`, `userdata-uniform`, `sprite-flip-y`,
> `compute-kernel-replay` (harness side), `bg-node-render-pipeline`,
> `lights-ltc-textures`, `storage-texture-3d`, `array-camera-per-cell`,
> `compute-birds-capture-throw`, `mrt-tsl-stub-leak`, `mrt-pass-aux`,
> `backdrop-empty`. Also: `three/tsl → slim-stubs` Vite alias wired.
> See [CONTINUATION_PLAN.md](./CONTINUATION_PLAN.md) for per-agent reports.

---

## Multi-Render-Target (MRT)

### `mrt-fragment-locations` — P2
Materials drawn into a render target with multiple color attachments emit
only `@location(0)` in the captured WGSL. At capture, `compileTSL`'s
warm-up render is unaware of `renderer.setMRT(...)` / `pass.setMRT(...)` /
`material.mrtNode`, so the downstream pipeline is built with N color
targets but the fragment declares one output → WebGPU validation rejects
with "targets[1] writeMask…".

- **Files**: `packages/plugin/src/vendor/compileTSL.js`, `packages/plugin/src/aux-capture.js`, `packages/runtime/src/hydrator.js`, `packages/runtime/src/apply-precompiled.js`
- **Done when**: `webgpu_multiple_rendertargets.html` replay shows the torus side-by-side (color | normal) and no GPU validation error.
- **Reference**: `webgpu_multiple_rendertargets`, `_readback`, `webgpu_mrt`, `webgpu_mrt_mask`.
- **Status**: Agent 12 in progress on branch `agent/mrt-fragment-locations`.

---

## Compute & Storage

### `compute-kernel-replay` — P2 — PARTIALLY DONE
`webgpu_compute_particles` particles were invisible in replay (just the grid
floor renders). The harness side was fixed (Round 3 Agent 4): `computeAsync`
with raw `ComputeNode` now delegates to a lazily-created full `WebGPURenderer`
sharing the same GPU device. Verify that `webgpu_compute_particles` particle
blob renders before closing.

- **Files**: `packages/examples/batch/run-e2e.mjs` (harness done), `packages/runtime/src/precompile-marker.js` (InstancedMesh handling done)
- **Done when**: `webgpu_compute_particles` particle blob renders and `replayBrightFrac > 0.05`.
- **Reference**: `webgpu_compute_particles`, `webgpu_compute_points`, `webgpu_compute_particles_rain`.

---

## Coordination matrix

When two tasks share a file, run them **sequentially**, not in parallel.

| File | Tasks |
|---|---|
| `plugin/src/vendor/compileTSL.js` | `mrt-fragment-locations` |
| `runtime/src/hydrator.js` | `mrt-fragment-locations` (possibly) |
| `runtime/src/apply-precompiled.js` | `mrt-fragment-locations` |
| `examples/batch/run-e2e.mjs` | `compute-kernel-replay` (verify) |

### Round-4 parallel-safe set (after mrt-fragment-locations merges)

1. **`compute-kernel-replay` verification** — run e2e on `webgpu_compute_particles` and close if passing.
2. **Tier-1 PSNR sweep** — `node packages/examples/batch/run-e2e.mjs --limit=30` to measure overall improvement after all Round-3 fixes.
