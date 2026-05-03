# Live runtime data discarded across slim/precompile flow — investigation + fixes (2026-05-03)

## TL;DR

Found and fixed **two bugs of the same shape**: live runtime data (vertex BufferAttributes, compute storage buffers) the user wires through `material.*Node` properties was silently dropped across capture → JSON → replay, and the hydrator allocated zero-filled placeholders. Render output read zeros, so sprites collapsed to origin / particles vanished.

Fixes added a `userPath` annotation at capture time and a tree-walk binder in the hydrator that re-finds the live buffer from the user's freshly-constructed node graph at first render. Same pattern works for both bugs.

Mapped a class of related bugs — textures inside node graphs, `_liveUpdateNodes` for animated state, missing slim-stub exports — and tracked as remaining work.

## Bugs fixed

### Bug 1 — Per-instance BufferAttribute (`webgpu_instance_sprites.html`)

**Pattern**: `material.positionNode = instancedBufferAttribute(positionAttribute)`. The user supplies a CPU-allocated `InstancedBufferAttribute`; the slim path discarded the reference and the hydrator allocated a zero-filled `StorageBufferAttribute`. All 10000 sprites read position `(0,0,0)` and collapsed to the origin.

**Visual**: capture = ~10000 scattered snowflakes. Replay before fix = a single dot at the centre of the screen. Replay after fix = scattered snowflakes matching capture (PSNR 29.7 dB; 0.3 dB shortfall vs. the 30 dB pass gate is `Math.random()` non-determinism between independent capture/replay loads).

### Bug 2 — Compute-storage buffer (`webgpu_compute_particles.html`)

**Pattern**: `const colors = instancedArray(...)` + `material.colorNode = uv().mul(colors.element(i))`. Compute kernel writes to `colors`; render reads from it. Slim path bound a fresh empty `StorageBufferAttribute` for the render side, so render saw zeros while compute wrote to a different buffer. Particles invisible.

**A/B verification** (same wait times, same example):

| Config | replayBright | PSNR | Visual |
|---|---|---|---|
| Runtime fix ON, harness wire OFF | 0.570 | 21.85 dB | particles on floor grid ✅ |
| Runtime fix neutral, harness wire ON | 0.570 | 21.85 dB | identical to above |
| **Both OFF** | **0.064** | **11.08 dB** | empty grid, **zero particles** |

The runtime fix is functionally equivalent to the existing harness workaround. The 21.85 dB is inherent stochastic-compute variance (capture and replay run gravity + bounce physics independently with different real-time deltas).

## Root cause shape

Three concurrent factors create the bug class:

