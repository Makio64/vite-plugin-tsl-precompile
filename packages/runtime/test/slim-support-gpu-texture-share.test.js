import test from 'node:test';
import assert from 'node:assert/strict';

import {
	clearTextureViewCache,
	markTextureInitialized,
	shareGPUTextureEntry,
	sharePMREMGPUTexture,
	shareShadowGPUTextureIntoSlim,
} from '../src/slim-support/gpu-texture-share.js';

function fakeDataMap() {

	const store = new WeakMap();
	return {
		store,
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

function fakeRenderer() {

	const backend = fakeDataMap();
	const _textures = fakeDataMap();
	return { backend, _textures };

}

function fakeTexture( name = 'tex' ) {

	return { isTexture: true, name, version: 0 };

}

test( 'clearTextureViewCache strips view-* keys only', () => {

	const data = { texture: 'GPU', format: 'rgba8unorm', 'view-0': {}, 'view-mip-1': {} };
	clearTextureViewCache( data );
	assert.equal( data.texture, 'GPU' );
	assert.equal( data.format, 'rgba8unorm' );
	assert.equal( data[ 'view-0' ], undefined );
	assert.equal( data[ 'view-mip-1' ], undefined );

} );

test( 'markTextureInitialized sets the Textures DataMap flags', () => {

	const renderer = fakeRenderer();
	const tex = fakeTexture(); tex.version = 3;
	markTextureInitialized( renderer, tex );
	const entry = renderer._textures.get( tex );
	assert.equal( entry.initialized, true );
	assert.equal( entry.isDefaultTexture, false );
	assert.equal( entry.version, 3 );
	assert.equal( entry.generation, 3 );
	assert.ok( entry.bindGroups instanceof Set );

} );

test( 'shareGPUTextureEntry copies backend data and marks initialised', () => {

	const source = fakeRenderer();
	const target = fakeRenderer();
	const tex = fakeTexture( 'env' );

	const sourceData = source.backend.get( tex );
	sourceData.texture = { __gpu: true };
	sourceData.format = 'rgba16float';

	const diagnostics = { calls: 0, success: 0, noSourceData: 0, noSourceTexture: 0, names: [], missingNames: [] };
	const ok = shareGPUTextureEntry( target, source, tex, { diagnostics } );

	assert.equal( ok, true );
	assert.equal( diagnostics.calls, 1 );
	assert.equal( diagnostics.success, 1 );
	const targetData = target.backend.get( tex );
	assert.equal( targetData.texture, sourceData.texture );
	assert.equal( targetData.format, 'rgba16float' );
	assert.equal( target._textures.get( tex ).initialized, true );
	assert.deepEqual( diagnostics.names, [ 'env' ] );

} );

test( 'shareGPUTextureEntry reports missing source texture into diagnostics.missingNames', () => {

	const source = fakeRenderer();
	const target = fakeRenderer();
	const tex = fakeTexture( 'shadow-depth' );

	// Source backend entry exists but has no .texture (uninitialised).
	source.backend.get( tex );

	const diagnostics = { calls: 0, success: 0, noSourceData: 0, noSourceTexture: 0, names: [], missingNames: [] };
	const ok = shareGPUTextureEntry( target, source, tex, { diagnostics } );

	assert.equal( ok, false );
	assert.equal( diagnostics.noSourceTexture, 1 );
	assert.deepEqual( diagnostics.missingNames, [ 'shadow-depth' ] );

} );

test( 'shareGPUTextureEntry invalidates pre-existing bind groups on the target', () => {

	const source = fakeRenderer();
	const target = fakeRenderer();
	const tex = fakeTexture();

	source.backend.get( tex ).texture = { __gpu: 'shared' };

	// Pre-populate target with a bind group that references this texture.
	const bindGroup = { id: 'bg-1' };
	const txData = target._textures.get( tex );
	txData.bindGroups = new Set( [ bindGroup ] );
	const bindingsData = target.backend.get( bindGroup );
	bindingsData.groups = { v: 1 };
	bindingsData.versions = [ 1, 2 ];

	const ok = shareGPUTextureEntry( target, source, tex );

	assert.equal( ok, true );
	assert.equal( bindingsData.groups, undefined );
	assert.equal( bindingsData.versions, undefined );
	assert.equal( target._textures.get( tex ).bindGroups.size, 0 );

} );

test( 'sharePMREMGPUTexture bumps PMREM-specific diagnostics keys', () => {

	const slim = fakeRenderer();
	const full = fakeRenderer();
	const pmrem = fakeTexture( 'PMREM.cubeUv' );
	full.backend.get( pmrem ).texture = { __gpu: 'pmrem' };

	const diagnostics = {};
	const ok = sharePMREMGPUTexture( slim, full, pmrem, { diagnostics } );

	assert.equal( ok, true );
	assert.equal( diagnostics.shareCalls, 1 );
	assert.equal( diagnostics.shareSuccess, 1 );
	assert.equal( slim.backend.get( pmrem ).texture, full.backend.get( pmrem ).texture );

} );

test( 'sharePMREMGPUTexture records shareMissingTexture when full side has no GPU texture yet', () => {

	const slim = fakeRenderer();
	const full = fakeRenderer();
	const pmrem = fakeTexture();
	full.backend.get( pmrem ); // entry exists, no .texture

	const diagnostics = {};
	const ok = sharePMREMGPUTexture( slim, full, pmrem, { diagnostics } );

	assert.equal( ok, false );
	assert.equal( diagnostics.shareMissingTexture, 1 );
	assert.equal( diagnostics.shareSuccess, undefined );

} );

test( 'shareShadowGPUTextureIntoSlim bumps the JS texture version and clears view cache', () => {

	const slim = fakeRenderer();
	const full = fakeRenderer();
	const depthMap = fakeTexture( 'shadow.depth' );
	depthMap.version = 5;

	const fullData = full.backend.get( depthMap );
	fullData.texture = { __gpu: 'depth' };
	fullData.format = 'depth32float';

	const slimData = slim.backend.get( depthMap );
	slimData[ 'view-0' ] = { stale: true };

	const ok = shareShadowGPUTextureIntoSlim( depthMap, full, slim );

	assert.equal( ok, true );
	assert.equal( depthMap.version, 6, 'JS version was bumped' );
	assert.equal( slimData.texture, fullData.texture );
	assert.equal( slimData.format, 'depth32float' );
	assert.equal( slimData.__tslpSharedShadowGPUTexture, fullData.texture );
	assert.equal( slimData[ 'view-0' ], undefined, 'stale view cache cleared' );
	assert.equal( slimData.version, 6 );
	assert.equal( fullData.version, 6, 'both renderers see the bumped version' );
	assert.equal( slim._textures.get( depthMap ).initialized, true );
	assert.equal( full._textures.get( depthMap ).initialized, true );

} );

test( 'shareGPUTextureEntry catches errors and forwards to onError', () => {

	const target = fakeRenderer();
	const source = fakeRenderer();
	const tex = fakeTexture( 'broken' );
	source.backend.get( tex ).texture = {}; // exists
	// Force a throw inside the function by making target backend.get throw.
	target.backend.get = () => { throw new Error( 'kaboom' ); };

	const errors = [];
	const ok = shareGPUTextureEntry( target, source, tex, { onError: ( err, t ) => errors.push( [ err.message, t.name ] ) } );

	assert.equal( ok, false );
	assert.deepEqual( errors, [ [ 'kaboom', 'broken' ] ] );

} );
