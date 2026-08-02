import assert from 'node:assert/strict';
import test from 'node:test';

import { compileTSL } from '../../src/vendor/compileTSL.js';
import { createMockGPUCanvasContext, installMockWebGPU } from '../../src/mock-webgpu.js';
import { beginRenderObjectHarvest } from '../../src/vendor/render-object-observer.js';
import { VIEWPORT_TEXTURE_IDENTITY_SCHEMA } from '@tsl-precompile/contract/dynamic-bindings';
import { RENDER_BINDING_OWNER_KINDS } from '@tsl-precompile/contract/render-selector';

test( 'compileTSL lets an awaiting owner restore temporary state before the next queued compile enters', async ( t ) => {

	async function runScenario( failFirstCompile ) {

		const events = [];
		let sentinel = 'live';
		let currentRenderTarget = null;
		let releaseFirstCompile;
		let markFirstCompileEntered;
		const firstCompileGate = new Promise( ( resolve ) => { releaseFirstCompile = resolve; } );
		const firstCompileEntered = new Promise( ( resolve ) => { markFirstCompileEntered = resolve; } );
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
			async compileAsync( scene ) {

				events.push( `${ scene.label }:inner:${ sentinel }` );
				if ( scene.label !== 'A' ) return;
				markFirstCompileEntered();
				await firstCompileGate;
				if ( failFirstCompile ) throw new Error( 'expected A failure' );

			},
			render() {},
		};
		const camera = {};
		const sceneA = { label: 'A', userData: {}, traverse() {} };
		const sceneB = { label: 'B', userData: {}, traverse() {} };

		const captureA = ( async () => {

			sentinel = 'temporary-A';
			try {

				await compileTSL( renderer, sceneA, camera, { skipWarmupRender: true } );

			} finally {

				events.push( 'A:caller-cleanup' );
				sentinel = 'live';

			}

		} )();
		await firstCompileEntered;
		const compileB = compileTSL( renderer, sceneB, camera, { skipWarmupRender: true } );
		await Promise.resolve();
		assert.equal(
			events.some( ( event ) => event.startsWith( 'B:inner:' ) ),
			false,
			'B remains queued while A owns the renderer compile lock',
		);
		releaseFirstCompile();

		const settlements = await Promise.allSettled( [ captureA, compileB ] );
		assert.deepEqual(
			events,
			[
				'A:inner:temporary-A',
				'A:caller-cleanup',
				'B:inner:live',
			],
			'the public queue tail settles behind A owner continuation cleanup',
		);
		assert.equal( sentinel, 'live' );
		assert.equal( settlements[ 0 ].status, failFirstCompile ? 'rejected' : 'fulfilled' );
		assert.equal( settlements[ 1 ].status, 'fulfilled' );

	}

	await t.test( 'after success', () => runScenario( false ) );
	await t.test( 'after failure', () => runScenario( true ) );

} );

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

test( 'compileTSL suppresses r185 WebGPU framebuffer copies during synthetic compile and warm-up', async () => {

	const copyPhases = [];
	let phase = 'idle';
	const backend = {
		isWebGPUBackend: true,
		copyFramebufferToTexture() {

			copyPhases.push( phase );

		},
	};
	const originalCopy = backend.copyFramebufferToTexture;
	const manager = {
		nodeBuilderCache: new Map(),
		getForRenderCacheKey() { return 'unused'; },
		getForRender() { return null; },
	};
	const renderer = {
		backend,
		_nodes: manager,
		getRenderTarget() { return null; },
		setRenderTarget() {},
		getMRT() { return null; },
		setMRT() {},
		async compileAsync() {

			phase = 'compile';
			backend.copyFramebufferToTexture();
			phase = 'idle';

		},
		render() {

			phase = 'render';
			backend.copyFramebufferToTexture();
			phase = 'idle';

		},
	};
	const scene = { userData: {}, traverse() {} };

	await compileTSL( renderer, scene, {} );

	assert.deepEqual( copyPhases, [] );
	assert.equal( backend.copyFramebufferToTexture, originalCopy, 'the live backend method is restored after synthetic warm-up' );

} );

