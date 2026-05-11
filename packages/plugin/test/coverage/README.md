# Coverage matrix (Phase 5)

Every (material class × TSL node kind × pipeline context) cell lives here as one fixture.

**v1 release gate:** 100% of cells either pass or throw a documented error at `.precompile()` time.

## Axes

**Material class** — MeshStandard, MeshBasic, MeshPhysical, ShadowNodeMaterial, LineBasic, PointsNodeMaterial, SpriteNodeMaterial, custom-via-NodeMaterial.

**TSL node kind** — every kind surfaced by `src/vendor/extractUniformPlan.js` (camera.*, material.*, uniform.live, worldMatrixInverse, object.*, time, deltaTime, frameId, etc.) plus every `Fn()` output kind.

**Pipeline context** — standalone material, inside RenderPipeline.outputNode, inside ComputeNode, as scene.backgroundNode, as scene.overrideMaterial.

## Fixture format

Each cell is a single `.test.js` that:

1. Builds a minimal scene + material exercising the cell.
2. Runs `extractMaterial()` from the Node harness.
3. Asserts the produced uniformPlan contains the expected `source.kind`.
4. Feeds that plan through `emitUpdaterSource()` and asserts `unsupportedKinds` is empty.
5. (Eventually) pixel-diffs the replayed render against the live full-bundle render.

## Current test files

| File | Axis | Notes |
|---|---|---|
| `materials.test.js` | Material class | 12 stock NodeMaterial classes — all pass, PointsNodeMaterial logs 3 `uniform.live` blocked |
| `camera-kinds.test.js` | TSL node kind — camera | projectionMatrix, viewMatrix, position, near/far |
| `material-kinds.test.js` | TSL node kind — material | color, emissive/opacity, metalness/roughness, clearcoat/sheen physical kinds, line/dash scalars |
| `object-kinds.test.js` | TSL node kind — object | worldMatrix, normalMatrix, modelViewMatrix, worldMatrixInverse |
| `time-kinds.test.js` | TSL node kind — time | time, deltaTime, frameId |
| `uniform-kinds.test.js` | TSL node kind — uniform | uniform.constant (f32/vec3/color/mat4), uniform.live (property path), light.shadow* matrix/scalars |
| `pipeline-contexts.test.js` | Pipeline context | standalone mesh, RenderPipeline.outputNode, live-uniform (shadow-like) |
| `artifact-texture-snapshot.test.js` | Texture binding | `artifact.texture` sources include bounded static DataTexture snapshots |
| `depth-texture-binding.test.js` | Texture binding | `depth.texture` extractor tagging and hydrator rebinding from fallback to live shadow maps |
| `light-shadow-live.test.js` | Live light/shadow state | `light.shadow*` and `light.colorScaled` stay live through generated updaters |
| `points-live-scale.test.js` | Renderer live state | PointsNodeMaterial scale maps to `renderer.halfHeight` |
| `material-pbr-maps.test.js` | Material texture maps | PBR material map/lightMap/displacementMap bindings are extracted |
| `blocked-kinds.test.js` | Documented blocked kinds | every `DOCUMENTED_BLOCKED_KINDS` entry reports `severity: 'blocked'` if it is misrouted into UBO codegen |
| `kind-drift.test.js` | Drift detector | asserts every extractor kind is handled or documented-blocked; asserts no stale updater cases |

## Remaining Coverage Gaps

Documented-blocked source kinds have structural coverage in `blocked-kinds.test.js`. The remaining gap is richer positive fixtures that construct real source materials for the hardest texture/rebinder paths and assert the extracted `uniformPlan` entry:

- `viewport.texture` — needs a transmission/viewport material fixture
- `reflector.texture` — needs a reflector material fixture
- compute storage buffers — covered as `storageBuffers[]` plan entries, but still needs a dedicated compute material fixture
- `uniform.live` (extractor-produced, no property) — surfaced by `materials.test.js`; add a dedicated fixture that asserts the blocked snapshot fallback directly

## What's still missing

5. Fixture-local pixel replay is still missing. The batch E2E harness (`packages/examples/batch/run-e2e.mjs`) now enforces PSNR by default, but these coverage tests are still static extractor/codegen/hydrator fixtures.
