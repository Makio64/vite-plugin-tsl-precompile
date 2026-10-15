# Advanced capture and failures

Read the relevant section when the initial audit finds auxiliary render paths, compute, framework transforms, or when capture/build validation fails.

## Auxiliary and RenderPipeline capture

Pass the live scene and camera when auxiliary capture is needed:

```js
const precompile = setupPrecompile( {
	renderer,
	scene,
	camera,
	aux: true,
} );

await renderer.init();
await precompile.ready;
await precompile.captureAux( { postProcessing } );
```

Call `captureAux()` only after the scene, background/environment, pass graph, and post-processing objects are fully assembled. The call is a production no-op and may remain in application code.

Inspect the returned results and fail the capture when any entry has `ok: false`.
Global material settlement alone does not prove every auxiliary pass succeeded.
If probe or transient captures temporarily own the renderer during startup,
await them, then render the completed post graph again before auxiliary capture.
Private effects such as SSR allocate mip chains during that real warm-up; calling
`compileAsync()` alone does not necessarily initialize those resources.

Render the first real scene frame before capturing backgrounds; reflectors and
offscreen passes can use different attachments from the visible frame. For a
temporary equirectangular source converted with
`CubeRenderTarget.fromEquirectangularTexture()`, capture that source before
disposing it. Keep a development-only reference until the completed scene is
ready for auxiliary capture; calling scene-wide capture during an empty startup
stage can miss the later shadow casters:

```js
cubeTarget.fromEquirectangularTexture( renderer, sourceTexture );
const results = await precompile.captureAux( {
	cubeRenderTargetTextures: [ sourceTexture ],
} );
if ( results.some( result => ! result.ok ) ) throw new Error( JSON.stringify( results ) );
sourceTexture.dispose();
```

Capturing the final cube environment later cannot recover the temporary source's
sampling topology. Renderer output capture also distinguishes sampled component
types, such as unsigned-byte and half-float attachments.

For MRT or `RenderPipeline`, pass the live pass and pipeline after calling `setMRT(...)`:

```js
await precompile.captureAux( { passNode: scenePass, renderPipeline } );
```

When the app switches between post graphs, give each finite graph a semantic
name. Capture with `renderPipelineName: name`, and in slim replay call
`bindAuxByName(renderPipeline.outputNode, 'post-process', name)` immediately
after rebuilding the graph. Import `bindAuxByName` from `@tsl-precompile/runtime`.
Build the name from the effective pass set and shader-affecting settings, not
from captured hashes or live uniform values. Internal effect passes inherit
that named pipeline's ownership, so GTAO/SSR inputs from different MRT layouts
cannot be confused. Capture and test every reachable name before shipping.

Exercise every materially different topology in development. Tone mapping, output color space, sampled texture dimension, multiview, camera type, lights/shadows, clipping, geometry attributes, and MRT attachments can select distinct artifacts.

## Advanced scene coverage matrix

Do not reduce an advanced scene to one generic route. Declare and exercise the
smallest route/state matrix that covers the render topology actually shipped:

- **Cubemap and PMREM:** render both equirectangular and cube sources when the
  application supports both. For `PMREMGenerator.fromScene(..., { size })`,
  pass every shipped size through `pmremSceneSizes` because the generated
  CubeUV texture does not retain that request. Use the `three/webgpu`
  namespace; root `three` exposes the incompatible WebGL PMREM implementation.
- **Physical materials:** include the real combinations of normal, roughness,
  metalness, clearcoat, transmission, thickness, alpha, displacement, and
  environment maps. A material capture covers only the defines, geometry
  attributes, texture dimensions, and render context observed for that owner.
- **Lights and shadows:** cover each shipped directional, spot, and point-light
  shadow path plus every shadow-map type in use. VSM adds renderer-owned blur
  passes; PCF/hard shadows do not prove VSM. Include alpha-tested or
  transmitted shadow casters when present.
- **Reflectors:** render the reflector material with its real camera and
  per-camera render target. Exercise materially different reflector options
  such as resolution scale, samples, bounces, depth, or mip generation. The
  runtime rebinds the live reflector texture; a placeholder texture is not a
  valid proof.
- **Post-processing:** assemble the final live `RenderPipeline` before calling
  `captureAux()`. Exercise distinct MRT layouts, offscreen targets, bloom/GTAO
  branches, tone mapping, output color space, and sampled texture dimensions.

For each state, take a `captureStatus()` snapshot immediately before the render
that reveals it and await `waitForCaptureSettled({ since: snapshot })`. After
capture, require a non-blank changing canvas and zero page, console, request,
capture, or GPU validation errors. Artifact count alone is not visual proof.

For long asynchronous startup, drive capture with an application readiness
signal as well as capture settlement. The route CLI's idle interval can occur
between startup phases, before the final `captureAux()` call. A browser driver
should wait for the application's rendered-ready state, then wait for capture
settlement and check its results before closing the page. Confirm the expected
auxiliary families exist; a successful early idle interval does not prove that
PMREM or post-processing capture has run.