test( 'compileTSL suppresses r185 occlusion queries during compile and warm-up, then restores them', async () => {

	const phases = [];
	const occluder = { occlusionTest: true };
	const manager = {
		nodeBuilderCache: new Map(),
		getForRenderCacheKey() { return 'unused'; },
		getForRender() { return null; },
	};
	const renderer = {
		_nodes: manager,
		getRenderTarget() { return null; },
		setRenderTarget() {},
		getMRT() { return null; },
		setMRT() {},
		async compileAsync() {

			phases.push( [ 'compile', occluder.occlusionTest ] );

		},
		render() {

			phases.push( [ 'render', occluder.occlusionTest ] );
			throw new Error( 'expected warm-up failure' );

		},
	};
	const scene = {
		userData: {},
		traverse( callback ) { callback( occluder ); },
	};

	await assert.rejects( compileTSL( renderer, scene, {} ), /expected warm-up failure/ );
	assert.deepEqual( phases, [ [ 'compile', false ], [ 'render', false ] ] );
	assert.equal( occluder.occlusionTest, true, 'the live query flag is restored after failure' );

} );

test( 'compileTSL borrows caller render targets without mutation or disposal', async () => {

	const previousTarget = { label: 'previous' };
	let currentRenderTarget = previousTarget;
	let disposeCalls = 0;
	let shouldThrow = false;
	const override = Object.preventExtensions( {
		label: 'borrowed',
		textures: [],
		dispose() { disposeCalls ++; },
	} );
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

			assert.equal( currentRenderTarget, override );
			if ( shouldThrow ) throw new Error( 'borrowed compile failure' );

		},
		render() {},
	};
	const scene = { userData: {}, traverse() {} };

	await compileTSL( renderer, scene, {}, { renderTargetOverride: override, skipWarmupRender: true } );
	assert.equal( currentRenderTarget, previousTarget );
	assert.equal( disposeCalls, 0 );

	shouldThrow = true;
	await assert.rejects(
		compileTSL( renderer, scene, {}, { renderTargetOverride: override, skipWarmupRender: true } ),
		/borrowed compile failure/,
	);
	assert.equal( currentRenderTarget, previousTarget, 'failure restores the caller target' );
	assert.equal( disposeCalls, 0, 'failure leaves borrowed target ownership with the caller' );

} );

test( 'compileTSL captures a pre-first-render postprocess quad while suppressing PassNode side effects', async () => {

	const isolatedMaterial = { uuid: 'isolated-final-quad' };
	const liveMaterial = { uuid: 'live-scene-material' };
	const finalQuadWorldMatrix = { elements: Array.from( { length: 16 }, ( _, index ) => index ) };
	const calls = [];
	let isolatedWorldMatrix = null;
	let passNodeUpdateBeforeCalls = 0;
	const manager = {
		nodeBuilderCache: new Map(),
		getForRenderCacheKey() { return 'unused'; },
		getForRender() { return null; },
		updateBefore( renderObject ) {

			calls.push( [ 'before', renderObject.material ] );
			if ( renderObject.material === isolatedMaterial ) passNodeUpdateBeforeCalls ++;

		},
		updateForRender( renderObject ) {

			calls.push( [ 'update', renderObject.material ] );
			if ( renderObject.material === isolatedMaterial ) isolatedWorldMatrix = finalQuadWorldMatrix;

		},
		updateAfter( renderObject ) { calls.push( [ 'after', renderObject.material ] ); },
	};
	const originalMethods = {
		updateBefore: manager.updateBefore,
		updateForRender: manager.updateForRender,
		updateAfter: manager.updateAfter,
	};
	let currentTarget = null;
	const renderer = {
		_nodes: manager,
		toneMapping: 4,
		outputColorSpace: 'display',
		getRenderTarget() { return currentTarget; },
		setRenderTarget( target ) { currentTarget = target; },
		getMRT() { return null; },
		setMRT() {},
		async compileAsync() {

			assert.equal( this.toneMapping, 0 );
			assert.equal( this.outputColorSpace, 'working' );
			for ( const material of [ isolatedMaterial, liveMaterial ] ) {

				const renderObject = { material };
				manager.updateBefore( renderObject );
				manager.updateForRender( renderObject );
				if ( material === isolatedMaterial ) {

					// r185's object.worldMatrix UniformNode starts null before the
					// first RenderPipeline.render(). Bindings immediately reads
					// `.elements` after updateForRender initializes that value.
					assert.equal( isolatedWorldMatrix.elements.length, 16 );

				}
				manager.updateAfter( renderObject );

			}

		},
		render() { throw new Error( 'skipWarmupRender must avoid the synthetic render' ); },
	};
	const scene = { userData: {}, traverse() {} };

	await compileTSL( renderer, scene, {}, {
		skipWarmupRender: true,
		skipNodeUpdatesForMaterials: [ isolatedMaterial ],
		rendererStateOverride: {
			toneMapping: 0,
			currentColorSpace: 'working',
		},
	} );

	assert.deepEqual( calls, [
		[ 'update', isolatedMaterial ],
		[ 'before', liveMaterial ],
		[ 'update', liveMaterial ],
		[ 'after', liveMaterial ],
	] );
	assert.equal( isolatedWorldMatrix, finalQuadWorldMatrix );
	assert.equal( passNodeUpdateBeforeCalls, 0 );
	assert.equal( manager.updateBefore, originalMethods.updateBefore );
	assert.equal( manager.updateForRender, originalMethods.updateForRender );
	assert.equal( manager.updateAfter, originalMethods.updateAfter );
	assert.equal( renderer.toneMapping, 4 );
	assert.equal( renderer.outputColorSpace, 'display' );

} );

