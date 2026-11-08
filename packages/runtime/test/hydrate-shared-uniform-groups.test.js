import test from 'node:test';
import assert from 'node:assert/strict';
import { GENERATED_SHARED_UNIFORM_GROUP_KEY } from '@tsl-precompile/contract/dynamic-bindings';
import { hydrateNodeBuilderState } from '../src/hydrator.js';

function fixture( key = 'same-camera-plan' ) {

	const artifact = {
		vertexShader: 'vertex', fragmentShader: 'fragment',
		bindings: [ 'render', 'object' ].map( name => ( { name, bindings: [ { name, kind: 'uniform-buffer', visibility: 7, byteLength: 16 } ] } ) ),
		uniformPlan: [
			{ name: 'render', shared: true, byteLength: 16, slots: [ { name: 'near', offset: 0, size: 4, dtype: 'float', source: { kind: 'camera.near' } } ] },
			{ name: 'object', shared: false, byteLength: 16, slots: [ { name: 'opacity', offset: 0, size: 4, dtype: 'float', source: { kind: 'material.opacity', property: 'opacity' } } ] },
		],
	};
	if ( key ) Object.defineProperty( artifact.uniformPlan[ 0 ], GENERATED_SHARED_UNIFORM_GROUP_KEY, { value: key } );
	return artifact;

}

const hydrate = ( artifact, renderer, context, material = { opacity: 1 } ) => hydrateNodeBuilderState( artifact, material, null, { renderer, renderObject: context ? { context, renderer, material } : null } );

test( 'matching generated camera groups share while object bindings and materials remain independent', () => {

	const renderer = {}, context = {}, scene = {}, camera = { near: 2 };
	const a = hydrate( fixture(), renderer, context, { opacity: 0.2 } );
	const b = hydrate( fixture(), renderer, context, { opacity: 0.8 } );
	assert.equal( a.bindings[ 0 ], b.bindings[ 0 ] );
	assert.notEqual( a.bindings[ 1 ], b.bindings[ 1 ] );
	const aBindings = a.createBindings(), bBindings = b.createBindings();
	assert.equal( aBindings[ 0 ], bBindings[ 0 ] );
	assert.notEqual( aBindings[ 1 ].bindings[ 0 ].buffer, bBindings[ 1 ].bindings[ 0 ].buffer );
	const frame = { renderer, scene, camera, frameId: 1, renderId: 1 };
	a.updateNodes[ 0 ].update( frame ); b.updateNodes[ 0 ].update( frame );
	assert.equal( a.bindings[ 0 ].bindings[ 0 ].buffer[ 0 ], 2 );
	assert.equal( b.bindings[ 0 ].bindings[ 0 ].groupNode.version, 1, 'shared group writes once for the same render context' );
	assert.ok( Math.abs( a.bindings[ 1 ].bindings[ 0 ].buffer[ 0 ] - 0.2 ) < 1e-6 );
	assert.ok( Math.abs( b.bindings[ 1 ].bindings[ 0 ].buffer[ 0 ] - 0.8 ) < 1e-6 );
	b.updateNodes[ 0 ].update( { ...frame, camera: { near: 9 } } );
	assert.equal( a.bindings[ 0 ].bindings[ 0 ].buffer[ 0 ], 9, 'camera changes invalidate the shared writer' );
	a.updateNodes[ 0 ].update( { ...frame, renderId: 2, camera: { near: 3 } } );
	assert.equal( b.bindings[ 0 ].bindings[ 0 ].buffer[ 0 ], 3 );

} );

test( 'sharing is isolated by renderer, render context and generated identity', () => {

	const renderer = {}, context = {}, baseline = hydrate( fixture(), renderer, context ).bindings[ 0 ];
	for ( const state of [
		hydrate( fixture(), {}, context ), hydrate( fixture(), renderer, {} ),
		hydrate( fixture( 'different-plan' ), renderer, context ),
		hydrate( fixture( null ), renderer, context ), hydrate( fixture(), renderer, null ),
	] ) assert.notEqual( state.bindings[ 0 ], baseline );

} );

test( 'released shared bindings are replaced when a material is hydrated again', () => {

	const renderer = {}, context = {};
	const first = hydrate( fixture(), renderer, context ).bindings[ 0 ];
	first.bindings[ 0 ].release();
	const second = hydrate( fixture(), renderer, context ).bindings[ 0 ];
	assert.notEqual( first, second );
	assert.ok( second.bindings[ 0 ].buffer );
	assert.equal( hydrate( fixture(), renderer, context ).bindings[ 0 ], second );

} );

test( 'a shared camera cache hit allocates only the independent material buffer', () => {

	const renderer = {}, context = {};
	const first = hydrate( fixture(), renderer, context );
	const Float32 = globalThis.Float32Array;
	const allocations = [];
	let next;
	try {

		globalThis.Float32Array = new Proxy( Float32, {
			construct( target, args ) {

				const buffer = Reflect.construct( target, args );
				allocations.push( buffer );
				return buffer;

			},
		} );
		next = hydrate( fixture(), renderer, context );

	} finally {

		globalThis.Float32Array = Float32;

	}
	assert.equal( next.bindings[ 0 ], first.bindings[ 0 ] );
	assert.equal( allocations.length, 1, 'a cache hit must not allocate a discarded camera buffer' );
	assert.equal( allocations[ 0 ], next.bindings[ 1 ].bindings[ 0 ].buffer );

} );