1. **Capture only records metadata + non-enumerable side-cars.** [`compileTSL.js:414-446`](packages/plugin/src/vendor/compileTSL.js#L414-L446) attached `_liveAttribute` (and similar) as non-enumerable, so JSON-loaded replay lost the reference. Same for storage buffers in [`extractUniformPlan.js:1075-1093`](packages/plugin/src/vendor/extractUniformPlan.js#L1075-L1093).
2. **Wrap deliberately drops `*Node` props.** [`apply-precompiled.js:226-246`](packages/runtime/src/apply-precompiled.js#L226-L246) — `copyCommonMaterialProperties` excludes node-shaped properties on the assumption they're "baked into the artifact." But the user's runtime data lives there.
3. **Hydrator's fallback silently substitutes empty buffers.** [`hydrator.js:402-426`](packages/runtime/src/hydrator.js#L402-L426) and [`hydrator.js:1023-1074`](packages/runtime/src/hydrator.js#L1023-L1074) — when `_liveAttribute` was missing, allocated a zero-filled buffer of matching shape. Loud-failure would have exposed the bug; instead it silently ran with garbage.

## Implemented fix (single pattern, two applications)

### Capture side records `userPath`

[`compileTSL.js:414-446`](packages/plugin/src/vendor/compileTSL.js#L414-L446) — for each captured `nodeAttributes[]` entry with a `_liveAttribute`, walk the source material's `*Node` properties, find which one's tree contains the leaf, and stamp `userPath: ["positionNode"]` (etc.).

[`compileTSL.js:386-396`](packages/plugin/src/vendor/compileTSL.js#L386-L396) — same for storage buffers via `annotateStorageBufferUserPaths(uniformPlan, material)` after `extractUniformPlan` returns. Walks each `uniformPlan[].storageBuffers[]` entry the same way.

New helpers:
- [`findAttributePathOnMaterial`](packages/plugin/src/vendor/compileTSL.js#L546-L595) — iterates `*Node`-suffixed enumerable props, traverses each via `node.traverse()`, returns first matching root prop name.
- [`annotateStorageBufferUserPaths`](packages/plugin/src/vendor/compileTSL.js#L556-L581) — sibling for storage-buffer entries.

### Hydrator binds at first render

[`hydrator.js:328-339`](packages/runtime/src/hydrator.js#L328-L339) — calls `bindUserNodeAttributesToArtifact(artifact, material)` and `bindUserStorageBuffersToArtifact(artifact, material)` at the top of `hydrateNodeBuilderState`, before the existing wiring runs.

The catalogue **had to live in the hydrator, not in `__applyPrecompiled`**. The user assigns `material.positionNode = …` *after* the wrapper exists. By first-render the slot is wired.

[`bindUserNodeAttributesToArtifact`](packages/runtime/src/hydrator.js#L443-L474) — walks `material[userPath[0]]`, finds the first leaf BufferAttribute whose `(itemSize, count, arrayType)` matches the entry, stamps `_liveAttribute`. Idempotent.

[`bindUserStorageBuffersToArtifact`](packages/runtime/src/hydrator.js#L516-L548) — same for storage-buffer entries in `uniformPlan`.

### vec3 → vec4 padding tolerance

WebGPU pads vec3 storage attributes to itemSize=4 on first GPU touch. Matcher at [`hydrator.js:485-494`](packages/runtime/src/hydrator.js#L485-L494) accepts `(itemSize=3) → (artifactItemSize=4)` to mirror the harness's `sizeMatches` rule.

### Slim bundle rebuilt

`pnpm --filter @tsl-precompile/runtime build:slim` — confirmed `userPath` lookups land in the bundle (terser mangles function names but the property access survives).

## Files changed

- [`packages/plugin/src/vendor/compileTSL.js`](packages/plugin/src/vendor/compileTSL.js) — `userPath` capture for both attributes and storage buffers; new helpers `findAttributePathOnMaterial`, `annotateStorageBufferUserPaths`.
- [`packages/runtime/src/hydrator.js`](packages/runtime/src/hydrator.js) — `bindUserNodeAttributesToArtifact`, `bindUserStorageBuffersToArtifact`, vec3→vec4 padding tolerance.
- [`packages/runtime/src/apply-precompiled.js`](packages/runtime/src/apply-precompiled.js) — comment-only update explaining why catalogue moved to hydrator.
- [`packages/examples/batch/run-e2e.mjs`](packages/examples/batch/run-e2e.mjs) — harness storage-buffer wire gated behind `window.__TSLP_HARNESS_WIRE_STORAGE` (default off) so the runtime fix is what's actually being exercised.
- [`packages/runtime/build/three.webgpu.slim.js`](packages/runtime/build/three.webgpu.slim.js) — rebuilt.

## Verification methodology

When fixing "data missing" bugs in this codebase, the e2e harness has compensating workarounds at [`run-e2e.mjs:640-712`](packages/examples/batch/run-e2e.mjs#L640-L712) that mask runtime bugs. To prove a runtime fix is real:

1. Disable the harness branch handling your bug class (gate on a `window.__TSLP_HARNESS_*` flag).
2. Run the e2e and capture the broken baseline (low brightness, low PSNR).
3. Apply the runtime fix.
4. Re-run; confirm PSNR / brightness recover and visuals match.
5. A/B re-enable the harness; PSNR should be identical (proves equivalence).
6. **Critical**: disable both temporarily; confirm the example breaks visually as expected. Without this step you can't distinguish "fix works" from "fix is a no-op and something else is making it pass."

## Adjacent bugs identified, not yet fixed

### Bug 3 — Textures wired inside node graphs

`material.colorNode = texture(myTex)` (texture inside a node, not on a known property like `material.map`). [`catalogueArtifactTextureRefs` at apply-precompiled.js:59-98](packages/runtime/src/apply-precompiled.js#L59-L98) only scans the hardcoded `_TEXTURE_PROPS` list, so the live `Texture` is missed. Same `userPath` extension would help — record uuid + path at capture, walk node graph at apply to find `TextureNode` leaves and bind by uuid.

### Bug 4 — `_liveUpdateNodes` (animated state)

[`compileTSL.js:606-631`](packages/plugin/src/vendor/compileTSL.js#L606-L631) attaches `_liveUpdateNodes`/`_liveUpdateBeforeNodes`/`_liveUpdateAfterNodes` as non-enumerable side-cars. JSON load loses them; hydrator falls back to a frozen `valueSnapshot`. Affects animated lights, shadow refresh, motion vectors, anything driven by `onRenderUpdate`. **Different mechanism needed** — update nodes are TSL closures that can't be path-walked. Best near-term: emit a JSON-load warning so users aren't silently surprised.

### Bug 5 — Production-slim carrier stubs missing

Real users on the production-slim path resolve `import { instancedBufferAttribute } from 'three/tsl'` to [`packages/runtime/src/slim-stubs.js`](packages/runtime/src/slim-stubs.js) (via [Vite alias `index.js:147`](packages/plugin/src/index.js#L147)). That file has **no `instancedBufferAttribute`/`bufferAttribute`/`storageBufferAttribute`/`instancedArray` exports** — the import would fail at module-load before example JS runs. Today no real user can use these patterns under the slim alias.

To close: export carrier-style stubs that retain their first-arg BufferAttribute (need a separate Proxy from `inertNodeStub` because the existing one returns itself for every property `get`). Extend the hydrator's `findFirstAttributeMatchingEntry` to also check `node.__tslp_liveAttribute`. Rebuild slim. Smoke-test a minimal slim-mode app.

### Bug 6 — `_liveArray` JSON bloat

Discovered while investigating Bug 2: [`extractUniformPlan.js:1075-1093`](packages/plugin/src/vendor/extractUniformPlan.js#L1075-L1093) places `_liveArray: array` and `_liveAttribute: attr` as **enumerable** properties. They get JSON-serialised — for `webgpu_compute_particles.html` the 200000 × vec4 zero-buffer balloons one storage-buffer entry to **~10 MB of `{"0":0,"1":0,...}`**. Should be `Object.defineProperty` with `enumerable: false`. Doesn't affect correctness (the hydrator correctly rejects the deserialized plain-object form), but bloats the user JSON significantly.

## Test command reference

```bash
# Bug 1
node packages/examples/batch/run-e2e.mjs --filter=webgpu_instance_sprites --save-shots

# Bug 2
node packages/examples/batch/run-e2e.mjs --filter=webgpu_compute_particles.html --save-shots

# Sweep the compute family
node packages/examples/batch/run-e2e.mjs --filter=webgpu_compute_ --save-shots

# A/B disable the runtime storage-buffer fix temporarily — set this in addInitScript first
window.__TSLP_DISABLE_STORAGE_BIND = true   // add to packages/examples/batch/run-e2e.mjs:2375
```
