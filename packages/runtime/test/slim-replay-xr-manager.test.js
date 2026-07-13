import test from 'node:test';
import assert from 'node:assert/strict';

import XRManager from '../src/slim-replay-xr-manager.js';

const R184_PROTOTYPE = [
	'constructor',
	'getController',
	'getControllerGrip',
	'getHand',
	'getFoveation',
	'setFoveation',
	'getFramebufferScaleFactor',
	'setFramebufferScaleFactor',
	'getReferenceSpaceType',
	'setReferenceSpaceType',
	'getReferenceSpace',
	'setReferenceSpace',
	'getCamera',
	'getEnvironmentBlendMode',
	'getBinding',
	'getFrame',
	'useMultiview',
	'createQuadLayer',
	'createCylinderLayer',
	'renderLayers',
	'getSession',
	'setSession',
	'updateCamera',
	'_getController',
];

function assertSlimXRError( error ) {

	assert.equal( error && error.code, 'TSLP_SLIM_XR_UNSUPPORTED' );
	assert.equal( error && error.tslPrecompileSlimOnly, true );
	assert.match( error.message, /XR is unavailable in the WebGPU-only slim renderer/ );
	assert.match( error.message, /forceWebGL: true/ );
	return true;

}

test( 'replay XR manager preserves the complete Three r184 prototype', () => {

	assert.deepEqual( Object.getOwnPropertyNames( XRManager.prototype ), R184_PROTOTYPE );

} );

test( 'replay XR manager exposes inert renderer state and EventDispatcher behavior', () => {

	const renderer = {};
	const manager = new XRManager( renderer, true );

	assert.equal( manager._renderer, renderer );
	assert.equal( manager.enabled, false );
	assert.equal( manager.isPresenting, false );
	assert.equal( manager.cameraAutoUpdate, true );
	assert.equal( manager.getEnvironmentBlendMode(), undefined );
	assert.equal( manager.getBinding(), null );
	assert.equal( manager.getFrame(), null );
	assert.equal( manager.getSession(), null );
	assert.equal( manager.useMultiview(), false );
	assert.equal( manager._useMultiviewIfPossible, true );

	let events = 0;
	const listener = () => { events ++; };
	manager.addEventListener( 'probe', listener );
	assert.equal( manager.hasEventListener( 'probe', listener ), true );
	manager.dispatchEvent( { type: 'probe' } );
	manager.removeEventListener( 'probe', listener );
	assert.equal( events, 1 );
	assert.equal( manager.hasEventListener( 'probe', listener ), false );

} );

test( 'replay XR manager preserves idle configuration without claiming a session', async () => {

	const manager = new XRManager( {} );
	const referenceSpace = {};

	manager.setFoveation( 0.25 );
	manager.setFramebufferScaleFactor( 0.5 );
	manager.setReferenceSpaceType( 'bounded-floor' );
	manager.setReferenceSpace( referenceSpace );

	assert.equal( manager._foveation, 0.25 );
	assert.equal( manager.getFoveation(), undefined, 'stock XRManager reports no foveation without an XR layer' );
	assert.equal( manager.getFramebufferScaleFactor(), 0.5 );
	assert.equal( manager.getReferenceSpaceType(), 'bounded-floor' );
	assert.equal( manager.getReferenceSpace(), referenceSpace );

	manager.enabled = true;
	await manager.setSession( null );
	assert.equal( manager.enabled, true, 'RenderPipeline may temporarily toggle the public enabled flag' );
	assert.equal( manager.isPresenting, false );
	assert.equal( manager.getSession(), null );

} );

test( 'replay XR manager fails loudly before any unsupported XR operation', async () => {

	const manager = new XRManager( {} );
	for ( const operation of [
		() => manager.getController( 0 ),
		() => manager.getControllerGrip( 0 ),
		() => manager.getHand( 0 ),
		() => manager.getCamera(),
		() => manager.createQuadLayer(),
		() => manager.createCylinderLayer(),
		() => manager.renderLayers(),
		() => manager.updateCamera( {} ),
		() => manager._getController( 0 ),
	] ) assert.throws( operation, assertSlimXRError );

	await assert.rejects( manager.setSession( {} ), assertSlimXRError );
	assert.equal( manager.getSession(), null, 'a rejected session must not partially mutate adapter state' );
	assert.equal( manager.isPresenting, false );

} );
