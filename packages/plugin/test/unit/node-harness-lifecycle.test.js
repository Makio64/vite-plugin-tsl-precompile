import test from 'node:test';
import assert from 'node:assert/strict';
import { BoxGeometry, Mesh, PerspectiveCamera, Scene } from 'three';
import { MeshBasicNodeMaterial, WebGPURenderer } from 'three/webgpu';
import { extractMaterial } from '../../src/node-harness.js';
import { createMockGPUCanvasContext, installMockWebGPU } from '../../src/mock-webgpu.js';
import { compileTSL } from '../../src/vendor/compileTSL.js';

function observeDisposal( t ) {

	const rendererDispose = WebGPURenderer.prototype.dispose;
	const geometryDispose = BoxGeometry.prototype.dispose;
	const order = [];
	const renderer = t.mock.method( WebGPURenderer.prototype, 'dispose', function () {

		order.push( 'renderer' );
		return rendererDispose.call( this );

	} );
	const geometry = t.mock.method( BoxGeometry.prototype, 'dispose', function () {

		order.push( 'geometry' );
		return geometryDispose.call( this );

	} );
	return { renderer, geometry, order };

}

test( 'node harness releases initialized renderer after factory and configuration failures', async ( t ) => {

	for ( const stage of [ 'factory', 'configuration' ] ) {

		await t.test( stage, async ( t ) => {

			const observed = observeDisposal( t );
			const failure = new Error( `expected ${ stage } failure` );
			await assert.rejects( extractMaterial( () => {

				if ( stage === 'factory' ) throw failure;
				return {
					material: new MeshBasicNodeMaterial(), name: 'lifecycle',
					configureRenderer() { throw failure; },
				};

			} ), ( error ) => error === failure );
			assert.equal( observed.renderer.mock.callCount(), 1 );
			assert.equal( observed.geometry.mock.callCount(), 0 );

		} );

	}

} );

test( 'node harness releases its default geometry and renderer after compilation failure', async ( t ) => {

	const observed = observeDisposal( t );
	const failure = new Error( 'expected compilation failure' );
	t.mock.method( WebGPURenderer.prototype, 'compileAsync', async () => { throw failure; } );
	await assert.rejects( extractMaterial( () => ( {
		material: new MeshBasicNodeMaterial(), name: 'lifecycle',
	} ) ), ( error ) => error === failure );
	assert.deepEqual( observed.order, [ 'geometry', 'renderer' ] );

} );

test( 'node harness returns usable capture after releasing its default geometry and renderer', async ( t ) => {

	const observed = observeDisposal( t );
	const material = new MeshBasicNodeMaterial();
	let materialDisposed = false;
	material.addEventListener( 'dispose', () => { materialDisposed = true; } );
	const result = await extractMaterial( () => ( { material, name: 'lifecycle' } ) );
	assert.deepEqual( observed.order, [ 'geometry', 'renderer' ] );
	assert.equal( materialDisposed, false, 'material remains caller-owned' );
	assert.equal( material._listeners.dispose.length, 1, 'capture leaves only the caller listener' );
	assert.match( result.wgslVertex, /@vertex/ );
	assert.match( result.wgslFragment, /@fragment/ );
	assert.equal( result.artifact.__hash, result.hash );
	assert.ok( result.artifact.uniformPlan.length > 0 );

} );

test( 'node harness preserves caller geometry on success and compilation failure', async ( t ) => {

	const observed = observeDisposal( t );
	const material = new MeshBasicNodeMaterial();
	const geometry = new BoxGeometry();
	const mesh = new Mesh( geometry, material );
	const factory = () => ( { material, name: 'lifecycle', objects: [ mesh ] } );
	await extractMaterial( factory );
	// r186's NodeMaterialObserver owns one geometry-version listener backed by
	// a global weak record; it does not retain the temporary renderer.
	const geometryListeners = [ ...( geometry._listeners?.dispose || [] ) ];
	assert.ok( geometryListeners.length <= 1, 'temporary render-object geometry listeners are released' );
	const failure = new Error( 'expected compilation failure' );
	t.mock.method( WebGPURenderer.prototype, 'compileAsync', async () => { throw failure; } );
	await assert.rejects( extractMaterial( factory ), ( error ) => error === failure );
	assert.equal( observed.renderer.mock.callCount(), 2 );
	assert.equal( observed.geometry.mock.callCount(), 0 );
	assert.deepEqual( geometry._listeners?.dispose || [], geometryListeners, 'failed capture adds no geometry listeners' );
	assert.equal( material._listeners?.dispose?.length || 0, 0, 'temporary render objects release caller material listeners' );
	assert.ok( geometry.getAttribute( 'position' ).count > 0 );

} );

test( 'repeated harness captures do not retain temporary renderers through caller materials', async () => {

	const material = new MeshBasicNodeMaterial();
	for ( let index = 0; index < 3; index ++ ) {

		await extractMaterial( () => ( { material, name: 'lifecycle' } ) );
		assert.equal( material._listeners?.dispose?.length || 0, 0 );

	}

} );

test( 'a partially completed compile releases temporary render object listeners before rejecting', async ( t ) => {

	const compile = WebGPURenderer.prototype.compileAsync;
	const failure = new Error( 'failure after pipelines are prepared' );
	t.mock.method( WebGPURenderer.prototype, 'compileAsync', async function ( ...args ) {

		await compile.apply( this, args );
		throw failure;

	} );
	const material = new MeshBasicNodeMaterial();
	await assert.rejects( extractMaterial( () => ( { material, name: 'lifecycle' } ) ), ( error ) => error === failure );
	assert.equal( material._listeners?.dispose?.length || 0, 0 );

} );

test( 'synthetic capture on a shared renderer preserves live render objects and shader cache references', async () => {

	installMockWebGPU();
	const context = createMockGPUCanvasContext();
	const renderer = new WebGPURenderer( { canvas: {
		width: 256, height: 256, clientWidth: 256, clientHeight: 256, style: {},
		getContext: () => context, addEventListener() {}, removeEventListener() {},
	} } );
	await renderer.init();
	const material = new MeshBasicNodeMaterial();
	const geometry = new BoxGeometry();
	const camera = new PerspectiveCamera();
	camera.position.z = 3;
	const scene = new Scene();
	const mesh = new Mesh( geometry, material );
	mesh.frustumCulled = false;
	scene.add( mesh );
	try {

		await renderer.compileAsync( scene, camera );
		const listenerCount = material._listeners.dispose.length;
		const liveStates = new Map( renderer._nodes.nodeBuilderCache );
		assert.ok( listenerCount > 0 && liveStates.size > 0 );
		for ( let index = 0; index < 3; index ++ ) {

			const syntheticScene = new Scene();
			syntheticScene.userData.__tslpSyntheticCaptureScene = true;
			syntheticScene.add( mesh.clone() );
			const artifacts = await compileTSL( renderer, syntheticScene, camera, { materials: [ material ], skipWarmupRender: true } );
			assert.ok( artifacts.byMaterialUuid.get( material.uuid ).vertexShader.length > 0 );
			assert.equal( material._listeners.dispose.length, listenerCount, 'capture leaves the live material listeners intact' );
			for ( const [ key, state ] of liveStates ) assert.equal( renderer._nodes.nodeBuilderCache.get( key ), state );

		}
		await renderer.compileAsync( scene, camera );
		assert.equal( material._listeners.dispose.length, listenerCount, 'live cached render object is reused' );

	} finally {

		material.dispose();
		geometry.dispose();
		renderer.dispose();

	}

} );
