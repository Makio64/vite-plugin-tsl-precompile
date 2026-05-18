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

Peer dep: `three >= 0.184.0`.

## Use

One call wires the marker + dev-capture renderer, with no init() ordering
footgun:

```js
import * as THREE from 'three/webgpu';
import { WebGPURenderer, MeshStandardNodeMaterial } from 'three/webgpu';
import { setupPrecompile } from '@tsl-precompile/runtime';

const renderer = new WebGPURenderer();
const setup = setupPrecompile( { three: THREE, renderer } );
await renderer.init();
await setup.ready;          // ← registers this renderer with the marker

const material = new MeshStandardNodeMaterial();
// …configure colorNode…
material.precompile( 'my-material' );
```

In a production build the Vite plugin has already rewritten every
`.precompile('name')` call to `__applyPrecompiled(...)`, and
`setupPrecompile()` becomes a harmless no-op. In `slim:true` builds the slim
entry exports a sentinel so the helper short-circuits entirely.

`setupPrecompile()` accepts:

| Option | Description |
|---|---|
| `three` | The `three/webgpu` namespace (e.g. `import * as THREE from 'three/webgpu'`). |
| `renderer` | The `WebGPURenderer` instance — pass it before or after `init()`. |
| `devEndpoint` | Dev capture URL. Defaults to `'/__tsl-precompile/capture'` (the plugin's endpoint). |
| `aux` | `true` or an opts object to also enable `captureAux()` for auxiliary passes (background, post-process, lights). Requires `scene` + `camera`. |
| `scene`, `camera` | Required only when `aux` is truthy. |

Returns `{ ready, captureAux, setRenderer }`. `captureAux(extraOpts)` merges
per-call options into the setup-level `aux` object, which is useful when a
project creates pass nodes after startup.

For MRT / RenderPipeline scenes, pass the live `PassNode` when you capture aux
artifacts so the extractor sees the multi-target layout:

```js
const setup = setupPrecompile( { three: THREE, renderer, scene, camera, aux: true } );
await renderer.init();
await setup.ready;

const scenePass = pass( scene, camera ).setMRT( mrt( { output, normal } ) );
renderPipeline.outputNode = scenePass.getTextureNode( 'output' );

await setup.captureAux( { passNode: scenePass, renderPipeline } );
```

## Slim Support

Apps that enable the plugin's `slim: true` mode can use the stable
`@tsl-precompile/runtime/slim-support` entry when they need real-app fallback
plumbing: live texture indexing, PMREM caching, compute output sync,
post-processing replay, pass render fallback, or a full `WebGPURenderer` on
the same `GPUDevice` for non-precompiled materials.

```js
import * as ThreeFull from 'three/webgpu';
import { createSlimSceneSupport } from '@tsl-precompile/runtime/slim-support';

const support = createSlimSceneSupport( {
	renderer: slimRenderer,
	threeFullModule: ThreeFull,
} );

support.indexScene( scene );
await support.ensureFallback();      // optional: for Inspector/addon meshes
```

## Exports

```js
import {
	// One-call setup (recommended)
	setupPrecompile,

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

Subpath entries: `@tsl-precompile/runtime/writers`, `/marker`, `/apply`,
`/loader`, `/slim-support`, `/slim`, `/slim-stubs`.

## More

Full project story, adoption modes (`autoMark`, `slim`), troubleshooting,
and the live coverage matrix:
**https://github.com/Makio64/vite-plugin-tsl-precompile**

## License

[MIT](https://github.com/Makio64/vite-plugin-tsl-precompile/blob/main/LICENSE)
