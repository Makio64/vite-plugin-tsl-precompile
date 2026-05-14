# pbr-shadows

PBR sphere on a ground plane, lit by a shadow-casting directional light. Two `MeshStandardNodeMaterial` instances are marked with `.precompile()` — one for the sphere, one for the ground — to show that markers compose cleanly across multiple materials in the same scene.

This is the closest template to the "ordinary three.js + WebGPU app" shape: standard PBR + direct lights + shadows.

## Run it

```sh
pnpm install
pnpm dev
```

First run captures both materials to `./artifacts/`:
- `./artifacts/sphere.<hash>.json`
- `./artifacts/ground.<hash>.json`

Commit those, then `pnpm build && pnpm preview` to ship the precompiled WGSL.

## What this demonstrates

- **Multiple markers in one scene.** Each material gets its own artifact filename. Names are stable across refactors.
- **Shadow-casting lights.** `sun.castShadow = true` is part of the captured scene; the runtime hydrator handles `light.shadow.map` rebinding per frame.
- **No TSL author-code.** This example uses standard three.js material constructor options — no `material.colorNode = ...`. The plugin still captures the WGSL emitted by three.js's TSL builder for these materials.

If you're starting from scratch, this is the template to copy.
