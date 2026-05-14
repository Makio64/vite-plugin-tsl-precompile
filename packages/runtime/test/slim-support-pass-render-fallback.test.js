import test from 'node:test';
import assert from 'node:assert/strict';

import { renderPassWithFullRenderer } from '../src/slim-support/pass-render-fallback.js';

function fakeFullRenderer() {

	const fr = {
		toneMapping: 0,
		toneMappingExposure: 1,
		outputColorSpace: 'srgb',
		autoClear: false,
		transparent: false,
		opaque: true,
		contextNode: null,
		_target: { _initial: true },
		_mrt: { _initial: true },
		_renders: 0,
		getRenderTarget() { return this._target; },
		setRenderTarget( t ) { this._target = t; },
		getMRT() { return this._mrt; },
		setMRT( m ) { this._mrt = m; },
		render( scene, camera ) {

			this._renders++;
			this._lastRenderedScene = scene;
			this._lastRenderedCamera = camera;

		},
	};
	return fr;

}

function fakePassNode() {

	return {
		isPassNode: true,
		scene: { isScene: true, name: 'pass-scene' },
		camera: { isCamera: true, name: 'pass-camera' },
		renderTarget: { width: 256, height: 256 },
		transparent: true,
		opaque: false,
	};

}

function fakeSlimRenderer() {

	return { toneMapping: 4, toneMappingExposure: 2.0, outputColorSpace: 'srgb-linear' };

}

test( 'renderPassWithFullRenderer forwards slim tone-mapping state to full', () => {

	const slim = fakeSlimRenderer();
	const full = fakeFullRenderer();
	const passNode = fakePassNode();

	const ok = renderPassWithFullRenderer( { passNode, slimRenderer: slim, fullRenderer: full } );

	assert.equal( ok, true );
	assert.equal( full._renders, 1 );
	// The render itself ran with slim's tone-mapping values applied.
	assert.equal( full._lastRenderedScene, passNode.scene );
	assert.equal( full._lastRenderedCamera, passNode.camera );

} );

test( 'renderPassWithFullRenderer restores full renderer state after render', () => {

	const slim = fakeSlimRenderer();
	const full = fakeFullRenderer();
	const passNode = fakePassNode();
	const initialTarget = full._target;
	const initialMRT = full._mrt;

	renderPassWithFullRenderer( { passNode, slimRenderer: slim, fullRenderer: full } );

	assert.equal( full._target, initialTarget, 'render target restored' );
	assert.equal( full._mrt, initialMRT, 'MRT restored' );
	assert.equal( full.autoClear, false, 'autoClear restored to initial' );
	assert.equal( full.transparent, false, 'transparent restored to initial' );
	assert.equal( full.opaque, true, 'opaque restored to initial' );

} );

test( 'renderPassWithFullRenderer restores state even when render throws', () => {

	const slim = fakeSlimRenderer();
	const full = fakeFullRenderer();
	const passNode = fakePassNode();
	const initialTarget = full._target;
	full.render = () => { throw new Error( 'boom' ); };

	let caught = null;
	const ok = renderPassWithFullRenderer( {
		passNode, slimRenderer: slim, fullRenderer: full,
		onError: ( err ) => { caught = err; },
	} );

	assert.equal( ok, false );
	assert.equal( caught && caught.message, 'boom' );
	assert.equal( full._target, initialTarget, 'render target still restored after throw' );

} );

test( 'renderPassWithFullRenderer returns false on missing inputs', () => {

	assert.equal( renderPassWithFullRenderer( {} ), false );
	assert.equal( renderPassWithFullRenderer( { passNode: {}, slimRenderer: {}, fullRenderer: {} } ), false, 'missing scene/renderTarget on passNode' );

} );

test( 'renderPassWithFullRenderer runs the beforeRender hook with state already saved', () => {

	const slim = fakeSlimRenderer();
	const full = fakeFullRenderer();
	const passNode = fakePassNode();
	const observed = [];

	renderPassWithFullRenderer( {
		passNode, slimRenderer: slim, fullRenderer: full,
		beforeRender: () => {

			observed.push( {
				renderTargetIsPassTarget: full._target === passNode.renderTarget,
				autoClear: full.autoClear,
				transparent: full.transparent,
			} );

		},
	} );

	assert.deepEqual( observed, [ { renderTargetIsPassTarget: true, autoClear: true, transparent: true } ] );

} );
