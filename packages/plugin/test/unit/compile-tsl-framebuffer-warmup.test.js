import assert from 'node:assert/strict';
import test from 'node:test';

import { compileTSL } from '../../src/vendor/compileTSL.js';
import { createMockGPUCanvasContext, installMockWebGPU } from '../../src/mock-webgpu.js';
import { beginRenderObjectHarvest } from '../../src/vendor/render-object-observer.js';

test( 'compileTSL binds the renderer framebuffer target during canvas warm-up', async () => {

	const framebufferTarget = { label: 'framebuffer-target', samples: 4 };
	const calls = [];
	let currentRenderTarget = null;

	const manager = {
		nodeBuilderCache: new Map(),
		getForRenderCacheKey() { return 'unused'; },
		getForRender() { return null; },
	};

	const renderer = {
		_nodes: manager,
		needsFrameBufferTarget: true,
		getRenderTarget() { return currentRenderTarget; },
		setRenderTarget( target ) {

			currentRenderTarget = target;
			calls.push( [ 'setRenderTarget', target ] );

		},
		getMRT() { return null; },
		setMRT( target ) { calls.push( [ 'setMRT', target ] ); },
		_getFrameBufferTarget() {

			calls.push( [ '_getFrameBufferTarget' ] );
			return framebufferTarget;

		},
		async compileAsync() {

			calls.push( [ 'compileAsync', currentRenderTarget ] );

		},
		render() {

			calls.push( [ 'render', currentRenderTarget ] );

		},
	};

	const scene = { userData: {}, traverse() {} };
	const artifacts = await compileTSL( renderer, scene, {} );

	assert.equal( artifacts.length, 0 );
	assert.equal( calls.some( ( call ) => call[ 0 ] === '_getFrameBufferTarget' ), true );
	assert.deepEqual( calls.find( ( call ) => call[ 0 ] === 'compileAsync' ), [ 'compileAsync', framebufferTarget ] );
	assert.deepEqual( calls.find( ( call ) => call[ 0 ] === 'render' ), [ 'render', framebufferTarget ] );
	assert.equal( currentRenderTarget, null, 'compileTSL restores the prior canvas render target' );

} );

test( 'compileTSL correlates the active renderer output across stale caches and restores an offscreen target', async () => {

	installMockWebGPU();
	const webgpu = await import( 'three/webgpu' );
	const core = await import( 'three' );
	const renderer = new webgpu.WebGPURenderer( { canvas: makeCanvas(), antialias: false } );
	await renderer.init();

	const scene = new core.Scene();
	const camera = new core.PerspectiveCamera( 45, 1, 0.1, 10 );
	camera.position.z = 3;
	scene.add( new core.Mesh( new core.BoxGeometry(), new webgpu.MeshBasicNodeMaterial() ) );
	const firstOutput = new core.RenderTarget( 16, 16 );
	const secondOutput = new core.RenderTarget( 16, 16 );
	const offscreen = new core.RenderTarget( 4, 4 );

	try {

		renderer.setOutputRenderTarget( firstOutput );
		renderer.toneMapping = core.ReinhardToneMapping;
		renderer.render( scene, camera );
		const first = await compileTSL( renderer, scene, camera, {
			noGlobalMRT: true,
			captureRendererOutput: true,
		} );
		assert.ok( first.renderOutputCapture, 'fresh capture produces an exact renderer-output sidecar' );
		assert.match( first.renderOutputCapture.artifact.fragmentShader, /reinhardToneMapping/i );

		renderer.setOutputRenderTarget( secondOutput );
		renderer.toneMapping = core.NeutralToneMapping;
		renderer.render( scene, camera );
		renderer.setRenderTarget( offscreen, 3, 2 );
		const second = await compileTSL( renderer, scene, camera, {
			noGlobalMRT: true,
			captureRendererOutput: true,
		} );

		const outputArtifacts = second.filter( ( artifact ) => artifact.materialShape === 'output-transform' );
		assert.equal( outputArtifacts.length, 2, 'the accumulated cache still contains the stale first output' );
		assert.match( outputArtifacts[ 0 ].fragmentShader, /reinhardToneMapping/i );
		assert.match( second.renderOutputCapture.artifact.fragmentShader, /neutralToneMapping/i );
		assert.equal( second.renderOutputCapture.artifact.materialUuid, renderer._quadCache.get( renderer._frameBufferTargets.get( secondOutput ).texture ).quad.material.uuid );
		assert.equal( renderer.getRenderTarget(), offscreen, 'capture restores the caller-owned offscreen target' );
		assert.equal( renderer.getActiveCubeFace(), 3, 'capture restores the caller-owned cube face' );
		assert.equal( renderer.getActiveMipmapLevel(), 2, 'capture restores the caller-owned mip level' );
		assert.equal( renderer.currentColorSpace, core.ColorManagement.workingColorSpace );
		assert.equal( second.renderOutputCapture.replayConfig.currentColorSpace, renderer.outputColorSpace );

	} finally {

		firstOutput.dispose();
		secondOutput.dispose();
		offscreen.dispose();
		renderer.dispose();

	}

} );

