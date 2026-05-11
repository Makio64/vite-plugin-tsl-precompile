# examples-mrt-debug

Tiny WebGPU multiple-render-target repro scenes for isolating MRT capture and
slim replay issues without the full upstream example matrix.

Pages:

- `pass.html` mirrors the shape of `webgpu_mrt.html`, but replaces the GLTF and
  HDR assets with a tiny local scene. This is a strict pixel-gate case.
- `mask.html` adds per-material `material.mrtNode` output merged into a pass MRT,
  covering the `webgpu_mrt_mask` family. This is a strict pixel-gate case.
- `manual.html` renders into an explicit `RenderTarget( { count: 2 } )` via
  `renderer.setRenderTarget()` / `renderer.setMRT()`, then samples both
  attachments in a final pipeline. This is a strict pixel-gate case.

The baseline pass page uses this shape:

```js
const scenePass = pass( scene, camera );
scenePass.setMRT( mrt( {
	output,
	normal: directionToColor( normalView ),
	diffuse: diffuseColor,
	emissive,
} ) );

const renderPipeline = new RenderPipeline( renderer );
renderPipeline.outputNode = Fn( () => {
	const beauty = scenePass.getTextureNode( 'output' );
	const normal = scenePass.getTextureNode( 'normal' );
	return mix( beauty.renderOutput(), normal, step( 0.5, screenUV.x ) );
} )();
```

It displays the final/beauty output plus named MRT attachments as screen-space
strips.

Run:

```sh
pnpm dev:mrt-debug
# or
pnpm --filter examples-mrt-debug dev
```

Capture and slim-replay E2E:

```sh
pnpm --filter @tsl-precompile/runtime build:slim
pnpm --filter examples-mrt-debug test:e2e
```

The default E2E run keeps all MRT debug pages under the strict PSNR gate.

Use `--no-pixel-gate` when you only want to confirm that capture and replay
produce frames:

```sh
pnpm --filter examples-mrt-debug test:e2e -- --no-pixel-gate
```

The E2E runner reuses the batch harness, reads `e2e-cases.json`, saves PNGs
under `packages/examples/batch/results/shots/`, and writes
`packages/examples/batch/results/mrt-debug-e2e-report.json`.
