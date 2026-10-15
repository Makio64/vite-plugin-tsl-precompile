import test from 'node:test';
import assert from 'node:assert/strict';
import { createReplayPipelineBatch } from '../src/slim-pipeline-preparation.js';

function fixture( stateful = false ) {

	const events = [], requests = [];
	const renderer = {
		backend: { isWebGPUBackend: true }, _isPreCompiling: false, _precompilationState: null,
		_nodes: {
			updateBefore( object ) { events.push( `before:${ object.id }` ); },
			updateForRender( object ) { events.push( `update:${ object.id }` ); },
			updateAfter( object ) { events.push( `after:${ object.id }` ); },
		},
		_geometries: { updateForRender() {} }, _bindings: { updateForRender() {} },
		_pipelines: { getForRender( object, promises ) {

			const deferred = Promise.withResolvers();
			requests.push( deferred ); promises.push( deferred.promise ); events.push( `pipeline:${ object.id }` );

		} },
	};
	if ( stateful ) {

		renderer._beginPreCompile = state => { renderer._precompilationState = state; };
		renderer._finishPreCompile = () => { renderer._precompilationState = null; };

	}
	const object = ( id, state = { updateBeforeNodes: [], updateAfterNodes: [] } ) => ( {
		id, material: { isPrecompiledMaterial: true }, getNodeBuilderState: () => state,
	} );
	return { renderer, object, events, requests };

}

test( 'pipeline preparation overlaps independent requests and waits for every completion', async () => {

	const { renderer, object, requests, events } = fixture();
	const batch = createReplayPipelineBatch( renderer, null, 3, null );
	for ( let index = 0; index < 3; index ++ ) assert.equal( batch.prepare( object( index ) ), true );
	assert.equal( requests.length, 3, 'all GPU requests are submitted before waiting' );
	assert.equal( batch.size, 3 );
	assert.equal( renderer._isPreCompiling, false );
	let complete = false;
	const pending = batch.flush( 2 ).then( count => { complete = true; return count; } );
	requests[ 2 ].resolve(); requests[ 0 ].resolve();
	await Promise.resolve();
	assert.equal( complete, false );
	requests[ 1 ].resolve();
	assert.equal( await pending, 5 );
	assert.equal( batch.size, 0 );
	assert.deepEqual( events, [ 0, 1, 2 ].flatMap( id => [ `before:${ id }`, `update:${ id }`, `pipeline:${ id }`, `after:${ id }` ] ) );

} );

test( 'pipeline preparation leaves callbacks, unproven state, fallback materials and WebGL ordered', () => {

	const { renderer, object, requests } = fixture();
	const batch = createReplayPipelineBatch( renderer, null, 1, null );
	for ( const state of [ {}, { updateBeforeNodes: [ {} ], updateAfterNodes: [] }, { updateBeforeNodes: [], updateAfterNodes: [ {} ] } ] ) assert.equal( batch.prepare( object( 0, state ) ), false );
	const uncompiled = object( 0 ); uncompiled.material.isPrecompiledMaterial = false;
	assert.equal( batch.prepare( uncompiled ), false );
	renderer.backend.isWebGPUBackend = false;
	assert.equal( batch.prepare( object( 0 ) ), false );
	assert.equal( requests.length, 0 );

} );

test( 'pipeline preparation restores native precompile state after synchronous setup failures', () => {

	for ( const stateful of [ false, true ] ) {

		const { renderer, object } = fixture( stateful );
		const state = {};
		const failure = new Error( 'binding failed' );
		renderer._bindings.updateForRender = () => { throw failure; };
		const batch = createReplayPipelineBatch( renderer, null, 1, state );
		assert.throws( () => batch.prepare( object( 0 ) ), error => error === failure );
		assert.equal( renderer._isPreCompiling, false );
		assert.equal( renderer._precompilationState, null );
		assert.equal( batch.size, 0 );

	}

} );

test( 'pipeline preparation releases failed batches and preserves the original rejection', async () => {

	const { renderer, object, requests } = fixture();
	const batch = createReplayPipelineBatch( renderer, null, 1, null );
	batch.prepare( object( 0 ) );
	const pending = batch.flush( 0 ), failure = new Error( 'GPU compilation failed' );
	requests[ 0 ].reject( failure );
	await assert.rejects( pending, error => error === failure );
	assert.equal( batch.size, 0 );
	batch.prepare( object( 1 ) );
	const next = batch.flush( 0 ); requests[ 1 ].resolve();
	assert.equal( await next, 1 );

} );