test( 'compileTSL restores renderer state when a nested render pipeline throws', async () => {

	const target = { label: 'caller-target' };
	let currentTarget = target;
	let activeCubeFace = 4;
	let activeMipmapLevel = 2;
	const originalRender = () => {};
	const originalRenderObjectRequest = ( renderObject ) => renderObject;
	const renderer = {
		autoClear: true,
		xr: { enabled: true },
		toneMapping: 3,
		outputColorSpace: 'display-p3',
		render: originalRender,
		_nodes: {
			nodeBuilderCache: new Map(),
			getForRenderCacheKey( renderObject ) { return renderObject && renderObject.cacheKey || 'unused'; },
			getForRender() { return null; },
		},
		_objects: { get: originalRenderObjectRequest },
		getRenderTarget() { return currentTarget; },
		getActiveCubeFace() { return activeCubeFace; },
		getActiveMipmapLevel() { return activeMipmapLevel; },
		setRenderTarget( nextTarget, nextCubeFace = 0, nextMipmapLevel = 0 ) {

			currentTarget = nextTarget;
			activeCubeFace = nextCubeFace;
			activeMipmapLevel = nextMipmapLevel;

		},
		getMRT() { return null; },
		setMRT() {},
		async compileAsync() {},
	};
	const scene = { userData: {}, traverse() {} };
	const renderPipeline = {
		render() {

			renderer.autoClear = false;
			renderer.xr.enabled = false;
			renderer.toneMapping = 0;
			renderer.outputColorSpace = 'working';
			renderer._objects.get( { cacheKey: 'pipeline-output', material: { uuid: 'pipeline-output' } } );
			throw new Error( 'nested output failure' );

		},
	};

	await assert.rejects(
		compileTSL( renderer, scene, {}, { renderPipeline, captureRendererOutput: true } ),
		/nested output failure/,
	);
	assert.equal( currentTarget, target );
	assert.equal( activeCubeFace, 4 );
	assert.equal( activeMipmapLevel, 2 );
	assert.equal( renderer.autoClear, true );
	assert.equal( renderer.xr.enabled, true );
	assert.equal( renderer.toneMapping, 3 );
	assert.equal( renderer.outputColorSpace, 'display-p3' );
	assert.equal( renderer.render, originalRender );
	assert.equal( renderer._objects.get, originalRenderObjectRequest, 'failure cleanup restores the cached-request observer seam' );

} );

test( 'compileTSL prefers a usable material artifact over an empty-output variant', async () => {

	const emptyOutputShader = `
struct OutputType {
};
var<private> output : OutputType;
@fragment
fn main( @location( 0 ) uv : vec2<f32> ) -> OutputType {
	return output;
}
`;
	const colorShader = `
struct OutputStruct {
	@location( 0 ) color : vec4<f32>
};
var<private> output : OutputStruct;
@fragment
fn main( @location( 0 ) uv : vec2<f32> ) -> OutputStruct {
	output.color = vec4<f32>( uv, 0.0, 1.0 );
	return output;
}
`;

	const material = { uuid: 'mat-a', isMeshStandardMaterial: true };
	const object = { material };
	const manager = {
		nodeBuilderCache: new Map( [
			[ 'empty-key', { vertexShader: 'v-empty', fragmentShader: emptyOutputShader, bindings: [], nodeAttributes: [] } ],
			[ 'color-key', { vertexShader: 'v-color', fragmentShader: colorShader, bindings: [], nodeAttributes: [] } ],
		] ),
		getForRenderCacheKey( renderObject ) { return renderObject.key; },
		getForRender() { return null; },
	};

	const renderer = {
		_nodes: manager,
		getRenderTarget() { return null; },
		setRenderTarget() {},
		getMRT() { return null; },
		setMRT() {},
		async compileAsync() {

			manager.getForRender( { key: 'empty-key', material, object }, false );
			manager.getForRender( { key: 'color-key', material, object }, false );

		},
		render() {},
	};
	const scene = { userData: {}, traverse() {} };

	const artifacts = await compileTSL( renderer, scene, {}, { noGlobalMRT: true } );
	const selected = artifacts.byMaterialUuid.get( material.uuid );

	assert.equal( selected.cacheKey, 'color-key' );
	assert.equal( selected.fragmentShader, colorShader );

} );

