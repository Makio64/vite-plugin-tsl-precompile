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
| `material-kinds.test.js` | TSL node kind — material | color, emissive/opacity, metalness/roughness, clearcoat/sheen physical kinds |
| `object-kinds.test.js` | TSL node kind — object | worldMatrix, normalMatrix, modelViewMatrix, worldMatrixInverse |
| `time-kinds.test.js` | TSL node kind — time | time, deltaTime, frameId |
| `uniform-kinds.test.js` | TSL node kind — uniform | uniform.constant (f32/vec3/color/mat4), uniform.live (property path) |
| `pipeline-contexts.test.js` | Pipeline context | standalone mesh, RenderPipeline.outputNode, live-uniform (shadow-like) |
| `artifact-texture-snapshot.test.js` | Texture binding | `artifact.texture` sources include bounded static DataTexture snapshots |
| `depth-texture-binding.test.js` | Texture binding | `depth.texture` extractor tagging and hydrator rebinding from fallback to live shadow maps |
| `light-shadow-live.test.js` | Live light/shadow state | `light.shadow*` and `light.colorScaled` stay live through generated updaters |
| `points-live-scale.test.js` | Renderer live state | PointsNodeMaterial scale maps to `renderer.halfHeight` |
| `material-pbr-maps.test.js` | Material texture maps | PBR material map/lightMap/displacementMap bindings are extracted |
| `kind-drift.test.js` | Drift detector | asserts every extractor kind is handled or documented-blocked; asserts no stale updater cases |

## Blocked-kind coverage gaps (Phase 5.5 todo)

These documented-blocked kinds have no positive test fixture yet — meaning there is no test that constructs a material that actually emits them and asserts the correct `severity: 'blocked'` output:

- `builtin.dfgLUT` — needs a PBR material with envMap assigned in the Node harness
- `viewport.texture` — needs a transmission/viewport material fixture
- `reflector.texture` — needs a reflector material fixture
- `storage.buffer` — needs a compute material
- `uniform.live` (extractor-produced, no property) — already surfaced by `materials.test.js` PointsNodeMaterial; add a dedicated fixture

## What's still missing

5. Fixture-local pixel replay is still missing. The batch E2E harness (`packages/examples/batch/run-e2e.mjs`) now enforces PSNR by default, but these coverage tests are still static extractor/codegen/hydrator fixtures.