test( 'compileTSL signs the mixed attachment topology of a borrowed PassNode target', async () => {

	installMockWebGPU();
	const webgpu = await import( 'three/webgpu' );
	const tsl = await import( 'three/tsl' );
	const core = await import( 'three' );
	const renderer = new webgpu.WebGPURenderer( { canvas: makeCanvas(), antialias: false } );
	await renderer.init();

	const scene = new core.Scene();
	const camera = new core.PerspectiveCamera( 45, 1, 0.1, 10 );
	camera.position.z = 3;
	const material = new webgpu.MeshBasicNodeMaterial();
	scene.add( new core.Mesh( new core.BoxGeometry(), material ) );

	const mrtNode = tsl.mrt( {
		output: tsl.output,
		diffuseColor: tsl.diffuseColor,
		normal: tsl.normalView,
		velocity: tsl.velocity,
	} );
	const renderTarget = new core.RenderTarget( 4, 4, { count: 4 } );
	const names = [ 'output', 'diffuseColor', 'normal', 'velocity' ];
	renderTarget.textures.forEach( ( texture, index ) => { texture.name = names[ index ]; } );
	renderTarget.textures[ 0 ].type = core.HalfFloatType;
	renderTarget.textures[ 1 ].type = core.UnsignedByteType;
	renderTarget.textures[ 2 ].type = core.UnsignedByteType;
	renderTarget.textures[ 3 ].type = core.HalfFloatType;

	try {

		const artifacts = await compileTSL( renderer, scene, camera, {
			mrtNode,
			renderTargetOverride: renderTarget,
			skipWarmupRender: true,
		} );
		const artifact = artifacts.byMaterialUuid.get( material.uuid )
			|| artifacts.find( ( candidate ) => candidate.materialUuid === material.uuid );
		const selectors = ( artifact.renderContextSelectors || [] ).map( JSON.parse );

		assert.equal( selectors.length, 1 );
		assert.equal( selectors[ 0 ].target.surface, 'offscreen-2d' );
		assert.deepEqual( selectors[ 0 ].target.colors.map( ( color ) => color.dataType ), [
			core.HalfFloatType,
			core.UnsignedByteType,
			core.UnsignedByteType,
			core.HalfFloatType,
		] );

	} finally {

		renderTarget.dispose();
		renderer.dispose();

	}

} );