test( 'compileTSL names a warm-up target for a pass-owned single-output MRT', async () => {

	let currentRenderTarget = null;
	let compiledTarget = null;
	const manager = {
		nodeBuilderCache: new Map(),
		getForRenderCacheKey() { return 'unused'; },
		getForRender() { return null; },
	};
	const renderer = {
		_nodes: manager,
		getRenderTarget() { return currentRenderTarget; },
		setRenderTarget( target ) { currentRenderTarget = target; },
		getMRT() { return null; },
		setMRT() {},
		async compileAsync() {

			compiledTarget = currentRenderTarget;

		},
		render() {},
	};
	const scene = { userData: {}, traverse() {} };
	const mrtNode = { outputNodes: { output: {} } };

	await compileTSL( renderer, scene, {}, { mrtNode } );

	assert.ok( compiledTarget );
	assert.equal( compiledTarget.textures.length, 1 );
	assert.equal( compiledTarget.textures[ 0 ].name, 'output' );
	assert.equal( currentRenderTarget, null );

} );

test( 'compileTSL leaves material-owned single-output MRTs on the surrounding target', async () => {

	let currentRenderTarget = null;
	let compiledTarget = 'not-called';
	const mrtNode = { outputNodes: { mask: {} } };
	const material = { mrtNode };
	const renderer = {
		_nodes: {
			nodeBuilderCache: new Map(),
			getForRenderCacheKey() { return 'unused'; },
			getForRender() { return null; },
		},
		getRenderTarget() { return currentRenderTarget; },
		setRenderTarget( target ) { currentRenderTarget = target; },
		getMRT() { return null; },
		setMRT() {},
		async compileAsync() { compiledTarget = currentRenderTarget; },
		render() {},
	};
	const scene = {
		userData: {},
		traverse( visit ) { visit( { material } ); },
	};

	await compileTSL( renderer, scene, {} );

	assert.equal( compiledTarget, null );
	assert.equal( currentRenderTarget, null );

} );

test( 'compileTSL prefers a caller-supplied completed multi-face harvest over synthetic states', async () => {

	const material = { uuid: 'real-cube-material', isMeshStandardMaterial: true };
	const object = { material };
	const realState = makeMinimalState( 'real-cube' );
	const syntheticState = makeMinimalState( 'synthetic-cube' );
	const stateByObject = new Map();
	const manager = {
		nodeBuilderCache: new Map(),
		getForRenderCacheKey( renderObject ) { return renderObject.cacheKey; },
		getForRender( renderObject ) { return stateByObject.get( renderObject ) || null; },
	};
	const renderer = makeHarvestRenderer( manager );
	const cubeTexture = { isCubeTexture: true, format: 1023 };
	const cubeTarget = { isCubeRenderTarget: true, texture: cubeTexture, textures: [ cubeTexture ] };
	const realSession = beginRenderObjectHarvest( renderer );
	for ( const activeCubeFace of [ 0, 5 ] ) {

		const renderObject = {
			cacheKey: 'shared-cube-key',
			material,
			object,
			context: { renderTarget: cubeTarget, textures: [ cubeTexture ], activeCubeFace, activeMipmapLevel: 2, sampleCount: 1 },
		};
		stateByObject.set( renderObject, realState );
		renderer._objects.get( renderObject );
		manager.getForRender( renderObject );

	}
	const realHarvest = await realSession.finish();
	assert.equal( realHarvest.familiesByMaterial.get( material ).variants[ 0 ].renderContextSelectors.length, 2 );

	manager.nodeBuilderCache.set( 'shared-cube-key', syntheticState );
	renderer.compileAsync = async () => {

		const renderObject = {
			cacheKey: 'shared-cube-key',
			material,
			object,
			context: { renderTarget: null, activeCubeFace: 0, activeMipmapLevel: 0, sampleCount: 1 },
		};
		stateByObject.set( renderObject, syntheticState );
		renderer._objects.get( renderObject );
		manager.getForRender( renderObject );

	};
	const scene = { userData: {}, traverse() {} };
	const artifacts = await compileTSL( renderer, scene, {}, {
		noGlobalMRT: true,
		renderObjectHarvest: realHarvest,
	} );
	const selected = artifacts.byMaterialUuid.get( material.uuid );

	assert.match( selected.vertexShader, /real-cube/ );
	assert.doesNotMatch( selected.vertexShader, /synthetic-cube/ );
	const faces = selected.renderContextSelectors.map( ( selector ) => JSON.parse( selector ).target.activeCubeFace ).sort();
	assert.deepEqual( faces, [ 0, 5 ] );

} );

