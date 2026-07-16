# @tsl-precompile/runtime

Runtime helpers for [`vite-plugin-tsl-precompile`](https://www.npmjs.com/package/vite-plugin-tsl-precompile):
the `material.precompile(name)` marker, the `__applyPrecompiled` helper the
build-time transform calls into, the generated UBO writers, and the slim
three.js bundle entry that ships baked WGSL without the TSL node builder.

## Status

Experimental.

## Install

```sh
pnpm add @tsl-precompile/runtime
```

Peer dep: `three >= 0.184.0`. Pin it to an exact patch. The checked-in slim
bundle currently requires exactly `three@0.184.0`; non-slim and source-slim
capture/build can use newer supported versions after recapturing artifacts.

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
`.precompile('name')` call to `__applyPrecompiled(...)`. The conditional
`/setup` entry resolves to a tiny no-op, so the development marker, auxiliary
capture code, broad Three namespace, TSL graph, and node builder are not part
of the production closure.

The entry uses Vite's standard `development|production` export condition. If
you override `resolve.conditions`, retain that condition; the package default
intentionally selects the production no-op so unknown bundlers fail closed.

`setupPrecompile()` accepts:

| Option | Description |
|---|---|
| `renderer` | The `WebGPURenderer` instance — pass it before or after `init()`. |
| `three` | Optional advanced namespace override. The active `three/webgpu` namespace is injected automatically. |
| `devEndpoint` | Dev capture URL. Defaults to `'/__tsl-precompile/capture'` (the plugin's endpoint). |
| `aux` | `true` or an opts object to also enable `captureAux()` for auxiliary passes (background, post-process, lights). Requires `scene` + `camera`. |
| `scene`, `camera` | Required only when `aux` is truthy. |

Returns `{ ready, captureAux, setRenderer }`. `captureAux(extraOpts)` merges
per-call options into the setup-level `aux` object, which is useful when a
project creates pass nodes after startup.

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

## Slim Support

The supported production mode for v0.1+ is **slim + opt-in full-renderer
fallback**. For new Vite apps, the preferred primary renderer is the guarded
`slim: 'source'` profile; its checked minimal and advanced fixtures measure
138,279 and 145,910 bytes gzip-9. Features that still need live TSL compilation
boot a full `WebGPURenderer` on the **same `GPUDevice`** and share GPU
textures/buffers back into slim.

| Feature | Compiler-free path | Explicit fallback for uncaptured/live work |
|---|---|---|
| Compute kernels | Proven storage-buffer kernels replay from signed artifacts | Full renderer dispatches hybrid-required kernels; contracted writable outputs sync back |
| Shadow maps | Captured signed shadow families replay exact depth artifacts | Shared-device renderer handles a family not represented by a supported capture |
| PMREM | Captured PMREM/cube-conversion artifacts and cached textures replay directly | Full `PMREMGenerator` performs genuinely new runtime filtering |
| Pass/effect WGSL | Captured pass and effect execution plans replay directly | Full renderer produces an uncaptured dynamic pass and shares its texture |
| Clipping context | Captured planes and ancestry are applied by generated writers | A topology outside the signed artifact fails closed until recaptured |
| WebXR sessions | None in the WebGPU-only slim renderer on Three r184 | Use full Three with `{ forceWebGL: true }`; slim fails before claiming a session |

Apps that enable either plugin slim mode can use the stable
`@tsl-precompile/runtime/slim-support` entry when they need real-app fallback
plumbing: live texture indexing, PMREM caching, compute output sync,
post-processing replay, pass render fallback, or a full `WebGPURenderer` on
the same `GPUDevice` for non-precompiled materials.

```js
import { createSlimSceneSupport } from '@tsl-precompile/runtime/slim-support';

const support = createSlimSceneSupport( {
	renderer: slimRenderer,
	loadThreeFullModule: () => import( 'virtual:tsl-precompile/full-three' ),
	fullRendererFallback: true, // opt-in; omit for pure-slim PBR-only apps
} );

support.indexScene( scene );
await support.getFullRenderer(); // lazy boot on shared GPUDevice
```

The Vite plugin aliases `three/webgpu` to slim only during production builds;
dev keeps full three.js so shader capture works. In production, import the
fallback namespace lazily through `virtual:tsl-precompile/full-three` as above. That
virtual entry resolves directly to the consumer's physical full WebGPU entry
and bypasses the slim alias. Passing the slim namespace or a slim-marked
constructor to the fallback throws a configuration error.

Choose `slim: 'source'` for new Vite apps when the application bundler should
discard unused Three and runtime exports. Choose `slim: true` for the checked,
single-file prebuilt renderer (currently 211,646 bytes gzip-9). The guarded
source entry cannot be imported without the plugin, verifies the plugin/runtime
slim-policy revision, and rejects final
chunks that retain compiler, stock replay-owned, retained Three Node/TSL, or
split bare-Three identity modules. Capture and build
must use the same exact Three patch in both modes.

`ensureFallback()` also patches slim `renderer.compute(rawComputeNode)` so raw
TSL compute is dispatched by the full renderer on the shared `GPUDevice`, then
storage outputs are synced back into slim. For renderer-owned lighting systems
such as tiled lighting, call this before the slim render:

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

	// Used by the build-time rewrite
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

Subpath entries: `@tsl-precompile/runtime/core`, `/writers`, `/marker`,
`/apply`, `/loader`, `/slim-support`, `/slim`, `/slim-stubs`.

`/core` combines only artifact application, the user-artifact registry, and
the uniform writers for advanced AOT integrations. Plugin-generated modules
continue to import the narrower `/apply`, `/loader`, and `/writers` entries so
applications do not pay for unused parts of the combined convenience surface.
The `/apply` entry selects the shared artifact-schema validator in development;
production retains the artifact-hash and source-graph freshness checks without
shipping the schema registry.

## More

Full project story, adoption modes (`autoMark`, `slim`), troubleshooting,
and the live coverage matrix:
**https://github.com/Makio64/vite-plugin-tsl-precompile**

## License

[MIT](https://github.com/Makio64/vite-plugin-tsl-precompile/blob/main/LICENSE)