Also wait for background jobs that replace render resources after the first
paint. For example, native texture compression can replace an ordinary image
texture with a compressed texture after the page reports ready. Render and
capture the replacement state as well as the startup state, then require the
job's own completion report to have zero failures. The same rule applies to
streamed textures, atlas rebakes, and asynchronous model replacement.

Production readiness is only the start of the visual check. Compare the same
camera position, animation time, viewport, and settings against the original
application. Check the opening, middle, and final camera positions separately:
an SSR pass with a frozen camera uniform can look correct at startup and drift
as the camera moves. Exercise the application's live controls after startup,
including resize, effect toggles, and material changes.

For shadows, verify that the light owns a populated shadow map and that a moving
caster changes the receiver's shadow. A compiled shadow-depth artifact alone
does not prove that production schedules the depth pass. For custom effects,
keep each live uniform reachable through a stable property on its material;
uniforms hidden only inside a TSL `Fn` closure cannot be rebound by property
path. This is especially important for camera matrices that initially have
identical values but diverge during interaction.

## Compute

Do not treat standalone compute nodes as material markers. Inspect the installed runtime declarations for `@tsl-precompile/runtime/compute-capture`, especially `precompileCompute` and `precompileComputes`, and use the project's real compute resources and dispatch lifecycle. Keep compatibility mode until both capture and replay have been verified. Storage-texture or unsupported compute proofs may require an explicit hybrid/full-renderer support path instead of pure slim.

Dispatch the real kernel before capturing it, supply named resource ownership,
and await capture before releasing its buffers or textures. Standalone capture
reads the cached compute state without traversing or rendering the scene.
For runtime-sized storage arrays, use Three's `bufferCount = 0` declaration and
verify replay with more than one allocation size. Production must dispatch the
captured kernel through the compute runner; retaining an ordinary TSL dispatch
does not prove compiler-free compute.

Preserve Three's dispatch units: `runner.dispatch(number)` takes the total
invocation count, while `runner.dispatch([x, y, z])` takes workgroup counts.
Dividing a numeric invocation count by the workgroup width twice can leave most
of a storage texture black without a GPU validation error. Read back or inspect
the complete output, including its final rows, during production verification.

## Framework files

Plain JavaScript/TypeScript modules and Vue/Astro script subrequests are transformed. Put Svelte material construction and `.precompile()` markers in imported `.js` or `.ts` modules; raw `.svelte` component scripts are not directly rewritten by the current strict pre-transform.

## Slim-mode checklist

Enable `slim: 'source'` only when all answers are yes:

- Every reachable TSL NodeMaterial has a stable marker and current artifacts.
- Every route and shader topology was rendered during development capture.
- Required background, environment/PMREM, shadow, post-processing, MRT, renderer-output, and compute artifacts exist.
- The compatibility production build and preview already work.
- The slim build succeeds without compiler, stock-adapter, retained Node/TSL, or split-Three-identity errors.
- The slim production preview renders representative states without uncaptured-topology errors.

Use `slim: true` only when the checked single-file prebuilt renderer is intentionally preferred over the application-tree-shaken source entry.

## Failure map

### No captured artifact

Run development mode, visit the route that constructs the named material, and make sure the material participates in a real render. Confirm the plugin is active in the actual Vite config.

### Stale artifact or source revision

Re-run development capture after any material-source, `three`, plugin, or runtime change. Commit the new artifact family. Identify old orphaned files, but do not delete them unless their ownership is proven and deletion is in scope.

### No development endpoint

The production transform did not run or the active Vite config omitted the plugin. Confirm `tslPrecompile()` is in the real plugin array and the marked code passes through Vite.

### No development renderer registered

Confirm the same live renderer is passed to `setupPrecompile({ renderer })` and `precompile.ready` resolves after `renderer.init()`.

### Marker not observed in a real render

Mount the object before capture and render its actual scene/camera. For lazy or conditional content, navigate to the state that displays it. Avoid fake manual marker invocation detached from scene context.

### Unsupported `source.kind`

Keep compatibility mode, capture the exact error and material site, and report
the unsupported kind. Do not patch generated WGSL/GLSL or downgrade the error
to a warning.

### Slim uncaptured-topology error

Reproduce the production state in development with the same camera, geometry, lights, shadows, clipping, targets, and effects, then recapture. If the path constructs arbitrary live TSL, return to compatibility mode or configure an explicit full-renderer fallback.

For `TSLP_VARIANT_SELECTOR_MISS`, preserve the error's structured
`details.closestDifferencePaths`, `details.artifactContext`, and
`details.remediation` fields. Follow `remediation.nextActions` in dependency
order. Its doctor action deliberately has `cwd: null` and `argv: null` until
the owning project root and package manager are known; select the matching
`argvByPackageManager` entry and execute it directly from that root. Never join
the argv array through a shell or hand-edit generated artifacts.