test( 'compileTSL discards an incomplete supplied family and uses the whole synthetic family', async () => {

	const material = { uuid: 'incomplete-real-material', isMeshStandardMaterial: true };
	const object = { material };
	const realFirstState = makeMinimalState( 'real-first' );
	const syntheticFirstState = makeMinimalState( 'synthetic-first' );
	const syntheticSecondState = makeMinimalState( 'synthetic-second' );
	const stateByObject = new Map();
	const manager = {
		nodeBuilderCache: new Map(),
		getForRenderCacheKey( renderObject ) { return renderObject.cacheKey; },
		getForRender( renderObject ) { return stateByObject.get( renderObject ) || null; },
	};
	const renderer = makeHarvestRenderer( manager );
	const realSession = beginRenderObjectHarvest( renderer );
	const realFirst = { cacheKey: 'first-key', material, object, context: {} };
	const missingSibling = { cacheKey: 'second-key', material, object, context: {} };
	stateByObject.set( realFirst, realFirstState );
	renderer._objects.get( realFirst );
	manager.getForRender( realFirst );
	renderer._objects.get( missingSibling );
	const realHarvest = await realSession.finish();
	assert.equal( realHarvest.familiesByMaterial.get( material ).complete, false );

	manager.nodeBuilderCache.set( 'first-key', syntheticFirstState );
	manager.nodeBuilderCache.set( 'second-key', syntheticSecondState );
	renderer.compileAsync = async () => {

		for ( const [ cacheKey, state ] of manager.nodeBuilderCache ) {

			const renderObject = { cacheKey, material, object, context: {} };
			stateByObject.set( renderObject, state );
			renderer._objects.get( renderObject );
			manager.getForRender( renderObject );

		}

	};
	const scene = { userData: {}, traverse() {} };
	const artifacts = await compileTSL( renderer, scene, {}, {
		noGlobalMRT: true,
		renderObjectHarvest: realHarvest,
	} );
	const variants = artifacts.byMaterialVariants.get( material.uuid );

	assert.equal( variants.length, 2 );
	assert.deepEqual( variants.map( ( artifact ) => artifact.vertexShader ).sort(), [ 'synthetic-first-vertex', 'synthetic-second-vertex' ] );
	assert.equal( variants.some( ( artifact ) => /real-first/.test( artifact.vertexShader ) ), false );

} );

function makeHarvestRenderer( manager ) {

	let renderTarget = null;
	return {
		_nodes: manager,
		_objects: { get( renderObject ) { return renderObject; } },
		getRenderTarget() { return renderTarget; },
		setRenderTarget( target ) { renderTarget = target; },
		getMRT() { return null; },
		setMRT() {},
		async compileAsync() {},
		render() {},
	};

}

function makeMinimalState( label ) {

	return {
		vertexShader: `${ label }-vertex`,
		fragmentShader: `
struct OutputStruct { @location( 0 ) color : vec4<f32> };
@fragment fn main() -> OutputStruct {
\tvar output : OutputStruct;
\toutput.color = vec4<f32>( 1.0 );
\treturn output;
}`,
		computeShader: '',
		bindings: [],
		nodeAttributes: [],
	};

}

function makeCanvas( width = 16, height = 16 ) {

	let context = null;
	return {
		width,
		height,
		clientWidth: width,
		clientHeight: height,
		style: {},
		getContext( kind ) {

			if ( kind !== 'webgpu' ) return null;
			if ( ! context ) context = createMockGPUCanvasContext();
			return context;

		},
		addEventListener() {},
		removeEventListener() {},
		getBoundingClientRect() {

			return { left: 0, top: 0, width, height, right: width, bottom: height, x: 0, y: 0 };

		},
	};

}
