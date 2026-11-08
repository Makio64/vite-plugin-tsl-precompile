import test from 'node:test';
import assert from 'node:assert/strict';
import { beginSyntheticCaptureRenderObjects } from '../../src/vendor/capture-render-object-lifecycle.js';
import { observeRenderObjectRequests } from '../../src/vendor/render-object-observer.js';

function fixture( synthetic = true ) {

	const material = { uuid: 'borrowed-material' };
	const object = { geometry: {}, material };
	const scene = { userData: { __tslpSyntheticCaptureScene: synthetic }, children: [ object ] };
	const renderer = {
		_objects: { get: ( renderObject ) => renderObject },
		_nodes: { getForRenderCacheKey: () => 1, nodeBuilderCache: new Map() },
	};
	return { renderer, scene, object, material };

}

test( 'synthetic lifecycle releases only exact owned scene/object pairs once', () => {

	const { renderer, scene, object, material } = fixture();
	const disposed = [];
	const candidate = ( name, ownerScene, ownerObject ) => ( {
		scene: ownerScene, object: ownerObject, material,
		dispose: () => disposed.push( name ),
	} );
	const owned = candidate( 'owned', scene, object );
	const liveScene = candidate( 'live-scene', {}, object );
	const unrelatedObject = candidate( 'unrelated-object', scene, { geometry: {}, material } );
	const original = renderer._objects.get;
	const release = beginSyntheticCaptureRenderObjects( renderer, scene );
	for ( const renderObject of [ owned, liveScene, unrelatedObject, owned ] ) renderer._objects.get( renderObject );
	assert.deepEqual( disposed, [] );
	release();
	release();
	assert.deepEqual( disposed, [ 'owned' ] );
	assert.equal( renderer._objects.get, original );

} );

test( 'synthetic lifecycle shares the request adapter with existing observers', () => {

	const { renderer, scene, object, material } = fixture();
	const observed = [];
	const stop = observeRenderObjectRequests( renderer, ( event ) => observed.push( event.renderObject ) );
	const wrapper = renderer._objects.get;
	const release = beginSyntheticCaptureRenderObjects( renderer, scene );
	let disposed = false;
	const renderObject = { scene, object, material, dispose() { disposed = true; } };
	assert.equal( renderer._objects.get, wrapper );
	renderer._objects.get( renderObject );
	release();
	assert.equal( disposed, true );
	assert.equal( renderer._objects.get, wrapper, 'other observer retains the shared wrapper' );
	renderer._objects.get( {} );
	assert.equal( observed.length, 2 );
	stop();

} );

test( 'ordinary scenes do not install synthetic cleanup or dispose render objects', () => {

	const { renderer, scene, object, material } = fixture( false );
	const original = renderer._objects.get;
	const release = beginSyntheticCaptureRenderObjects( renderer, scene );
	let disposed = false;
	renderer._objects.get( { scene, object, material, dispose() { disposed = true; } } );
	release();
	assert.equal( disposed, false );
	assert.equal( renderer._objects.get, original );

} );

test( 'native fullscreen cleanup owns only the explicit isolated quad and material within a shared dummy scene', () => {

	const { renderer, scene, object, material } = fixture( false );
	object.isQuadMesh = true;
	const dummyScene = { userData: {} };
	const disposed = [];
	const release = beginSyntheticCaptureRenderObjects( renderer, scene, { fullscreenQuad: object } );
	for ( const [ name, candidateObject, candidateMaterial ] of [
		[ 'isolated', object, material ], [ 'live-quad', { isQuadMesh: true, geometry: {}, material }, material ], [ 'replaced-material', object, {} ],
	] ) renderer._objects.get( { scene: dummyScene, object: candidateObject, material: candidateMaterial, dispose() { disposed.push( name ); } } );
	release();
	assert.deepEqual( disposed, [ 'isolated' ] );
	assert.deepEqual( dummyScene, { userData: {} }, 'native shared scene is never marked as capture-owned' );

} );

test( 'synthetic cleanup attempts every owned disposal and reports the first failure', () => {

	const { renderer, scene, object, material } = fixture();
	const secondObject = { geometry: {}, material };
	scene.children.push( secondObject );
	const firstFailure = new Error( 'first disposal failure' );
	const disposed = [];
	const original = renderer._objects.get;
	const release = beginSyntheticCaptureRenderObjects( renderer, scene );
	renderer._objects.get( {
		scene, object, material,
		dispose() { disposed.push( 'first' ); throw firstFailure; },
	} );
	renderer._objects.get( {
		scene, object: secondObject, material,
		dispose() { disposed.push( 'second' ); throw new Error( 'second disposal failure' ); },
	} );
	assert.throws( release, ( error ) => error === firstFailure );
	assert.deepEqual( disposed, [ 'first', 'second' ] );
	assert.equal( renderer._objects.get, original );
	assert.doesNotThrow( release, 'cleanup is idempotent after failure' );

} );
