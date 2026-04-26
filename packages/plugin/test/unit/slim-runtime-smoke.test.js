/**
 * Slim-bundle runtime smoke test.
 *
 * Instead of spinning up 200 browser tabs, verify that our rewrite + hydrator
 * chain survives a minimal render() invocation against the mock-WebGPU
 * device. Whatever bug would cause ALL slim-mode examples to fail (a broken
 * `getForRender` branch, a missing hydrator field, a class we accidentally
 * stripped too hard) fires here first.
 *
 * What this covers:
 *   - Slim bundle imports cleanly in a headless environment (no DOM, no WebGPU).
 *   - WebGPURenderer constructs.
 *   - A PrecompiledMaterial flows through the rewritten `Nodes.js:getForRender`
 *     and hits our `hydrateNodeBuilderState` path (no crash).
 *   - Non-precompiled materials trigger the loud-failure gate.
 *
 * What this does NOT cover:
 *   - Actual pixel output (mock GPU doesn't draw).
 *   - Correctness of per-frame UBO writes (that's the existing writer tests).
 *   - Complex material paths (shadows, lights, post-process) beyond plain PBR.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { installMockWebGPU, createMockGPUCanvasContext } from '../../src/mock-webgpu.js';

// Install mocks BEFORE importing the slim bundle — its WebGPURenderer
// reaches for `navigator.gpu` at construction time.
installMockWebGPU();
if ( typeof globalThis.self === 'undefined' ) globalThis.self = globalThis;

function makeFakeCanvas( width = 256, height = 256 ) {

	let gpuContext = null;
	return {
		width, height, clientWidth: width, clientHeight: height,
		style: {},
		getContext: ( kind ) => {

			if ( kind === 'webgpu' ) {

				if ( ! gpuContext ) gpuContext = createMockGPUCanvasContext();
				return gpuContext;

			}
			return null;

		},
		addEventListener: () => {},
		removeEventListener: () => {},
		getBoundingClientRect: () => ( { left: 0, top: 0, width, height, right: width, bottom: height, x: 0, y: 0 } ),
	};

}

test( 'slim-runtime: bundle imports + WebGPURenderer constructs', async () => {

	const slim = await import( '../../../runtime/build/three.webgpu.slim.js' );
	assert.equal( typeof slim.WebGPURenderer, 'function', 'WebGPURenderer must be exported' );
	assert.equal( typeof slim.PrecompiledMaterial, 'function', 'PrecompiledMaterial must be exported' );
	assert.equal( typeof slim.hydrateNodeBuilderState, 'function', 'hydrateNodeBuilderState must be exported' );

	const renderer = new slim.WebGPURenderer( { canvas: makeFakeCanvas(), antialias: false } );
	assert.ok( renderer );
	await renderer.init();
	assert.ok( renderer.backend, 'renderer.backend must be initialised' );
	renderer.dispose();

} );

test( 'slim-runtime: PrecompiledMaterial with a minimal artifact survives getForRender', async () => {

	const slim = await import( '../../../runtime/build/three.webgpu.slim.js' );

	const renderer = new slim.WebGPURenderer( { canvas: makeFakeCanvas(), antialias: false } );
	await renderer.init();

	// Build a minimal artifact — just enough WGSL + empty bindings to flow
	// through hydrateNodeBuilderState without crashes.
	const artifact = {
		uniformPlan: [],
		vertexShader: '@vertex fn main() -> @builtin(position) vec4<f32> { return vec4<f32>(0.0); }',
		fragmentShader: '@fragment fn main() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }',
		bindings: [],
		defaults: {},
	};

	const mat = new slim.PrecompiledMaterial( artifact );
	assert.equal( mat.isPrecompiledMaterial, true );
	assert.equal( mat.isNodeMaterial, true );   // the renderer dispatches on this flag
	assert.ok( mat.precompiledArtifact );

	// Attach to a scene. The renderer's scene walker reads material off the
	// mesh; it doesn't actually submit draws through our mock. What we're
	// testing: construction + initial compile survive without throwing.
	const scene = new slim.Scene();
	const mesh = new slim.Mesh( new slim.BoxGeometry( 1, 1, 1 ), mat );
	scene.add( mesh );
	const camera = new slim.PerspectiveCamera( 45, 1, 0.1, 100 );

	// renderer.compileAsync walks the scene and hydrates each material.
	// If our Nodes.js rewrite is broken, it fires here.
	await renderer.compileAsync( scene, camera );
	renderer.dispose();

} );

test( 'slim-runtime: getForRender throws loud on a non-precompiled material', async () => {

	const slim = await import( '../../../runtime/build/three.webgpu.slim.js' );

	const renderer = new slim.WebGPURenderer( { canvas: makeFakeCanvas(), antialias: false } );
	await renderer.init();

	// Bare Material — NOT precompiled, has no isNodeMaterial flag. Some
	// renderer paths dispatch only to `isNodeMaterial` materials; for those
	// a plain Material may silently skip. A material that DOES set
	// `isNodeMaterial` but lacks `isPrecompiledMaterial` is the failure
	// mode we need to verify.
	const mat = new slim.Material();
	mat.isNodeMaterial = true;   // fake the flag so dispatch picks us up
	// no precompiledArtifact, no isPrecompiledMaterial

	const scene = new slim.Scene();
	const mesh = new slim.Mesh( new slim.BoxGeometry( 1, 1, 1 ), mat );
	scene.add( mesh );
	const camera = new slim.PerspectiveCamera( 45, 1, 0.1, 100 );

	let caught = null;
	try {

		await renderer.compileAsync( scene, camera );

	} catch ( err ) {

		caught = err;

	}
	assert.ok( caught, 'non-precompiled node-material should throw at compileAsync' );
	assert.match(
		String( caught.message ),
		/tsl-precompile\/slim|PrecompiledMaterial/i,
		'error must come from our precompile bypass, not a generic crash',
	);
	renderer.dispose();

} );

test( 'slim-runtime: TSL namespace stub throws through chained node-style property access', async () => {

	const slim = await import( '../../../runtime/build/three.webgpu.slim.js' );
	assert.throws(
		() => slim.TSL.screenUV.y.mix(),
		/tsl-precompile\/slim.*TSL\.screenUV\.y\.mix/i,
	);

} );

test( 'slim-runtime: LightingModel stub can be subclassed until TSL use fails', async () => {

	const slim = await import( '../../../runtime/build/three.webgpu.slim.js' );
	class CustomLightingModel extends slim.LightingModel {}
	assert.ok( new CustomLightingModel() instanceof slim.LightingModel );

} );
