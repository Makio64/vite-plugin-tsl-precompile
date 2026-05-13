import test from 'node:test';
import assert from 'node:assert/strict';

import { setupPrecompile } from '../src/setup.js';
import { __resetForTests as resetMarkerForTests } from '../src/precompile-marker.js';

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