test( 'compileTSL preserves side-specialized two-pass transmission without leaking render objects', async () => {

	installMockWebGPU();
	const webgpu = await import( 'three/webgpu' );
	const core = await import( 'three' );
	const renderer = new webgpu.WebGPURenderer( { canvas: makeCanvas(), antialias: false } );
	await renderer.init();

	const scene = new core.Scene();
	const camera = new core.PerspectiveCamera( 45, 1, 0.1, 10 );
	camera.position.z = 3;
	const material = new webgpu.MeshPhysicalNodeMaterial( {
		transmission: 1,
		thickness: 0.1,
		attenuationDistance: 1,
		side: core.DoubleSide,
		forceSinglePass: false,
	} );
	const geometry = new core.BoxGeometry();
	scene.add( new core.Mesh( geometry, material ) );
	scene.add( new core.DirectionalLight( 0xffffff, 1 ) );

	const originalObjectsDispose = renderer._objects.dispose;
	let objectsDisposeCalls = 0;
	renderer._objects.dispose = function countedObjectsDispose( ...args ) {

		objectsDisposeCalls ++;
		return originalObjectsDispose.apply( this, args );

	};
	const listenerCounts = [];
	try {

		for ( let captureIndex = 0; captureIndex < 2; captureIndex ++ ) {

			const artifacts = await compileTSL( renderer, scene, camera, { noGlobalMRT: true } );
			const variants = artifacts.byMaterialVariants.get( material.uuid ) || [];
			assert.equal( variants.length, 2, 'capture retains one exact shader per rendered side' );
			const bySide = new Map();
			for ( const variant of variants ) {

				const sides = new Set( ( variant.renderContextSelectors || [] ).map( ( selector ) => JSON.parse( selector ).material.side ) );
				assert.equal( sides.size, 1 );
				bySide.set( [ ...sides ][ 0 ], variant );

			}
			assert.deepEqual( [ ...bySide.keys() ].sort(), [ core.FrontSide, core.BackSide ].sort() );
			for ( const variant of bySide.values() ) {

				const viewportIdentities = new Set( variant.uniformPlan
					.flatMap( ( group ) => group.textures || [] )
					.map( ( binding ) => binding.source )
					.filter( ( source ) => source && source.kind === 'viewport.texture' )
					.map( ( source ) => source.viewportIdentity ) );
				assert.equal( viewportIdentities.size, 1 );
				assert.match( [ ...viewportIdentities ][ 0 ], new RegExp( `^${ VIEWPORT_TEXTURE_IDENTITY_SCHEMA }#` ) );

			}
			const backShader = bySide.get( core.BackSide ).fragmentShader;
			const frontShader = bySide.get( core.FrontSide ).fragmentShader;
			assert.match( backShader, /NORMAL_normalView = \( normalViewGeometry \* vec3<f32>\( -1\.0 \) \);/ );
			assert.match( frontShader, /NORMAL_normalView = normalViewGeometry;/ );
			assert.doesNotMatch( backShader, /front_facing/ );
			assert.doesNotMatch( frontShader, /front_facing/ );
			assert.equal( material.side, core.DoubleSide );
			listenerCounts.push( material._listeners && material._listeners.dispose ? material._listeners.dispose.length : 0 );

		}
		assert.equal( objectsDisposeCalls, 0, 'capture never globally drops the renderer object cache' );
		assert.equal( listenerCounts[ 0 ], 2, 'one back and one front RenderObject listen to the material' );
		assert.deepEqual( listenerCounts, [ 2, 2 ], 'repeated capture reuses the exact RenderObjects' );

	} finally {

		renderer._objects.dispose = originalObjectsDispose;
		material.dispose();
		geometry.dispose();
		renderer.dispose();

	}

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
	let overrideAtRender = null;
	const renderPipeline = {
		render() {

			overrideAtRender = {
				toneMapping: renderer.toneMapping,
				outputColorSpace: renderer.outputColorSpace,
			};
			renderer.autoClear = false;
			renderer.xr.enabled = false;
			renderer.toneMapping = 0;
			renderer.outputColorSpace = 'working';
			renderer._objects.get( { cacheKey: 'pipeline-output', material: { uuid: 'pipeline-output' } } );
			throw new Error( 'nested output failure' );

		},
	};

	await assert.rejects(
		compileTSL( renderer, scene, {}, {
			renderPipeline,
			captureRendererOutput: true,
			rendererOutputConfig: {
				schema: 'renderer-output@1',
				toneMapping: 4,
				currentColorSpace: 'srgb',
				sampledTexture: '2d',
				multiview: false,
			},
		} ),
		/nested output failure/,
	);
	assert.deepEqual( overrideAtRender, { toneMapping: 4, outputColorSpace: 'srgb' } );
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
	assert.equal(
		realHarvest.familiesByMaterial.get( material ).variants[ 0 ].renderContextSelectors.length,
		6,
		'a proven cube-target variant publishes canonical aliases for every face',
	);

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
	assert.deepEqual( faces, [ 0, 1, 2, 3, 4, 5 ] );

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

test( 'compileTSL atomically recovers an incomplete supplied family from complete cached states', async () => {

	const {
		material,
		manager,
		renderer,
		realHarvest,
		observedFirstState,
	} = await makeStateIncompleteSuppliedFamilyFixture( 'cache-recovered-private-material' );
	const recoveredFirstState = makeMinimalState( 'cache-recovered-first' );
	const recoveredSecondState = makeMinimalState( 'cache-recovered-second' );
	const family = realHarvest.familiesByMaterial.get( material );

	assert.equal( family.complete, false );
	assert.equal( family.variants.length, 2 );
	assert.equal(
		family.variants.every( ( variant ) =>
			variant.requests.length > 0 &&
			variant.requests.every( ( request ) => request.renderContextSelector.length > 0 ) &&
			variant.renderContextSelectors.length > 0
		),
		true,
		'the family is incomplete only because one builder state was not correlated',
	);

	manager.nodeBuilderCache.set( 'supplied-first-key', recoveredFirstState );
	manager.nodeBuilderCache.set( 'supplied-second-key', recoveredSecondState );
	const scene = { userData: {}, traverse() {} };
	const artifacts = await compileTSL( renderer, scene, {}, {
		noGlobalMRT: true,
		renderObjectHarvest: realHarvest,
		skipWarmupRender: true,
	} );
	const variants = artifacts.byMaterialVariants.get( material.uuid );

	assert.equal( variants.length, 2 );
	assert.deepEqual(
		variants.map( ( artifact ) => artifact.vertexShader ).sort(),
		[ 'cache-recovered-first-vertex', 'cache-recovered-second-vertex' ],
	);
	assert.equal(
		variants.some( ( artifact ) => artifact.vertexShader === observedFirstState.vertexShader ),
		false,
		'recovery uses the whole current cache family instead of mixing a harvested sibling',
	);
	assert.equal( variants.every( ( artifact ) => artifact.materialUuid === material.uuid ), true );
	assert.equal( variants.every( ( artifact ) => artifact.renderContextSelectors.length > 0 ), true );

} );

test( 'compileTSL does not partially attribute an incomplete supplied family with a missing cached state', async () => {

	const {
		material,
		manager,
		renderer,
		realHarvest,
	} = await makeStateIncompleteSuppliedFamilyFixture( 'cache-partial-private-material' );
	const cachedFirstState = makeMinimalState( 'cache-partial-first' );
	manager.nodeBuilderCache.set( 'supplied-first-key', cachedFirstState );

	const scene = { userData: {}, traverse() {} };
	const artifacts = await compileTSL( renderer, scene, {}, {
		noGlobalMRT: true,
		renderObjectHarvest: realHarvest,
		skipWarmupRender: true,
	} );

	assert.equal( artifacts.byMaterialUuid.has( material.uuid ), false );
	assert.equal( artifacts.byMaterialVariants.has( material.uuid ), false );
	assert.equal(
		artifacts.some( ( artifact ) => artifact.materialUuid === material.uuid ),
		false,
		'the available sibling must not inherit private-material attribution',
	);
	assert.equal(
		artifacts.some( ( artifact ) => artifact.vertexShader === cachedFirstState.vertexShader ),
		true,
		'the assertion covers an otherwise extractable accumulated-cache entry',
	);

} );

test( 'compileTSL stamps shadow-caster ownership only from exact dispatch evidence', async () => {

	const cacheKey = 'exact-shadow-owner';
	const shadowMaterial = { uuid: 'private-shadow-material', isShadowPassMaterial: true };
	const casterMaterial = { uuid: 'process-local-caster-material' };
	const object = { material: casterMaterial };
	const state = makeMinimalState( 'shadow-owner' );
	const manager = {
		nodeBuilderCache: new Map(),
		getForRenderCacheKey( renderObject ) { return renderObject.cacheKey; },
		getForRender() { return null; },
	};
	const renderer = makeHarvestRenderer( manager );
	const scene = { userData: {}, traverse() {} };
	const compile = async ( bindingOwnerExact ) => {

		const request = Object.freeze( {
			cacheKey,
			material: shadowMaterial,
			sourceMaterial: casterMaterial,
			bindingOwnerExact,
			bindingOwnerKind: RENDER_BINDING_OWNER_KINDS.SHADOW_CASTER,
		} );
		const variant = Object.freeze( {
			cacheKey,
			nodeBuilderState: state,
			complete: true,
			objects: Object.freeze( [ object ] ),
			sourceMaterials: Object.freeze( [ casterMaterial ] ),
			sourceOwnerRequests: Object.freeze( [ request ] ),
			userMaterials: Object.freeze( [ casterMaterial ] ),
			captureClocks: Object.freeze( [] ),
			renderContextSelectors: Object.freeze( [] ),
			requests: Object.freeze( [ request ] ),
		} );
		const family = Object.freeze( {
			material: shadowMaterial,
			complete: true,
			variants: Object.freeze( [ variant ] ),
		} );
		return compileTSL( renderer, scene, {}, {
			noGlobalMRT: true,
			skipWarmupRender: true,
			renderObjectHarvest: Object.freeze( {
				renderer,
				familiesByMaterial: new Map( [ [ shadowMaterial, family ] ] ),
			} ),
		} );

	};

	const exactArtifacts = await compile( true );
	assert.equal( exactArtifacts.length, 1 );
	const exact = exactArtifacts[ 0 ];
	assert.equal( exact.bindingOwner, RENDER_BINDING_OWNER_KINDS.SHADOW_CASTER );
	assert.equal( exact.userMaterialUuid, undefined, 'auxiliary artifacts do not persist caster UUIDs' );
	assert.equal( Object.isFrozen( exact._shadowCasterRequests ), true );
	assert.equal( exact._shadowCasterRequests.length, 1 );
	assert.equal( exact._shadowCasterRequests[ 0 ].sourceMaterial, casterMaterial );
	assert.equal( Object.getOwnPropertyDescriptor( exact, '_shadowCasterRequests' ).enumerable, false );
	const serialized = JSON.parse( JSON.stringify( exact ) );
	assert.equal( serialized.bindingOwner, RENDER_BINDING_OWNER_KINDS.SHADOW_CASTER );
	assert.equal( serialized.userMaterialUuid, undefined );
	assert.equal( serialized._shadowCasterRequests, undefined );

	const inexactArtifacts = await compile( false );
	assert.equal( inexactArtifacts.length, 1 );
	assert.equal( inexactArtifacts[ 0 ].bindingOwner, undefined );
	assert.equal( inexactArtifacts[ 0 ]._shadowCasterRequests, undefined );

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

async function makeStateIncompleteSuppliedFamilyFixture( materialUuid ) {

	const material = { uuid: materialUuid, isMeshStandardMaterial: true };
	const object = { material };
	const observedFirstState = makeMinimalState( 'observed-first' );
	const stateByObject = new Map();
	const manager = {
		nodeBuilderCache: new Map(),
		getForRenderCacheKey( renderObject ) { return renderObject.cacheKey; },
		getForRender( renderObject ) { return stateByObject.get( renderObject ) || null; },
	};
	const renderer = makeHarvestRenderer( manager );
	const realSession = beginRenderObjectHarvest( renderer );
	const observedFirst = { cacheKey: 'supplied-first-key', material, object, context: {} };
	const missingSecond = { cacheKey: 'supplied-second-key', material, object, context: {} };

	stateByObject.set( observedFirst, observedFirstState );
	renderer._objects.get( observedFirst );
	manager.getForRender( observedFirst );
	renderer._objects.get( missingSecond );
	const realHarvest = await realSession.finish();

	return {
		material,
		manager,
		renderer,
		realHarvest,
		observedFirstState,
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
