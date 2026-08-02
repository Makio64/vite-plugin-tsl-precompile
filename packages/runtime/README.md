# @tsl-precompile/runtime

Runtime helpers for [`vite-plugin-tsl-precompile`](https://www.npmjs.com/package/vite-plugin-tsl-precompile):
the `material.precompile(name)` marker, the `__applyPrecompiled` helper the
build-time transform calls into, the generated UBO writers, and the slim
three.js bundle entry that ships baked WGSL or GLSL without the TSL node builder.

## Status

Experimental.

## Install

```sh
pnpm add @tsl-precompile/runtime@alpha
```

TypeScript projects must install the matching declarations:

```sh
pnpm add -D @types/three@0.185.1 --save-exact
```

The required peer is exactly `three@0.185.1`. `@types/three@0.185.1` is an
optional peer for JavaScript consumers and required for TypeScript projects.
Supporting another Three patch requires the documented re-vendoring,
compatibility validation, and artifact recapture workflow before widening or
changing this boundary.

## Use

One call wires the marker + dev-capture renderer, with no init() ordering
footgun:

```js
import { WebGPURenderer, MeshStandardNodeMaterial, Scene, PerspectiveCamera, Mesh, SphereGeometry } from 'three/webgpu';
import { setupPrecompile } from '@tsl-precompile/runtime/setup';

const renderer = new WebGPURenderer();
const setup = setupPrecompile( { renderer } );
await renderer.init();
await setup.ready;          // ← registers this renderer with the marker

const material = new MeshStandardNodeMaterial();
// …configure colorNode…
material.precompile( 'my-material' );

const scene = new Scene();
const camera = new PerspectiveCamera();
scene.add( new Mesh( new SphereGeometry(), material ) );
renderer.setAnimationLoop( () => renderer.render( scene, camera ) );
```

The marker queues capture until the material appears in a real render. This is
required for correct light/shadow, camera, object, geometry, clipping, and MRT
shader variants. A one-shot app may instead provide the complete context:

```js
material.precompile( 'my-material', { scene, camera, object: mesh } );
```

When the same scene is rendered by multiple renderer configurations, include
the exact renderer so deferred capture cannot inherit whichever renderer was
registered most recently:

```js
material.precompile( 'my-material-log-depth', { renderer, scene, camera, object: mesh } );
```

In a production build the Vite plugin has already rewritten every
`.precompile('name')` call to the apply entry for the configured mode. The
conditional `/setup` entry resolves to a tiny no-op, so the development marker
and auxiliary capture code are not part of the production closure. With
`slim: false`, apply preserves the exact live NodeMaterial and stock Three
compiler while validating/registering passive artifact metadata. Either slim
mode instead adopts the baked native shader source and generated updater, and its guarded build
excludes the TSL graph and node builder.

The entry uses Vite's standard `development|production` export condition. If
you override `resolve.conditions`, retain that condition; the package default
intentionally selects the production no-op so unknown bundlers fail closed.

`setupPrecompile()` accepts:

| Option | Description |
|---|---|
| `renderer` | The `WebGPURenderer` instance — pass it before or after `init()`. |
| `three` | Optional advanced namespace override. The active `three/webgpu` namespace is injected automatically. |
| `devEndpoint` | Dev capture URL. Defaults to `'/__tsl-precompile/capture'` (the plugin's endpoint). |
| `captureRendererOutput` | Automatically capture renderer-output topologies after real renders. Defaults to `true`; use `false` only when the app performs its own named renderer-output captures. |
| `aux` | `true` or an opts object to also enable `captureAux()` for auxiliary passes (background, post-process, lights). Requires `scene` + `camera`. |
| `scene`, `camera` | Required only when `aux` is truthy. |

Returns `{ ready, captureAux, captureStatus, waitForCaptureSettled,
setRenderer }`. `captureAux(extraOpts)` merges per-call options into the
setup-level `aux` object, which is useful when a project creates pass nodes
after startup. For deterministic automation, take a `captureStatus()` snapshot
before rendering and pass it as
`waitForCaptureSettled({ since: snapshot })`; the promise rejects on capture
failure or timeout instead of requiring a guessed delay.

When the Vite plugin is configured with `slim: true` or `slim: 'source'`, the
development setup hook also captures the renderer's output transform after
successful real renders. It keys captures by tone mapping, color space,
sampled-texture dimension, and multiview, so repeated frames deduplicate while
a newly observed topology gets its own artifact. It uses the observed
Scene/Camera only for this mandatory output material and does not trigger the
broader background, shadow, PMREM, or pass capture paths. The production
conditional setup entry remains a compiler-free no-op.

For MRT / RenderPipeline scenes, pass the live `PassNode` when you capture aux
artifacts so the extractor sees the multi-target layout:

```js
const setup = setupPrecompile( { renderer, scene, camera, aux: true } );
await renderer.init();
await setup.ready;

const scenePass = pass( scene, camera ).setMRT( mrt( { output, normal } ) );
renderPipeline.outputNode = scenePass.getTextureNode( 'output' );

await setup.captureAux( { passNode: scenePass, renderPipeline } );
```

If a `RenderPipeline` final quad is authored to render into an offscreen
target, declare that topology explicitly. Capture compiles against a disposable
1x1 clone, so the live target is neither cleared nor disposed:

```js
await setup.captureAux( {
	renderPipeline: colorPipeline,
	renderPipelineTarget: colorTarget,
} );
```

## Standalone compiled compute

A standalone compute graph needs an explicit development capture because it is
not owned by a material. Keep raw graph construction in a development-only
module, name every kernel, and declare its caller-owned resource keys:

```js
import { precompileComputes } from '@tsl-precompile/runtime/compute-capture';

await precompileComputes( renderer, [
	{ name: 'particles-init', node: computeInit, resources: { positions } },
	{ name: 'particles-update', node: computeUpdate, resources: { positions } },
], { scene, camera, three: THREE } );
```

The capture runs all kernels in one extractor transaction and persists signed
`kind: 'compute'` artifacts through the plugin dev endpoint. Production code
imports the generated virtual modules and never imports the raw graph module.

A compute artifact that carries a validated `compute-bindings@1` descriptor
can run without retaining a TSL `ComputeNode` or node builder. Bind its public
keys to resources owned by the application, then dispatch it through the slim
renderer:

```js
import { createPrecompiledComputeRunner } from '@tsl-precompile/runtime/compute';
import * as compiledKernel from 'virtual:tsl-precompile/my-kernel';

const threshold = { value: 0.5 }; // mutable between dispatches
const kernel = createPrecompiledComputeRunner( renderer, compiledKernel, {
	positions,  // StorageBufferAttribute with the exact captured layout
	input,      // Texture; the same key may own its paired sampler
	output,     // StorageTexture with the captured dimension
	threshold,
} );

kernel.dispatch();                    // animation-loop / already-initialized path
await kernel.dispatchAsync( [ 8, 1, 1 ] ); // awaited init + dispatch override

threshold.value = 0.75;
kernel.dispatch();
kernel.dispose();
```

The runner accepts either the raw compute artifact or its generated module
`{ artifact, updateGroup }`. It clones only the bindable artifact records and
attaches generated writers to that local view; emitted artifacts are never
mutated. Buffer and texture identities are fixed for the runner lifetime, and
`dispose()` releases only renderer state for the wrapper node—not caller-owned
resources. Create another runner to replace a buffer or texture object.

Bindings fail closed on missing/unknown keys and on shape mismatches. Storage
attributes must match the captured count, item size, typed-array constructor,
and byte length exactly. In particular, a logical vec3 attribute is not
silently accepted for a contract that records a padded vec4 storage layout.

## Slim Support

The supported production mode for v0.1+ is **slim + opt-in full-renderer
fallback**. For new Vite apps, the preferred primary renderer is the guarded
`slim: 'source'` profile; its checked Three r185 minimal and advanced
regression baselines are 176,256 and 185,490 bytes gzip-9, with enforced caps
of 184,000 and 194,000 bytes. `pnpm analyze:slim` reports the current exact
values. Features that still need live TSL compilation boot a full
`WebGPURenderer` on the **same `GPUDevice`** and share GPU textures/buffers back
into slim.

| Feature | Compiler-free path | Explicit fallback for uncaptured/live work |
|---|---|---|
| Compute kernels | Proven storage-buffer kernels replay from signed artifacts | Full renderer dispatches hybrid-required kernels; contracted writable outputs sync back |
| Shadow maps | Captured depth plus Directional/Spot VSM vertical/horizontal passes replay on slim | Shared-device fallback covers supported non-VSM depth families; point/custom VSM fails closed |
| PMREM | Captured source conversion, blur, and GGX passes run through the compiler-free slim `PMREMGenerator` | Full `PMREMGenerator` is optional for an uncaptured layout |
| Pass/effect shaders | Captured WGSL/GLSL pass and effect execution plans replay directly | Full renderer produces an uncaptured dynamic pass and shares its texture |
| Clipping context | Captured planes and ancestry are applied by generated writers | A topology outside the signed artifact fails closed until recaptured |
| WebXR sessions | Intentionally unavailable in slim on either backend | Use full Three with `{ forceWebGL: true }`; slim fails before claiming a session |

Apps that enable either plugin slim mode can use the stable
`@tsl-precompile/runtime/slim-support` entry for compiler-free PMREM/VSM,
live texture indexing, compute output sync, post-processing replay, or an
optional full `WebGPURenderer` fallback.

```js
import { createSlimSceneSupport } from '@tsl-precompile/runtime/slim-support';

const support = createSlimSceneSupport( {
	renderer: slimRenderer,
	fullRendererFallback: false,
} );

support.indexScene( scene );
const pmremTexture = await support.generatePMREMAsync( environmentTexture );
await support.populateShadowMaps( scene, camera ); // VSM: depth → vertical → horizontal
```

Dev capture must observe the PMREM source layout and a renderer configured for
`VSMShadowMap`. Replay fails closed if those exact internal passes are absent.
`precompileAuxiliary()` discovers texture sources on `scene.background`,
`scene.environment`, scene-level PMREM nodes, and material node graphs. A
`fromScene()` result no longer retains its requested source size, so declare
those layouts explicitly and pass the WebGPU namespace:

```js
import * as THREEWebGPU from 'three/webgpu';

await precompileAuxiliary( renderer, scene, camera, {
	devEndpoint,
	three: THREEWebGPU,
	threeVersion,
	pmremSceneSizes: [ 64 ],
	backgroundName: 'hero-environment',
} );
```

When a bundle contains more than one background graph, bind the live input by
that semantic name in replay instead of relying on shape fallback:

```js
import { bindAuxByName } from '@tsl-precompile/runtime';

bindAuxByName( scene.backgroundNode || scene.background, 'background', 'hero-environment' );
```

Friendly names must be unique within a shape. `findAux()` and
`bindAuxByName()` reject duplicates with `AUX_ARTIFACT_AMBIGUOUS`; bind an
exact config hash with `bindAuxConfig()` when distinct captures intentionally
share a display name.

The precompiled VSM scheduler currently covers non-point lights; point/custom
VSM families return `complete: false` and fail closed. The shared-device shadow
adapter remains available for the non-VSM depth families it explicitly supports.

The Vite plugin aliases `three/webgpu` to slim only during production builds;
dev keeps full three.js so shader capture works. In production, import the
fallback namespace lazily through `virtual:tsl-precompile/full-three` as above. That
virtual entry resolves directly to the consumer's physical full WebGPU entry
and bypasses the slim alias. Passing the slim namespace or a slim-marked
constructor to the fallback throws a configuration error.

Choose `slim: 'source'` for new Vite apps when the application bundler should
discard unused Three and runtime exports. Choose `slim: true` for the checked,
single-file prebuilt renderer (261,600-byte gzip-9 r185 regression baseline;
268,000-byte cap). The guarded
source entry cannot be imported without the plugin, verifies the plugin/runtime
slim-policy revision, and rejects final
chunks that retain compiler, stock replay-owned, retained Three Node/TSL, or
split bare-Three identity modules. Capture and build
must use the same exact Three patch in both modes.

`ensureFallback()` also patches slim `renderer.compute(rawComputeNode)` so raw
TSL compute is dispatched by the full renderer on the shared `GPUDevice`, then
storage outputs are synced back into slim. For renderer-owned tiled or r185
clustered lighting, call this before the slim render. The helper rebuilds their
light-index grids and rebinds the live storage/texture resources:

```js
support.updateRendererLighting( scene, camera );
slimRenderer.render( scene, camera );
```

If your app performs contact-shadow or depth-style offscreen renders with
`scene.overrideMaterial`, call
`support.renderOffscreenOverrideWithFallback( scene, camera )` after the
fallback renderer has been initialized and while the slim renderer's render
target is still bound. The helper renders that target with the full renderer
and shares the resulting color/depth GPU textures back into slim.

### Texture miss diagnostics

When a binding cannot resolve a live texture, the hydrator falls back to a
shape-appropriate 1×1 texture so WebGPU validation still passes. To surface
those misses:

- `globalThis.__TSLP_WARN_TEXTURE_MISS = true` (or `TSLP_WARN_TEXTURE_MISS=1`) — warn once per binding
- `globalThis.__TSLP_STRICT_TEXTURE_MISS = true` (or `TSLP_STRICT_TEXTURE_MISS=1`) — throw instead of falling back (CI / debugging)
## Exports

```js
// Recommended one-call boundary: development capture / production no-op.
import { setupPrecompile } from '@tsl-precompile/runtime/setup';

import {
	// Lower-level pieces (kept stable for advanced callers)
	installPrecompileMarker,
	setDevRenderer,
	clearDevRenderer,
	precompileAuxiliary,

	// Replay apply used by compiler-free slim builds
	__applyPrecompiled,
	PrecompiledMaterial,

	// Artifact registries
	registerArtifact,
	getArtifact,
	registerPrecompiledArtifact,
	registerPrecompiledArtifacts,
	unregisterPrecompiledArtifacts,
} from '@tsl-precompile/runtime';
```

Subpath entries: `@tsl-precompile/runtime/core`, `/compute`, `/writers`,
`/marker`, `/apply`, `/apply/full`, `/aux-registry`, `/loader`,
`/slim-support`, `/slim`, `/slim-stubs`.

`/core` combines the full-Three passive apply path, the user-artifact registry,
and uniform writers for advanced non-slim AOT integrations. Plugin-generated
modules import the narrower mode-owned apply entry, so applications do not pay
for unused parts of this convenience surface. `/apply/full` preserves the live
NodeMaterial/compiler and validates/registers the artifact. `/apply` is the
slim replay path; its development condition adds the shared artifact-schema
validator, while production retains artifact-hash and source-graph freshness
checks without shipping the schema registry. `/aux-registry` is the narrow
generated-code registration entry used by full-Three auxiliary metadata.

## More

Full project story, adoption modes (`autoMark`, `slim`), troubleshooting,
and the live coverage matrix:
**https://github.com/Makio64/vite-plugin-tsl-precompile**

## License

[MIT](https://github.com/Makio64/vite-plugin-tsl-precompile/blob/main/LICENSE)
