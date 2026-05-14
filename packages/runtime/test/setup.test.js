import test from 'node:test';
import assert from 'node:assert/strict';

import { setupPrecompile } from '../src/setup.js';
import { __cloneLightsIntoForTests, __resetForTests as resetMarkerForTests } from '../src/precompile-marker.js';

const MARKER_METHOD = 'precompile';

function fakeThree() {

	const Material = function Material() {};
	Material.prototype = {};
	return { Material, REVISION: '184' };

}

function fakeRenderer( { initialised = false, withInit = false } = {} ) {

	const renderer = {
		render() {},
	};
	if ( withInit ) {
		renderer.init = async () => {
			await Promise.resolve();
			renderer.backend = {};
			return renderer;
		};
	}
	if ( initialised ) renderer.backend = {};
	return renderer;

}

function freshHarness() {

	resetMarkerForTests();
	// `installPrecompileMarker` skips re-install when the method already exists
	// on the prototype, so each test gets its own Material class.
	return { three: fakeThree() };

}

test( 'setupPrecompile installs marker and resolves ready after init', async () => {

	const { three } = freshHarness();
	const renderer = fakeRenderer( { withInit: true } );

	const setup = setupPrecompile( { three, renderer } );

	// Marker installed synchronously, regardless of init() ordering.
	assert.equal( typeof three.Material.prototype[ MARKER_METHOD ], 'function' );
	assert.ok( setup && typeof setup.ready.then === 'function', 'returns { ready }' );
	assert.equal( typeof setup.captureAux, 'function' );
	assert.equal( renderer.__tslpRenderWrapped, undefined, 'renderer is not registered before init resolves' );

	await renderer.init();
	await setup.ready;
	assert.equal( renderer.__tslpRenderWrapped, true, 'setDevRenderer ran after ready' );

} );

test( 'setupPrecompile registers immediately when the renderer is already initialised', async () => {

	const { three } = freshHarness();
	const renderer = fakeRenderer( { initialised: true } );

	const setup = setupPrecompile( { three, renderer } );

	// Already-initialised path: setDevRenderer ran synchronously, ready is a
	// resolved promise.
	assert.equal( renderer.__tslpRenderWrapped, true );
	await setup.ready; // does not hang

} );

test( 'setupPrecompile is idempotent under double-call', async () => {

	const { three } = freshHarness();
	const renderer = fakeRenderer( { initialised: true } );

	const first = setupPrecompile( { three, renderer } );
	const second = setupPrecompile( { three, renderer } );

	await first.ready;
	await second.ready;
	assert.equal( renderer.__tslpRenderWrapped, true );
	// Marker method still single; calling install twice should not throw.
	assert.equal( typeof three.Material.prototype[ MARKER_METHOD ], 'function' );

} );

test( 'setupPrecompile short-circuits in slim mode via __TSLP_SLIM__ sentinel', async () => {

	resetMarkerForTests();
	const slimThree = { __TSLP_SLIM__: true };
	const renderer = fakeRenderer( { initialised: true } );

	const setup = setupPrecompile( { three: slimThree, renderer } );

	await setup.ready;
	// No marker install, no render wrap — slim does not need either.
	assert.equal( renderer.__tslpRenderWrapped, undefined );
	const aux = await setup.captureAux();
	assert.deepEqual( aux, [] );

} );

test( 'setupPrecompile short-circuits when the renderer comes from the slim bundle', async () => {

	const { three } = freshHarness();
	const renderer = fakeRenderer( { initialised: true } );
	renderer.constructor = { __TSLP_SLIM__: true };

	const setup = setupPrecompile( { three, renderer } );

	await setup.ready;
	assert.equal( renderer.__tslpRenderWrapped, undefined );
	assert.equal( three.Material.prototype[ MARKER_METHOD ], undefined );

} );

test( 'setupPrecompile throws on missing renderer', () => {

	const { three } = freshHarness();
	assert.throws( () => setupPrecompile( { three } ), /opts\.renderer is required/ );

} );

test( 'setupPrecompile throws on missing three in non-slim mode', () => {

	resetMarkerForTests();
	const renderer = fakeRenderer();
	assert.throws( () => setupPrecompile( { renderer } ), /opts\.three is required/ );

} );

test( 'setupPrecompile throws when aux is requested without scene/camera', () => {

	const { three } = freshHarness();
	const renderer = fakeRenderer();
	assert.throws(
		() => setupPrecompile( { three, renderer, aux: true } ),
		/aux capture needs/,
	);

} );

test( 'precompile light cloning strips helper children from synthetic lights', () => {

	class FakeObject3D {

		constructor() {

			this.children = [];
			this.parent = null;
			this.isObject3D = true;
			this.matrixWorld = null;

		}

		add( child ) {

			this.children.push( child );
			child.parent = this;

		}

		remove( child ) {

			this.children = this.children.filter( ( item ) => item !== child );
			child.parent = null;

		}

		traverse( visitor ) {

			visitor( this );
			for ( const child of this.children ) child.traverse ? child.traverse( visitor ) : visitor( child );

		}

		clone() {

			const cloned = new FakeObject3D();
			cloned.isLight = this.isLight;
			cloned.target = this.target;
			for ( const child of this.children ) cloned.add( child.clone ? child.clone() : { ...child } );
			return cloned;

		}

	}

	const scene = new FakeObject3D();
	scene.isScene = true;
	scene.updateMatrixWorld = () => {};
	const light = new FakeObject3D();
	light.isLight = true;
	const helper = new FakeObject3D();
	helper.isHelper = true;
	light.add( helper );
	scene.add( light );
	const dest = new FakeObject3D();

	__cloneLightsIntoForTests( scene, dest );

	assert.equal( dest.children.length, 1 );
	assert.equal( dest.children[ 0 ].isLight, true );
	assert.equal( dest.children[ 0 ].children.length, 0 );

} );
