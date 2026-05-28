import test from 'node:test';
import assert from 'node:assert/strict';

import {
	renderOffscreenOverrideWithFullRenderer,
	renderPassWithFullRenderer,
	sharePassRenderTargetTextures,
	shareRenderTargetTextures,
} from '../src/slim-support/pass-render-fallback.js';

function fakeFullRenderer() {

	const fr = {
		toneMapping: 0,
		toneMappingExposure: 1,
		outputColorSpace: 'srgb',
		autoClear: false,
		transparent: false,
		opaque: true,
		contextNode: null,
		_clearAlpha: 1,
		_target: { _initial: true },
		_mrt: { _initial: true },
		_renders: 0,
		getRenderTarget() { return this._target; },
		setRenderTarget( t ) { this._target = t; },
		getMRT() { return this._mrt; },
		setMRT( m ) { this._mrt = m; },
		getClearAlpha() { return this._clearAlpha; },
		setClearAlpha( alpha ) { this._clearAlpha = alpha; },
		setSize( width, height, updateStyle ) {

			this._lastSize = { width, height, updateStyle };

		},
		render( scene, camera ) {

			this._renders++;
			this._lastRenderedScene = scene;
			this._lastRenderedCamera = camera;
			this._lastRenderedMRT = this._mrt;

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
		autoClear: true,
		_clearAlpha: 0.25,
		_target: null,
		getClearAlpha() { return this._clearAlpha; },
		getRenderTarget() { return this._target; },
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

test( 'renderOffscreenOverrideWithFullRenderer renders current offscreen target and shares textures', () => {

	const slim = fakeSlimRenderer();
	const full = fakeFullRenderer();
	const color = { isTexture: true, name: 'offscreen-color', version: 2 };
	const depth = { isTexture: true, name: 'offscreen-depth', version: 3 };
	const target = { texture: color, depthTexture: depth };
	const scene = { overrideMaterial: { name: 'depth-override' } };
	const camera = { name: 'shadow-camera' };
	slim._target = target;
	full.backend = fakeDataMap();
	full._textures = fakeDataMap();
	slim.backend = fakeDataMap();
	slim._textures = fakeDataMap();
	full.backend.get( color ).texture = { gpu: 'color' };
	full.backend.get( depth ).texture = { gpu: 'depth' };

	const initialTarget = full._target;
	const initialMRT = full._mrt;
	const stats = renderOffscreenOverrideWithFullRenderer( {
		scene,
		camera,
		slimRenderer: slim,
		fullRenderer: full,
	} );

	assert.deepEqual( stats, { rendered: true, texturesShared: 1, depthShared: true } );
	assert.equal( full._lastRenderedScene, scene );
	assert.equal( full._lastRenderedCamera, camera );
	assert.deepEqual( full._lastSize, { width: 640, height: 360, updateStyle: false } );
	assert.equal( full._target, initialTarget, 'full render target restored' );
	assert.equal( full._mrt, initialMRT, 'full MRT restored' );
	assert.equal( full.autoClear, false, 'autoClear restored' );
	assert.equal( full._clearAlpha, 1, 'clear alpha restored' );
	assert.equal( slim.backend.get( color ).texture, full.backend.get( color ).texture );
	assert.equal( slim.backend.get( depth ).texture, full.backend.get( depth ).texture );

} );

test( 'renderOffscreenOverrideWithFullRenderer supports source-material wrappers', () => {

	const slim = fakeSlimRenderer();
	const full = fakeFullRenderer();
	const target = { texture: { isTexture: true, name: 'target' } };
	const scene = { overrideMaterial: { isPrecompiledMaterial: true } };
	const camera = {};
	slim._target = target;
	let insideWrapper = false;
	full.render = () => {

		assert.equal( insideWrapper, true );
		full._renders ++;

	};

	const stats = renderOffscreenOverrideWithFullRenderer( {
		scene,
		camera,
		slimRenderer: slim,
		fullRenderer: full,
		shareTextures: false,
		withSourceMaterials: ( targetScene, render ) => {

			assert.equal( targetScene, scene );
			insideWrapper = true;
			try {

				render();

			} finally {

				insideWrapper = false;

			}

		},
	} );

	assert.deepEqual( stats, { rendered: true, texturesShared: 0, depthShared: false } );
	assert.equal( full._renders, 1 );
	assert.equal( insideWrapper, false );

} );

test( 'renderOffscreenOverrideWithFullRenderer can temporarily map scene materials', () => {

	const slim = fakeSlimRenderer();
	const full = fakeFullRenderer();
	const target = { texture: { isTexture: true, name: 'target' } };
	const precompiledOverride = { isPrecompiledMaterial: true, name: 'precompiled-override' };
	const sourceOverride = { name: 'source-override' };
	const precompiledMaterial = { isPrecompiledMaterial: true, name: 'precompiled-material' };
	const sourceMaterial = { name: 'source-material' };
	const object = { material: precompiledMaterial };
	const scene = {
		overrideMaterial: precompiledOverride,
		traverse( visit ) { visit( object ); },
	};
	slim._target = target;
	full.render = () => {

		assert.equal( scene.overrideMaterial, sourceOverride );
		assert.equal( object.material, sourceMaterial );

	};

	const stats = renderOffscreenOverrideWithFullRenderer( {
		scene,
		camera: {},
		slimRenderer: slim,
		fullRenderer: full,
		shareTextures: false,
		materialMapper( material ) {

			if ( material === precompiledOverride ) return sourceOverride;
			if ( material === precompiledMaterial ) return sourceMaterial;
			return null;

		},
	} );

	assert.equal( stats.rendered, true );
	assert.equal( scene.overrideMaterial, precompiledOverride, 'override material restored' );
	assert.equal( object.material, precompiledMaterial, 'object material restored' );

} );

test( 'renderOffscreenOverrideWithFullRenderer returns empty stats on missing override or target', () => {

	assert.deepEqual( renderOffscreenOverrideWithFullRenderer( {} ), { rendered: false, texturesShared: 0, depthShared: false } );
	assert.deepEqual(
		renderOffscreenOverrideWithFullRenderer( {
			scene: { overrideMaterial: {} },
			camera: {},
			slimRenderer: fakeSlimRenderer(),
			fullRenderer: fakeFullRenderer(),
		} ),
		{ rendered: false, texturesShared: 0, depthShared: false },
	);

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

test( 'renderPassWithFullRenderer forwards pass MRT during render', () => {

	const slim = fakeSlimRenderer();
	const full = fakeFullRenderer();
	const passNode = fakePassNode();
	const passMRT = { outputNodes: { output: {}, velocity: {} } };
	passNode._mrt = passMRT;
	const initialMRT = full._mrt;

	const ok = renderPassWithFullRenderer( { passNode, slimRenderer: slim, fullRenderer: full } );

	assert.equal( ok, true );
	assert.equal( full._lastRenderedMRT, passMRT, 'pass MRT forwarded to full renderer' );
	assert.equal( full._mrt, initialMRT, 'previous full renderer MRT restored' );

} );

test( 'renderPassWithFullRenderer reads pass MRT from getMRT when available', () => {

	const slim = fakeSlimRenderer();
	const full = fakeFullRenderer();
	const passNode = fakePassNode();
	const passMRT = { outputNodes: { output: {}, normal: {} } };
	passNode.getMRT = () => passMRT;

	const ok = renderPassWithFullRenderer( { passNode, slimRenderer: slim, fullRenderer: full } );

	assert.equal( ok, true );
	assert.equal( full._lastRenderedMRT, passMRT );

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

test( 'shareRenderTargetTextures shares a bare render target into slim', () => {

	const slim = fakeTextureRenderer();
	const full = fakeTextureRenderer();
	const color = { isTexture: true, name: 'color', version: 1 };
	full.backend.get( color ).texture = { gpu: 'color' };

	const stats = shareRenderTargetTextures( {
		renderTarget: { texture: color },
		slimRenderer: slim,
		fullRenderer: full,
	} );

	assert.deepEqual( stats, { texturesShared: 1, depthShared: false } );
	assert.equal( slim.backend.get( color ).texture, full.backend.get( color ).texture );

} );
