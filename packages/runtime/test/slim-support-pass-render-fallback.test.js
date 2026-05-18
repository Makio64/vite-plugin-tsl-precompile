import test from 'node:test';
import assert from 'node:assert/strict';

import { renderPassWithFullRenderer, sharePassRenderTargetTextures } from '../src/slim-support/pass-render-fallback.js';

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
		setSize( width, height, updateStyle ) {

			this._lastSize = { width, height, updateStyle };

		},
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

	return {
		toneMapping: 4,
		toneMappingExposure: 2.0,
		outputColorSpace: 'srgb-linear',
		getDrawingBufferSize( target ) {

			target.set( 640, 360 );
			return target;

		},
	};

}

function fakeDataMap() {

	const store = new WeakMap();
	return {
		get( key ) {

			let entry = store.get( key );
			if ( ! entry ) {

				entry = {};
				store.set( key, entry );

			}
			return entry;

		},
	};

}

function fakeTextureRenderer() {

	return { backend: fakeDataMap(), _textures: fakeDataMap() };

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
	assert.deepEqual( full._lastSize, { width: 640, height: 360, updateStyle: false } );

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

test( 'sharePassRenderTargetTextures shares color MRT and depth textures into slim', () => {

	const slim = fakeTextureRenderer();
	const full = fakeTextureRenderer();
	const colorA = { isTexture: true, name: 'color-a', version: 2 };
	const colorB = { isTexture: true, name: 'color-b', version: 3 };
	const depth = { isTexture: true, name: 'depth', version: 4 };
	full.backend.get( colorA ).texture = { gpu: 'a' };
	full.backend.get( colorB ).texture = { gpu: 'b' };
	full.backend.get( depth ).texture = { gpu: 'd' };

	const diagnostics = { calls: 0, success: 0, noSourceData: 0, noSourceTexture: 0, names: [], missingNames: [] };
	const stats = sharePassRenderTargetTextures( {
		passNode: { renderTarget: { textures: [ colorA, colorB ], depthTexture: depth } },
		slimRenderer: slim,
		fullRenderer: full,
		diagnostics,
	} );

	assert.deepEqual( stats, { texturesShared: 2, depthShared: true } );
	assert.equal( slim.backend.get( colorA ).texture, full.backend.get( colorA ).texture );
	assert.equal( slim.backend.get( colorB ).texture, full.backend.get( colorB ).texture );
	assert.equal( slim.backend.get( depth ).texture, full.backend.get( depth ).texture );
	assert.equal( slim._textures.get( colorA ).initialized, true );
	assert.equal( diagnostics.calls, 3 );
	assert.equal( diagnostics.success, 3 );

} );
