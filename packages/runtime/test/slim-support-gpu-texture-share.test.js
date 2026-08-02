import test from 'node:test';
import assert from 'node:assert/strict';

import {
	clearTextureViewCache,
	invalidateTextureResourceBindings,
	isBorrowedShadowRenderTargetTexture,
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

test( 'borrowed shadow ownership covers every attachment of the render target', () => {

	const renderer = fakeRenderer();
	const color = fakeTexture( 'ShadowMap' );
	const depth = fakeTexture( 'ShadowDepthTexture' );
	const renderTarget = { textures: [ color ], texture: color, depthTexture: depth };
	color.renderTarget = renderTarget;
	depth.renderTarget = renderTarget;
	const gpuDepth = { id: 'full-renderer-shadow-depth' };
	const depthData = renderer.backend.get( depth );
	depthData.texture = gpuDepth;
	depthData.__tslpSharedShadowGPUTexture = gpuDepth;

	assert.equal( isBorrowedShadowRenderTargetTexture( renderer, color ), true );
	assert.equal( isBorrowedShadowRenderTargetTexture( renderer, depth ), true );
	assert.equal( isBorrowedShadowRenderTargetTexture( renderer, fakeTexture( 'unrelated' ) ), false );

	depthData.__tslpSharedShadowGPUTexture = { id: 'stale-marker' };
	assert.equal( isBorrowedShadowRenderTargetTexture( renderer, color ), false );

} );

test( 'invalidateTextureResourceBindings clears views and every cached bind group', () => {

	const renderer = fakeRenderer();
	const texture = fakeTexture( 'resized-effect' );
	const bindGroup = { id: 'effect-bind-group' };
	const backendData = renderer.backend.get( texture );
	backendData.texture = { id: 'replacement-gpu-texture' };
	backendData[ 'view-0' ] = { id: 'stale-view' };
	const textureData = renderer._textures.get( texture );
	textureData.bindGroups = new Set( [ bindGroup ] );
	const bindingData = renderer.backend.get( bindGroup );
	bindingData.groups = { id: 'cached-group' };
	bindingData.versions = [ 1 ];

	assert.equal( invalidateTextureResourceBindings( renderer, texture ), true );
	assert.equal( backendData[ 'view-0' ], undefined );
	assert.equal( textureData.bindGroups.size, 0 );
	assert.equal( bindingData.groups, undefined );
	assert.equal( bindingData.versions, undefined );

} );

test( 'invalidateTextureResourceBindings fails closed without renderer cache APIs', () => {

	assert.equal( invalidateTextureResourceBindings( { backend: { get() {} } }, fakeTexture() ), false );
	assert.equal( invalidateTextureResourceBindings( null, fakeTexture() ), false );

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
	assert.equal( tex.version, 1 );
	assert.equal( sourceData.version, 1 );
	assert.equal( targetData.version, 1 );
	assert.equal( target._textures.get( tex ).initialized, true );
	assert.deepEqual( diagnostics.names, [ 'env' ] );

} );

test( 'shareGPUTextureEntry can invalidate only the target generation', () => {

	const source = fakeRenderer();
	const target = fakeRenderer();
	const texture = fakeTexture( 'dynamic-effect-output' );
	texture.version = 4;
	source.backend.get( texture ).texture = { __gpu: 'effect-output' };
	source._textures.get( texture ).version = 4;
	source._textures.get( texture ).generation = 4;

	assert.equal( shareGPUTextureEntry( target, source, texture, { bumpVersion: false } ), true );
	assert.equal( texture.version, 4, 'the shared JS texture version remains source-stable' );
	assert.equal( source._textures.get( texture ).generation, 4, 'the source renderer generation remains untouched' );
	assert.equal( target._textures.get( texture ).version, 4 );
	assert.equal( target._textures.get( texture ).generation, 5, 'only the target bind-group generation advances' );

} );

test( 'shareGPUTextureEntry is a strict no-op for the same renderer', () => {

	const renderer = fakeRenderer();
	const texture = fakeTexture( 'nested-effect-target' );
	texture.version = 7;
	const backendData = renderer.backend.get( texture );
	backendData.texture = { __gpu: 'effect-target' };
	backendData[ 'view-0' ] = { __gpuView: 'live-view' };
	const bindGroup = { id: 'live-effect-bind-group' };
	const textureData = renderer._textures.get( texture );
	textureData.bindGroups = new Set( [ bindGroup ] );
	const bindGroupData = renderer.backend.get( bindGroup );
	bindGroupData.groups = { __gpu: 'live-bind-group' };
	bindGroupData.versions = [ 7 ];
	const diagnostics = { calls: 0, success: 0 };

	assert.equal( shareGPUTextureEntry( renderer, renderer, texture, { diagnostics } ), true );
	assert.equal( texture.version, 7 );
	assert.ok( backendData[ 'view-0' ] );
	assert.equal( textureData.bindGroups.has( bindGroup ), true );
	assert.ok( bindGroupData.groups );
	assert.deepEqual( bindGroupData.versions, [ 7 ] );
	assert.deepEqual( diagnostics, { calls: 0, success: 0 } );

} );

test( 'shareGPUTextureEntry preserves an already-shared cross-renderer resource', () => {

	const source = fakeRenderer();
	const target = fakeRenderer();
	const texture = fakeTexture( 'recurring-effect-target' );
	texture.version = 9;
	const gpuTexture = { __gpu: 'shared-effect-target' };
	source.backend.get( texture ).texture = gpuTexture;
	target.backend.get( texture ).texture = gpuTexture;
	target.backend.get( texture )[ 'view-0' ] = { __gpuView: 'live-view' };
	const bindGroup = { id: 'live-effect-bind-group' };
	target._textures.get( texture ).bindGroups = new Set( [ bindGroup ] );
	target.backend.get( bindGroup ).groups = { __gpu: 'live-bind-group' };
	const diagnostics = {};

	assert.equal( shareGPUTextureEntry( target, source, texture, { diagnostics } ), true );
	assert.equal( texture.version, 9 );
	assert.ok( target.backend.get( texture )[ 'view-0' ] );
	assert.equal( target._textures.get( texture ).bindGroups.has( bindGroup ), true );
	assert.ok( target.backend.get( bindGroup ).groups );
	assert.equal( diagnostics.calls, 1 );
	assert.equal( diagnostics.alreadyShared, 1 );

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

test( 'shareGPUTextureEntry refuses to promote a source default-texture placeholder', () => {

	const source = fakeRenderer();
	const target = fakeRenderer();
	const tex = fakeTexture( 'late-data-texture' );
	const placeholder = { __gpu: '1x1-default' };
	source.backend.get( tex ).texture = placeholder;
	source._textures.get( tex ).isDefaultTexture = true;
	const diagnostics = {};

	const ok = shareGPUTextureEntry( target, source, tex, { diagnostics } );

	assert.equal( ok, false );
	assert.equal( diagnostics.calls, 1 );
	assert.equal( diagnostics.sourceDefaultTexture, 1 );
	assert.equal( diagnostics.success, undefined );
	assert.equal( target.backend.get( tex ).texture, undefined );
	assert.equal( target._textures.get( tex ).initialized, undefined );
	assert.equal( tex.version, 0, 'failed sharing must not advance the live texture version' );

} );

test( 'shareGPUTextureEntry initializes render-target-owned textures before sharing', () => {

	const source = fakeRenderer();
	const target = fakeRenderer();
	const tex = fakeTexture( 'postprocess-output' );
	const rt = { texture: tex };
	tex.renderTarget = rt;
	let initializedTarget = null;
	source.initRenderTarget = ( targetToInit ) => {

		initializedTarget = targetToInit;
		source.backend.get( tex ).texture = { __gpu: 'late' };

	};

	const ok = shareGPUTextureEntry( target, source, tex );

	assert.equal( ok, true );
	assert.equal( initializedTarget, rt );
	assert.equal( target.backend.get( tex ).texture, source.backend.get( tex ).texture );

} );

test( 'shareGPUTextureEntry invalidates pre-existing bind groups on the target', () => {

	const source = fakeRenderer();
	const target = fakeRenderer();
	const tex = fakeTexture();

	source.backend.get( tex ).texture = { __gpu: 'shared' };

	// Pre-populate target with a bind group that references this texture.
	const sampledBinding = {
		isSampledTexture: true,
		texture: tex,
		version: tex.version,
		generation: 7,
		reset() {

			this.version = - 1;
			this.generation = null;

		},
	};
	const unrelatedBinding = {
		isSampledTexture: true,
		texture: fakeTexture( 'unrelated' ),
		version: 4,
		generation: 4,
	};
	const bindGroup = { id: 'bg-1', bindings: [ sampledBinding, unrelatedBinding ] };
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
	assert.equal( sampledBinding.version, - 1, 'the next binding update must observe the replaced resource' );
	assert.equal( sampledBinding.generation, null );
	assert.equal( unrelatedBinding.version, 4, 'unrelated texture bindings remain cache-hot' );
	assert.equal( unrelatedBinding.generation, 4 );

} );

test( 'shareGPUTextureEntry clears stale target texture views', () => {

	const source = fakeRenderer();
	const target = fakeRenderer();
	const tex = fakeTexture();

	source.backend.get( tex ).texture = { __gpu: 'shared' };
	const targetData = target.backend.get( tex );
	targetData.texture = { __gpu: 'old' };
	targetData[ 'view-0' ] = { stale: true };

	const ok = shareGPUTextureEntry( target, source, tex );

	assert.equal( ok, true );
	assert.equal( targetData.texture, source.backend.get( tex ).texture );
	assert.equal( targetData[ 'view-0' ], undefined );

} );

test( 'sharePMREMGPUTexture bumps PMREM-specific diagnostics keys', () => {

	const slim = fakeRenderer();
	const full = fakeRenderer();
	const pmrem = fakeTexture( 'PMREM.cubeUv' );
	const fullData = full.backend.get( pmrem );
	fullData.texture = { __gpu: 'pmrem' };
	const staleBindGroup = { id: 'pmrem-placeholder-bind-group' };
	const slimData = slim.backend.get( pmrem );
	slimData.texture = { __gpu: '1x1-placeholder' };
	slimData[ 'view-0' ] = { __gpuView: 'stale' };
	slim._textures.get( pmrem ).bindGroups = new Set( [ staleBindGroup ] );
	slim.backend.get( staleBindGroup ).groups = { __gpuBindGroup: 'stale' };
	slim.backend.get( staleBindGroup ).versions = [ 0 ];

	const diagnostics = {};
	const ok = sharePMREMGPUTexture( slim, full, pmrem, { diagnostics } );

	assert.equal( ok, true );
	assert.equal( diagnostics.shareCalls, 1 );
	assert.equal( diagnostics.shareSuccess, 1 );
	assert.equal( slimData.texture, fullData.texture );
	assert.equal( slimData[ 'view-0' ], undefined );
	assert.equal( slim._textures.get( pmrem ).bindGroups.size, 0 );
	assert.equal( slim.backend.get( staleBindGroup ).groups, undefined );
	assert.equal( slim.backend.get( staleBindGroup ).versions, undefined );
	assert.equal( pmrem.version, 1 );
	assert.equal( fullData.version, 1 );
	assert.equal( slimData.version, 1 );

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

test( 'sharePMREMGPUTexture fails closed when a replaced PMREM resource cannot be invalidated', () => {

	const full = fakeRenderer();
	const slimBackend = fakeDataMap();
	const slim = { backend: slimBackend };
	const pmrem = fakeTexture( 'PMREM.cubeUv' );
	const fullTexture = { __gpu: 'generated-pmrem' };
	const oldTexture = { __gpu: '1x1-placeholder' };
	full.backend.get( pmrem ).texture = fullTexture;
	const slimData = slim.backend.get( pmrem );
	slimData.texture = oldTexture;
	slimData[ 'view-0' ] = { __gpuView: 'must-not-survive-a-replacement' };

	const diagnostics = {};
	const ok = sharePMREMGPUTexture( slim, full, pmrem, { diagnostics } );

	assert.equal( ok, false );
	assert.equal( diagnostics.shareCalls, 1 );
	assert.equal( diagnostics.shareInvalidationFailed, 1 );
	assert.equal( diagnostics.shareSuccess, undefined );
	assert.equal( slimData.texture, oldTexture, 'failed invalidation must not replace the resource' );
	assert.ok( slimData[ 'view-0' ], 'failed invalidation must leave the old cache untouched' );
	assert.equal( pmrem.version, 0 );

} );

test( 'sharePMREMGPUTexture permits a first resource without invalidation cache APIs', () => {

	const full = fakeRenderer();
	const slim = { backend: fakeDataMap() };
	const pmrem = fakeTexture( 'PMREM.cubeUv' );
	const fullTexture = { __gpu: 'generated-pmrem' };
	full.backend.get( pmrem ).texture = fullTexture;

	assert.equal( sharePMREMGPUTexture( slim, full, pmrem ), true );
	assert.equal( slim.backend.get( pmrem ).texture, fullTexture );
	assert.equal( pmrem.version, 1 );

} );

test( 'shareShadowGPUTextureIntoSlim bumps the JS texture version and clears view cache', () => {

	const slim = fakeRenderer();
	const full = fakeRenderer();
	const depthMap = fakeTexture( 'shadow.depth' );
	depthMap.version = 5;
	depthMap.isDepthTexture = true;
	depthMap.image = { width: 1024, height: 1024, depth: 4 };

	const fullData = full.backend.get( depthMap );
	fullData.texture = { __gpu: 'depth', depthOrArrayLayers: 4 };
	fullData.format = 'depth32float';
	fullData.textureDescriptorGPU = { format: 'depth32float', size: { width: 1024, height: 1024, depthOrArrayLayers: 4 } };

	const slimData = slim.backend.get( depthMap );
	slimData[ 'view-0' ] = { stale: true };

	const ok = shareShadowGPUTextureIntoSlim( depthMap, full, slim );

	assert.equal( ok, true );
	assert.equal( depthMap.version, 6, 'JS version was bumped' );
	assert.equal( depthMap.isArrayTexture, true, 'layered depth texture was marked array-shaped' );
	assert.equal( slimData.texture, fullData.texture );
	assert.equal( slimData.format, 'depth32float' );
	assert.equal( slimData.textureDescriptorGPU, fullData.textureDescriptorGPU );
	assert.equal( slimData.__tslpSharedShadowGPUTexture, fullData.texture );
	assert.equal( slimData[ 'view-0' ], undefined, 'stale view cache cleared' );
	assert.equal( slimData.version, 6 );
	assert.equal( fullData.version, 6, 'both renderers see the bumped version' );
	assert.equal( slim._textures.get( depthMap ).initialized, true );
	assert.equal( full._textures.get( depthMap ).initialized, true );

} );

test( 'shareShadowGPUTextureIntoSlim invalidates pre-existing slim bind groups', () => {

	const slim = fakeRenderer();
	const full = fakeRenderer();
	const depthMap = fakeTexture( 'shadow.depth' );
	depthMap.isDepthTexture = true;
	depthMap.image = { width: 512, height: 512, depth: 4 };

	full.backend.get( depthMap ).texture = { __gpu: 'depth', depthOrArrayLayers: 4 };
	const bindGroup = { id: 'shadow-bg' };
	const txData = slim._textures.get( depthMap );
	txData.bindGroups = new Set( [ bindGroup ] );
	const bindingsData = slim.backend.get( bindGroup );
	bindingsData.groups = { cached: true };
	bindingsData.versions = [ 1, 2, 3 ];

	const ok = shareShadowGPUTextureIntoSlim( depthMap, full, slim );

	assert.equal( ok, true );
	assert.equal( bindingsData.groups, undefined );
	assert.equal( bindingsData.versions, undefined );
	assert.equal( txData.bindGroups.size, 0 );

} );

test( 'shareShadowGPUTextureIntoSlim refreshes stale bindings when the GPU texture is already shared', () => {

	const slim = fakeRenderer();
	const full = fakeRenderer();
	const depthMap = fakeTexture( 'shadow.depth.already-shared' );
	depthMap.version = 7;
	depthMap.isDepthTexture = true;
	depthMap.image = { width: 512, height: 512, depth: 1 };

	const sharedGPUTexture = { __gpu: 'shared-depth' };
	const fullData = full.backend.get( depthMap );
	const slimData = slim.backend.get( depthMap );
	fullData.texture = sharedGPUTexture;
	slimData.texture = sharedGPUTexture;
	slimData[ 'view-0' ] = { stale: true };

	const sampledBinding = {
		isSampledTexture: true,
		texture: depthMap,
		version: 7,
		generation: 7,
		reset() {

			this.version = - 1;
			this.generation = null;

		},
	};
	const unrelatedBinding = {
		isSampledTexture: true,
		texture: fakeTexture( 'unrelated' ),
		version: 3,
		generation: 3,
	};
	const bindGroup = { id: 'already-shared-shadow-bg', bindings: [ sampledBinding, unrelatedBinding ] };
	const textureData = slim._textures.get( depthMap );
	textureData.bindGroups = new Set( [ bindGroup ] );
	const bindingsData = slim.backend.get( bindGroup );
	bindingsData.groups = { cached: true };
	bindingsData.versions = [ 7 ];

	assert.equal( shareShadowGPUTextureIntoSlim( depthMap, full, slim ), true );
	assert.equal( slimData.texture, sharedGPUTexture, 'GPU texture identity is preserved' );
	assert.equal( depthMap.version, 8, 'shadow refresh still advances the JS version' );
	assert.equal( slimData[ 'view-0' ], undefined, 'stale comparison view is cleared' );
	assert.equal( sampledBinding.version, - 1, 'matching sampled binding is reset' );
	assert.equal( sampledBinding.generation, null );
	assert.equal( unrelatedBinding.version, 3, 'unrelated sampled bindings are untouched' );
	assert.equal( bindingsData.groups, undefined );
	assert.equal( bindingsData.versions, undefined );
	assert.equal( textureData.bindGroups.size, 0 );
	assert.equal( fullData.version, 8 );
	assert.equal( slimData.version, 8 );
	assert.equal( slimData.__tslpSharedShadowGPUTexture, sharedGPUTexture );

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

test( 'shareGPUTextureEntry never copies per-backend sampler bookkeeping', () => {

	// `sampler`/`samplerKey` are keyed into the SOURCE backend's private
	// _samplerCache; copying them poisons the target, whose next
	// updateSampler transition crashes on `oldSamplerData.usedTimes--`
	// (the tier1 bloom `usedTimes` TypeError).
	const source = fakeRenderer();
	const target = fakeRenderer();
	const tex = fakeTexture( 'bloom-pass' );

	const sourceData = source.backend.get( tex );
	sourceData.texture = { __gpu: true };
	sourceData.format = 'rgba16float';
	sourceData.sampler = { __gpuSampler: 'source-owned' };
	sourceData.samplerKey = '1006-1006-1001-1001-0-1-0';

	const targetData = target.backend.get( tex );
	targetData.sampler = { __gpuSampler: 'target-owned' };
	targetData.samplerKey = 'target-key';

	const ok = shareGPUTextureEntry( target, source, tex );
	assert.equal( ok, true );
	assert.equal( targetData.texture, sourceData.texture, 'GPU texture is shared' );
	assert.equal( targetData.format, 'rgba16float' );
	assert.equal( targetData.sampler.__gpuSampler, 'target-owned', 'target keeps its own sampler' );
	assert.equal( targetData.samplerKey, 'target-key', 'target keeps its own samplerKey' );

} );

test( 'sharePMREMGPUTexture never copies per-backend sampler bookkeeping', () => {

	const full = fakeRenderer();
	const slim = fakeRenderer();
	const pmrem = fakeTexture( 'pmrem' );

	const fullData = full.backend.get( pmrem );
	fullData.texture = { __gpu: true };
	fullData.sampler = { __gpuSampler: 'full-owned' };
	fullData.samplerKey = 'full-key';

	const ok = sharePMREMGPUTexture( slim, full, pmrem );
	assert.equal( ok, true );
	const slimData = slim.backend.get( pmrem );
	assert.equal( slimData.texture, fullData.texture );
	assert.equal( slimData.sampler, undefined, 'slim must create its own sampler' );
	assert.equal( slimData.samplerKey, undefined );

} );
