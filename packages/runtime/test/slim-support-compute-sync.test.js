import test from 'node:test';
import assert from 'node:assert/strict';

import {
	getComputeBindGroups,
	computeNodeUsesStorageTexture,
	computeSyncNeedsPresentation,
	shareComputeSampledInputs,
	syncComputeStorageOutputs,
	syncComputeStorageOutputsPerPass,
	wireArtifactStorageBuffersFromAttributes,
	pingPongInvalidate,
	shareInstancedAttributeBufferIntoSlim,
} from '../src/slim-support/compute-sync.js';

function fakeDataMap() {

	const store = new WeakMap();
	return { store, get( key ) { let e = store.get( key ); if ( ! e ) { e = {}; store.set( key, e ); } return e; } };

}

function fakeRenderer( { bindGroupsForNode = null } = {} ) {

	const backend = fakeDataMap();
	const _textures = fakeDataMap();
	const _attributes = fakeDataMap();
	const submittedCommandBuffers = [];
	const copyCalls = [];
	const generateMipmapsCalls = [];

	backend.device = {
		queue: { submit( buffers ) { submittedCommandBuffers.push( buffers ); } },
		createCommandEncoder() {

			return {
				copyBufferToBuffer( srcBuf, srcOffset, dstBuf, dstOffset, size ) {

					copyCalls.push( { srcBuf, srcOffset, dstBuf, dstOffset, size } );

				},
				finish() { return { __isCommandBuffer: true }; },
			};

		},
	};
	backend.generateMipmaps = function ( texture ) { generateMipmapsCalls.push( texture ); };

	const _bindings = {
		getForCompute( node ) { return bindGroupsForNode ? bindGroupsForNode( node ) : []; },
	};

	return { backend, _textures, _attributes, _bindings, submittedCommandBuffers, copyCalls, generateMipmapsCalls };

}

function storageTextureBinding( name = 'tex' ) {

	return {
		isSampledTexture: true,
		texture: { isTexture: true, isStorageTexture: true, name, version: 0, generateMipmaps: true },
	};

}

function storageBufferBinding( attribute ) {

	return { isStorageBuffer: true, attribute };

}

test( 'getComputeBindGroups returns [] when fullRenderer has no _bindings.getForCompute', () => {

	assert.deepEqual( getComputeBindGroups( {}, {} ), [] );
	assert.deepEqual( getComputeBindGroups( {}, { _bindings: {} } ), [] );

} );

test( 'getComputeBindGroups flattens a list of compute nodes', () => {

	const groupA = { bindings: [ storageTextureBinding( 'A' ) ] };
	const groupB = { bindings: [ storageTextureBinding( 'B' ) ] };
	const renderer = fakeRenderer( {
		bindGroupsForNode( node ) { return node === 'na' ? [ groupA ] : [ groupB ]; },
	} );
	const groups = getComputeBindGroups( [ 'na', 'nb' ], renderer );
	assert.deepEqual( groups, [ groupA, groupB ] );

} );

test( 'computeNodeUsesStorageTexture detects storage texture bindings', () => {

	const yes = fakeRenderer( { bindGroupsForNode: () => [ { bindings: [ storageTextureBinding() ] } ] } );
	const no = fakeRenderer( { bindGroupsForNode: () => [ { bindings: [ storageBufferBinding( { isAttr: true } ) ] } ] } );
	assert.equal( computeNodeUsesStorageTexture( 'n', yes ), true );
	assert.equal( computeNodeUsesStorageTexture( 'n', no ), false );

} );

test( 'computeSyncNeedsPresentation recognizes shared in-place output mutations', () => {

	assert.equal( computeSyncNeedsPresentation( null ), false );
	assert.equal( computeSyncNeedsPresentation( { texturesShared: 0, storageAttrs: 0, buffersAdopted: 0, buffersCopied: 0 } ), false );
	assert.equal( computeSyncNeedsPresentation( { storageAttrs: 1, buffersAdopted: 0, buffersCopied: 0 } ), true );
	assert.equal( computeSyncNeedsPresentation( { storageTextures: 1, texturesShared: 0 } ), true );

} );

test( 'shareComputeSampledInputs shares sampled render textures from slim into full', () => {

	const tex = { isTexture: true, name: 'collision-map', version: 2 };
	const binding = { isSampledTexture: true, texture: tex };
	const bindGroup = { bindings: [ binding ] };

	const slim = fakeRenderer();
	slim.backend.get( tex ).texture = { __gpu: 'slim-render-target' };
	slim.backend.get( tex ).format = 'rgba16float';

	const full = fakeRenderer( { bindGroupsForNode: () => [ bindGroup ] } );
	full.backend.get( tex ).texture = { __gpu: 'full-placeholder' };

	const seen = [];
	const stats = shareComputeSampledInputs( 'compute-node', full, slim, {
		onSampledTexture: ( texture, seenBinding ) => seen.push( [ texture, seenBinding ] ),
	} );

	assert.equal( stats.texturesShared, 1 );
	assert.equal( stats.skippedStorageTextures, 0 );
	assert.equal( stats.missingTextures, 0 );
	assert.equal( full.backend.get( tex ).texture, slim.backend.get( tex ).texture );
	assert.equal( full.backend.get( tex ).format, 'rgba16float' );
	assert.equal( tex.version, 3, 'texture version bumps so full compute bind groups rebuild' );
	assert.deepEqual( seen, [ [ tex, binding ] ] );

} );

test( 'shareComputeSampledInputs skips storage-texture output bindings', () => {

	const storageTex = { isTexture: true, isStorageTexture: true, name: 'compute-out', version: 0 };
	const normalTex = { isTexture: true, name: 'collision-map', version: 0 };
	const bindGroup = {
		bindings: [
			{ isSampledTexture: true, store: true, texture: storageTex },
			{ isSampledTexture: true, texture: normalTex },
		],
	};

	const slim = fakeRenderer();
	slim.backend.get( normalTex ).texture = { __gpu: 'slim-input' };
	slim.backend.get( storageTex ).texture = { __gpu: 'slim-storage' };

	const full = fakeRenderer( { bindGroupsForNode: () => [ bindGroup ] } );
	full.backend.get( storageTex ).texture = { __gpu: 'full-storage' };

	const stats = shareComputeSampledInputs( 'compute-node', full, slim );

	assert.equal( stats.texturesShared, 1 );
	assert.equal( stats.skippedStorageTextures, 1 );
	assert.equal( full.backend.get( normalTex ).texture, slim.backend.get( normalTex ).texture );
	assert.notEqual( full.backend.get( storageTex ).texture, slim.backend.get( storageTex ).texture );

} );

test( 'shareComputeSampledInputs filters exact inputs, reports duplicate locations, and leaves decoys untouched', () => {

	const sampledTexture = { isTexture: true, name: 'shared-sampled', version: 2 };
	const fullOwnedTexture = { isTexture: true, name: 'compute-only', version: 0 };
	const storageTexture = { isTexture: true, isStorageTexture: true, name: 'storage-input', version: 4 };
	const decoyStorageTexture = { isTexture: true, isStorageTexture: true, name: 'storage-decoy', version: 1 };
	const storageAttribute = { isStorageBufferAttribute: true, version: 3 };
	const decoyAttribute = { isStorageBufferAttribute: true, version: 1 };
	const group = { bindings: [
		{ isSampledTexture: true, texture: sampledTexture },
		{ isSampledTexture: true, texture: sampledTexture },
		{ isSampledTexture: true, texture: fullOwnedTexture },
		{ isSampledTexture: true, store: true, texture: storageTexture },
		storageBufferBinding( storageAttribute ),
		{ isSampledTexture: true, store: true, texture: decoyStorageTexture },
		storageBufferBinding( decoyAttribute ),
	] };
	const slim = fakeRenderer();
	const slimSampledGPU = { id: 'slim-sampled' };
	const slimStorageGPU = { id: 'slim-storage' };
	const slimStorageBuffer = { id: 'slim-buffer', size: 64 };
	slim.backend.get( sampledTexture ).texture = slimSampledGPU;
	slim.backend.get( storageTexture ).texture = slimStorageGPU;
	slim.backend.get( storageAttribute ).buffer = slimStorageBuffer;
	slim._attributes.get( storageAttribute ).version = 17;
	const slimDecoyTexture = { id: 'slim-decoy-texture' };
	const slimDecoyBuffer = { id: 'slim-decoy-buffer', size: 64 };
	slim.backend.get( decoyStorageTexture ).texture = slimDecoyTexture;
	slim.backend.get( decoyAttribute ).buffer = slimDecoyBuffer;

	let initializedBindingReads = 0;
	const full = fakeRenderer( { bindGroupsForNode: () => { initializedBindingReads ++; return [ group ]; } } );
	full._nodes = { getForCompute: () => ( { bindings: [ group ] } ) };
	full.backend.get( sampledTexture ).texture = { id: 'full-sampled-placeholder' };
	full.backend.get( fullOwnedTexture ).texture = { id: 'full-compute-owned' };
	full.backend.get( storageTexture ).texture = { id: 'full-storage-placeholder' };
	const fullStorageEntry = full.backend.get( storageAttribute );
	fullStorageEntry.buffer = { id: 'full-buffer-placeholder', size: 64 };
	fullStorageEntry.rendererLocal = { keep: true };
	const fullDecoyTexture = { id: 'full-decoy-texture' };
	const fullDecoyBuffer = { id: 'full-decoy-buffer', size: 64 };
	full.backend.get( decoyStorageTexture ).texture = fullDecoyTexture;
	full.backend.get( decoyAttribute ).buffer = fullDecoyBuffer;
	const accepted = new Set( [
		'sampled-texture:0:0',
		'sampled-texture:0:1',
		'sampled-texture:0:2',
		'storage-texture:0:3',
		'storage-buffer:0:4',
	] );
	const synced = [];
	const notSlimOwned = [];
	const sampledLocations = [];
	const storageTextureLocations = [];
	const storageAttributeLocations = [];
	const locationKey = ( location, detail ) => `${ detail.kind }:${ location.group }:${ location.binding }`;

	const stats = shareComputeSampledInputs( {}, full, slim, {
		initializeBindings: false,
		bindingFilter: ( binding, location, detail ) => accepted.has( locationKey( location, detail ) ),
		onInputSynced: ( resource, binding, location, detail ) => synced.push( locationKey( location, detail ) ),
		onInputNotSlimOwned: ( resource, binding, location, detail ) => notSlimOwned.push( [ locationKey( location, detail ), detail.alreadyAvailable ] ),
		onSampledTexture: ( resource, binding, location ) => sampledLocations.push( location.binding ),
		onStorageTexture: ( resource, binding, location ) => storageTextureLocations.push( location.binding ),
		onStorageAttr: ( resource, binding, location ) => storageAttributeLocations.push( location.binding ),
	} );

	assert.deepEqual( stats, { texturesShared: 2, skippedStorageTextures: 1, missingTextures: 0 }, 'the public stats shape stays legacy-compatible' );
	assert.equal( initializedBindingReads, 0, 'uninitialized state inspection never asks _bindings to allocate resources' );
	assert.equal( full.backend.get( sampledTexture ).texture, slimSampledGPU );
	assert.equal( sampledTexture.version, 3, 'duplicate texture identity transfers only once' );
	assert.equal( full.backend.get( storageTexture ).texture, slimStorageGPU );
	assert.equal( full.backend.get( storageAttribute ).buffer, slimStorageBuffer );
	assert.deepEqual( fullStorageEntry.rendererLocal, { keep: true }, 'storage input sharing preserves full-renderer-local backend fields' );
	assert.equal( full._attributes.get( storageAttribute ).version, 17, 'the full attribute manager inherits the initialized slim version' );
	assert.equal( full.backend.get( decoyStorageTexture ).texture, fullDecoyTexture );
	assert.equal( full.backend.get( decoyAttribute ).buffer, fullDecoyBuffer );
	assert.deepEqual( sampledLocations, [ 0, 1 ], 'one transferred texture can satisfy multiple exact locations' );
	assert.deepEqual( storageTextureLocations, [ 3 ] );
	assert.deepEqual( storageAttributeLocations, [ 4 ] );
	assert.deepEqual( synced, [
		'sampled-texture:0:0',
		'sampled-texture:0:1',
		'storage-texture:0:3',
		'storage-buffer:0:4',
	] );
	assert.deepEqual( notSlimOwned, [ [ 'sampled-texture:0:2', true ] ], 'full-owned sampled inputs are explicitly optional, not failed shares' );

} );

test( 'shareComputeSampledInputs invalidates initialized compute bindings when a selected storage input buffer is replaced', () => {

	const attribute = { isStorageBufferAttribute: true, version: 1 };
	const group = { bindings: [ storageBufferBinding( attribute ) ] };
	const computeNode = {};
	const firstBuffer = { id: 'first-input', size: 64 };
	const replacementBuffer = { id: 'replacement-input', size: 64 };
	const slim = fakeRenderer();
	slim.backend.get( attribute ).buffer = firstBuffer;
	const full = fakeRenderer();
	full.backend.get( attribute ).buffer = firstBuffer;
	full._nodes = { getForCompute: () => ( { bindings: [ group ] } ) };
	const bindingEntries = fakeDataMap();
	bindingEntries.get( group ).bindGroup = group;
	let nativeBoundBuffer = firstBuffer;
	let invalidations = 0;
	full._bindings = {
		get: bindingEntries.get,
		getForCompute() {

			const entry = bindingEntries.get( group );
			if ( entry.bindGroup === undefined ) {

				entry.bindGroup = group;
				nativeBoundBuffer = full.backend.get( attribute ).buffer;

			}
			return [ group ];

		},
		deleteForCompute( node ) {

			assert.equal( node, computeNode );
			invalidations ++;
			bindingEntries.get( group ).bindGroup = undefined;

		},
	};
	const synced = [];
	const options = {
		initializeBindings: false,
		bindingFilter: ( binding, location, detail ) => detail.kind === 'storage-buffer' && location.group === 0 && location.binding === 0,
		onInputSynced: ( resource, binding, location ) => synced.push( location.binding ),
	};

	shareComputeSampledInputs( computeNode, full, slim, options );
	assert.equal( invalidations, 0, 'an already-shared handle preserves the existing native bind group' );
	assert.equal( nativeBoundBuffer, firstBuffer );

	slim.backend.get( attribute ).buffer = replacementBuffer;
	shareComputeSampledInputs( computeNode, full, slim, options );
	assert.equal( full.backend.get( attribute ).buffer, replacementBuffer );
	assert.equal( invalidations, 1, 'a real handle replacement invalidates the initialized compute bindings once' );
	assert.equal( nativeBoundBuffer, firstBuffer, 'the modelled native binding remains stale until Three rebuilds it' );
	full._bindings.getForCompute( computeNode );
	assert.equal( nativeBoundBuffer, replacementBuffer, 'the next native binding build observes the replacement input' );
	assert.deepEqual( synced, [ 0, 0 ] );

} );

test( 'shareComputeSampledInputs rolls back a storage input replacement when initialized bindings cannot be invalidated', () => {

	const attribute = { isStorageBufferAttribute: true, version: 7 };
	const group = { bindings: [ storageBufferBinding( attribute ) ] };
	const previousBuffer = { id: 'full-existing', size: 64 };
	const replacementBuffer = { id: 'slim-replacement', size: 64 };
	const slim = fakeRenderer();
	slim.backend.get( attribute ).buffer = replacementBuffer;
	slim._attributes.get( attribute ).version = 12;
	const full = fakeRenderer();
	full.backend.get( attribute ).buffer = previousBuffer;
	full._attributes.get( attribute ).version = 4;
	full._nodes = { getForCompute: () => ( { bindings: [ group ] } ) };
	const bindingEntries = fakeDataMap();
	bindingEntries.get( group ).bindGroup = group;
	full._bindings = {
		get: bindingEntries.get,
		getForCompute: () => [ group ],
		deleteForCompute() { throw new Error( 'cannot invalidate' ); },
	};
	const synced = [];
	const errors = [];

	shareComputeSampledInputs( {}, full, slim, {
		initializeBindings: false,
		bindingFilter: () => true,
		onInputSynced: ( resource ) => synced.push( resource ),
		onError: ( error ) => errors.push( error ),
	} );

	assert.equal( full.backend.get( attribute ).buffer, previousBuffer, 'failed invalidation restores the backend buffer' );
	assert.equal( full._attributes.get( attribute ).version, 4, 'failed invalidation restores the attribute-manager version' );
	assert.deepEqual( synced, [], 'a rolled-back input is never reported as synchronized' );
	assert.equal( errors.length, 1 );
	assert.match( errors[ 0 ].message, /could not invalidate initialized full-renderer compute bindings/ );

} );

test( 'shareComputeSampledInputs fails closed without uninitialized binding state', () => {

	const texture = { isTexture: true, name: 'must-not-initialize', version: 0 };
	const group = { bindings: [ { isSampledTexture: true, texture } ] };
	const slim = fakeRenderer();
	slim.backend.get( texture ).texture = { id: 'slim-input' };
	let initializedBindingReads = 0;
	const full = fakeRenderer( { bindGroupsForNode: () => { initializedBindingReads ++; return [ group ]; } } );
	full._nodes = { getForCompute: () => { throw new Error( 'state unavailable' ); } };
	const synced = [];

	const stats = shareComputeSampledInputs( {}, full, slim, {
		initializeBindings: false,
		bindingFilter: () => true,
		onInputSynced: ( resource, binding, location ) => synced.push( location ),
	} );

	assert.deepEqual( stats, { texturesShared: 0, skippedStorageTextures: 0, missingTextures: 0 } );
	assert.equal( initializedBindingReads, 0, 'exact auditing must not fall back to allocating _bindings state' );
	assert.deepEqual( synced, [] );

} );

test( 'shareComputeSampledInputs reports a selected storage texture missing from slim', () => {

	const texture = { isTexture: true, isStorageTexture: true, name: 'missing-storage-input', version: 0 };
	const group = { bindings: [ { isSampledTexture: true, store: true, texture } ] };
	const slim = fakeRenderer();
	const full = fakeRenderer();
	full._nodes = { getForCompute: () => ( { bindings: [ group ] } ) };
	full.backend.get( texture ).texture = { id: 'full-storage' };
	const synced = [];

	const stats = shareComputeSampledInputs( {}, full, slim, {
		initializeBindings: false,
		bindingFilter: () => true,
		onInputSynced: ( resource, binding, location ) => synced.push( location ),
	} );

	assert.deepEqual( stats, { texturesShared: 0, skippedStorageTextures: 0, missingTextures: 1 } );
	assert.deepEqual( synced, [] );
	assert.equal( full.backend.get( texture ).texture.id, 'full-storage', 'a mandatory storage input is never reverse-adopted from full' );

} );

test( 'syncComputeStorageOutputs shares storage textures and bumps version', () => {

	const tex = { isTexture: true, isStorageTexture: true, name: 'compute-out', version: 7, generateMipmaps: true };
	const binding = { isSampledTexture: true, texture: tex };
	const bindGroup = { bindings: [ binding ] };

	const full = fakeRenderer( { bindGroupsForNode: () => [ bindGroup ] } );
	full.backend.get( tex ).texture = { __gpu: 'compute-out' };
	full.backend.get( tex ).format = 'rgba16float';

	const slim = fakeRenderer( { bindGroupsForNode: () => [ bindGroup ] } );
	const seenTextures = [];
	const syncedTextures = [];

	const stats = syncComputeStorageOutputs( 'compute-node', full, slim, {
		onStorageTexture: ( texture, seenBinding ) => seenTextures.push( [ texture, seenBinding ] ),
		onStorageTextureSynced: ( texture, seenBinding, location ) => syncedTextures.push( [ texture, seenBinding, location ] ),
	} );

	assert.equal( stats.texturesShared, 1 );
	assert.equal( stats.storageAttrs, 0 );
	assert.equal( stats.buffersAdopted, 0 );
	assert.equal( stats.buffersCopied, 0 );
	assert.equal( tex.version, 8, 'JS version bumped by underlying shadow-share' );
	assert.equal( slim.backend.get( tex ).texture, full.backend.get( tex ).texture );
	assert.deepEqual( slim.generateMipmapsCalls, [ tex ], 'mipmaps regenerated for storage texture' );
	assert.deepEqual( seenTextures, [ [ tex, binding ] ] );
	assert.deepEqual( syncedTextures, [ [ tex, binding, { group: 0, binding: 0 } ] ] );

} );

test( 'syncComputeStorageOutputs respects storage texture mipmap opt-out', () => {

	const tex = { isTexture: true, isStorageTexture: true, name: 'pingpong-out', version: 0, generateMipmaps: true, mipmapsAutoUpdate: false };
	const binding = { isSampledTexture: true, texture: tex };
	const bindGroup = { bindings: [ binding ] };

	const full = fakeRenderer( { bindGroupsForNode: () => [ bindGroup ] } );
	full.backend.get( tex ).texture = { __gpu: 'pingpong-out' };

	const slim = fakeRenderer( { bindGroupsForNode: () => [ bindGroup ] } );
	const stats = syncComputeStorageOutputs( 'compute-node', full, slim );

	assert.equal( stats.texturesShared, 1 );
	assert.deepEqual( slim.generateMipmapsCalls, [] );

} );

test( 'syncComputeStorageOutputs adopts the full buffer when slim has none', () => {

	const attr = { isBufferAttribute: true };
	const bindGroup = { bindings: [ storageBufferBinding( attr ) ] };
	const full = fakeRenderer( { bindGroupsForNode: () => [ bindGroup ] } );
	const fullBuf = { size: 1024 };
	full.backend.get( attr ).buffer = fullBuf;

	const slim = fakeRenderer( { bindGroupsForNode: () => [ bindGroup ] } );
	// slim attribute entry exists but with undefined version
	const slimAttrEntry = slim._attributes.get( attr );

	const remembered = [];
	const synced = [];
	const stats = syncComputeStorageOutputs( 'n', full, slim, {
		onStorageAttr: ( a ) => remembered.push( a ),
		onStorageAttrSynced: ( a, binding, location ) => synced.push( [ a, binding, location ] ),
	} );

	assert.equal( stats.buffersAdopted, 1 );
	assert.equal( stats.storageAttrs, 1 );
	assert.equal( stats.buffersCopied, 0 );
	assert.equal( slim.backend.get( attr ).buffer, fullBuf );
	assert.equal( slimAttrEntry.version, 1 );
	assert.deepEqual( remembered, [ attr ] );
	assert.deepEqual( synced, [ [ attr, bindGroup.bindings[ 0 ], { group: 0, binding: 0 } ] ] );
	assert.equal( slim.submittedCommandBuffers.length, 0, 'adopt path enqueues no copy' );

} );

test( 'already-shared compute buffers still require a presentation draw', () => {

	const attr = { isBufferAttribute: true };
	const bindGroup = { bindings: [ storageBufferBinding( attr ) ] };
	const full = fakeRenderer( { bindGroupsForNode: () => [ bindGroup ] } );
	full.backend.get( attr ).buffer = { size: 1024 };
	const slim = fakeRenderer( { bindGroupsForNode: () => [ bindGroup ] } );

	const first = syncComputeStorageOutputs( 'n', full, slim );
	const second = syncComputeStorageOutputs( 'n', full, slim );

	assert.equal( first.buffersAdopted, 1 );
	assert.equal( second.buffersAdopted, 0 );
	assert.equal( second.buffersCopied, 0 );
	assert.equal( second.storageAttrs, 1, 'the shared GPUBuffer was still mutated by the later dispatch' );
	assert.equal( computeSyncNeedsPresentation( second ), true );

} );

test( 'syncComputeStorageOutputs copies buffer-to-buffer when slim already has its own buffer', () => {

	const attr = { isBufferAttribute: true };
	const bindGroup = { bindings: [ storageBufferBinding( attr ) ] };
	const full = fakeRenderer( { bindGroupsForNode: () => [ bindGroup ] } );
	const fullBuf = { size: 2048 };
	full.backend.get( attr ).buffer = fullBuf;

	const slim = fakeRenderer( { bindGroupsForNode: () => [ bindGroup ] } );
	const slimBuf = { size: 1024 }; // smaller — copy clamps to slim size
	slim.backend.get( attr ).buffer = slimBuf;

	const stats = syncComputeStorageOutputs( 'n', full, slim );

	assert.equal( stats.buffersCopied, 1 );
	assert.equal( stats.storageAttrs, 1 );
	assert.equal( stats.buffersAdopted, 0 );
	assert.equal( slim.copyCalls.length, 1 );
	const call = slim.copyCalls[ 0 ];
	assert.equal( call.srcBuf, fullBuf );
	assert.equal( call.dstBuf, slimBuf );
	assert.equal( call.size, 1024, 'clamped to min(full.size, slim.size)' );
	assert.equal( slim.submittedCommandBuffers.length, 1, 'single command buffer submitted' );

} );

test( 'syncComputeStorageOutputs filters exact outputs and reports duplicate texture locations without touching decoys', () => {

	const readOnlyAttribute = { isStorageBufferAttribute: true, name: 'read-only' };
	const outputAttribute = { isStorageBufferAttribute: true, name: 'write-output' };
	const decoyAttribute = { isStorageBufferAttribute: true, name: 'decoy' };
	const outputTexture = { isTexture: true, isStorageTexture: true, name: 'shared-output', version: 5, generateMipmaps: true };
	const decoyTexture = { isTexture: true, isStorageTexture: true, name: 'decoy-output', version: 1, generateMipmaps: true };
	const group = { bindings: [
		storageBufferBinding( readOnlyAttribute ),
		storageBufferBinding( outputAttribute ),
		storageBufferBinding( decoyAttribute ),
		{ isSampledTexture: true, texture: outputTexture },
		{ isSampledTexture: true, texture: outputTexture },
		{ isSampledTexture: true, texture: decoyTexture },
	] };
	const full = fakeRenderer( { bindGroupsForNode: () => [ group ] } );
	const fullReadOnlyBuffer = { id: 'full-read-only', size: 64 };
	const fullOutputBuffer = { id: 'full-output', size: 64 };
	const fullDecoyBuffer = { id: 'full-decoy', size: 64 };
	const fullOutputTexture = { id: 'full-output-texture' };
	const fullDecoyTexture = { id: 'full-decoy-texture' };
	full.backend.get( readOnlyAttribute ).buffer = fullReadOnlyBuffer;
	full.backend.get( outputAttribute ).buffer = fullOutputBuffer;
	full.backend.get( decoyAttribute ).buffer = fullDecoyBuffer;
	full.backend.get( outputTexture ).texture = fullOutputTexture;
	full.backend.get( decoyTexture ).texture = fullDecoyTexture;
	const slim = fakeRenderer();
	const slimReadOnlyBuffer = { id: 'slim-read-only', size: 64 };
	const slimOutputBuffer = { id: 'slim-output', size: 64 };
	const slimDecoyBuffer = { id: 'slim-decoy', size: 64 };
	const slimDecoyTexture = { id: 'slim-decoy-texture' };
	slim.backend.get( readOnlyAttribute ).buffer = slimReadOnlyBuffer;
	slim.backend.get( outputAttribute ).buffer = slimOutputBuffer;
	slim.backend.get( decoyAttribute ).buffer = slimDecoyBuffer;
	slim.backend.get( decoyTexture ).texture = slimDecoyTexture;
	const accepted = new Set( [
		'storage-buffer:0:1',
		'storage-texture:0:3',
		'storage-texture:0:4',
	] );
	const synced = [];
	const textureLocations = [];
	const locationKey = ( location, detail ) => `${ detail.kind }:${ location.group }:${ location.binding }`;

	const stats = syncComputeStorageOutputs( {}, full, slim, {
		bindingFilter: ( binding, location, detail ) => accepted.has( locationKey( location, detail ) ),
		onOutputSynced: ( resource, binding, location, detail ) => synced.push( locationKey( location, detail ) ),
		onStorageTextureSynced: ( resource, binding, location ) => textureLocations.push( location.binding ),
	} );

	assert.deepEqual( stats, { texturesShared: 1, storageAttrs: 1, buffersAdopted: 0, buffersCopied: 1 } );
	assert.equal( slim.backend.get( readOnlyAttribute ).buffer, slimReadOnlyBuffer, 'read-only input is not reverse-synchronized as an output' );
	assert.equal( slim.backend.get( decoyAttribute ).buffer, slimDecoyBuffer );
	assert.equal( slim.backend.get( decoyTexture ).texture, slimDecoyTexture );
	assert.equal( slim.backend.get( outputTexture ).texture, fullOutputTexture );
	assert.equal( outputTexture.version, 6, 'duplicate output identity is transferred and versioned once' );
	assert.deepEqual( textureLocations, [ 3, 4 ], 'the same texture can prove both contracted output locations' );
	assert.deepEqual( slim.generateMipmapsCalls, [ outputTexture ], 'duplicate output locations regenerate mipmaps once' );
	assert.deepEqual( synced, [
		'storage-buffer:0:1',
		'storage-texture:0:3',
		'storage-texture:0:4',
	] );
	assert.equal( slim.copyCalls.length, 1 );
	assert.equal( slim.copyCalls[ 0 ].srcBuf, fullOutputBuffer );
	assert.equal( slim.copyCalls[ 0 ].dstBuf, slimOutputBuffer );

} );

test( 'syncComputeStorageOutputs gracefully handles missing slim device', () => {

	const slim = fakeRenderer();
	slim.backend.device = null;
	const stats = syncComputeStorageOutputs( 'n', fakeRenderer(), slim );
	assert.deepEqual( stats, { texturesShared: 0, storageAttrs: 0, buffersAdopted: 0, buffersCopied: 0 } );

} );

test( 'syncComputeStorageOutputs forwards errors to onError', () => {

	const attr = { isBufferAttribute: true };
	const bindGroup = { bindings: [ storageBufferBinding( attr ) ] };
	const full = fakeRenderer( { bindGroupsForNode: () => [ bindGroup ] } );
	full.backend.get( attr ).buffer = { size: 16 };

	const slim = fakeRenderer();
	slim.backend.get( attr ).buffer = { size: 16 };
	slim.backend.device.createCommandEncoder = () => { throw new Error( 'encoder-blown' ); };

	const errs = [];
	const stats = syncComputeStorageOutputs( 'n', full, slim, { onError: ( err ) => errs.push( err.message ) } );

	assert.deepEqual( stats, { texturesShared: 0, storageAttrs: 0, buffersAdopted: 0, buffersCopied: 0 } );
	assert.deepEqual( errs, [ 'encoder-blown' ] );

} );

test( 'syncComputeStorageOutputsPerPass invokes onPass callback per pass with cumulative stats', () => {

	const attrA = { isBufferAttribute: true, name: 'pass-A' };
	const attrB = { isBufferAttribute: true, name: 'pass-B' };

	// Pass 0 writes attrA. Pass 1 writes attrB. Same compute node string but
	// different bind-group output depending on which "pass" the test setup
	// queries — emulates two dispatches of the same kernel.
	const groupA = { bindings: [ storageBufferBinding( attrA ) ] };
	const groupB = { bindings: [ storageBufferBinding( attrB ) ] };

	const full = fakeRenderer( { bindGroupsForNode: ( node ) => node === 'pass0' ? [ groupA ] : [ groupB ] } );
	full.backend.get( attrA ).buffer = { size: 64 };
	full.backend.get( attrB ).buffer = { size: 64 };

	const slim = fakeRenderer( { bindGroupsForNode: ( node ) => node === 'pass0' ? [ groupA ] : [ groupB ] } );

	const passes = [];
	const out0 = syncComputeStorageOutputsPerPass( 'pass0', full, slim, 0, { onPass: ( idx, st ) => passes.push( [ idx, st.buffersAdopted ] ) } );
	const out1 = syncComputeStorageOutputsPerPass( 'pass1', full, slim, 1, { onPass: ( idx, st ) => passes.push( [ idx, st.buffersAdopted ] ) } );

	assert.equal( out0.pass, 0 );
	assert.equal( out0.buffersAdopted, 1 );
	assert.equal( out1.pass, 1 );
	assert.equal( out1.buffersAdopted, 1 );
	assert.deepEqual( passes, [ [ 0, 1 ], [ 1, 1 ] ] );
	assert.equal( slim.backend.get( attrA ).buffer, full.backend.get( attrA ).buffer );
	assert.equal( slim.backend.get( attrB ).buffer, full.backend.get( attrB ).buffer );

} );

test( 'syncComputeStorageOutputsPerPass with undefined passIndex behaves like the legacy sync', () => {

	const attr = { isBufferAttribute: true };
	const group = { bindings: [ storageBufferBinding( attr ) ] };
	const full = fakeRenderer( { bindGroupsForNode: () => [ group ] } );
	full.backend.get( attr ).buffer = { size: 32 };
	const slim = fakeRenderer( { bindGroupsForNode: () => [ group ] } );

	let onPassFired = false;
	const out = syncComputeStorageOutputsPerPass( 'n', full, slim, undefined, { onPass: () => { onPassFired = true; } } );

	assert.equal( out.pass, null );
	assert.equal( out.buffersAdopted, 1 );
	assert.equal( onPassFired, false, 'onPass is silent when passIndex is undefined' );

} );

test( 'wireArtifactStorageBuffersFromAttributes wires storage plan entries by shape', () => {

	const attr = {
		isStorageBufferAttribute: true,
		array: new Int32Array( 19200 * 4 ),
		count: 19200,
		itemSize: 4,
		version: 3,
	};
	const artifact = {
		uniformPlan: [
			{
				storageBuffers: [
					{
						name: 'lightIndexes',
						count: 19200,
						itemSize: 4,
						arrayType: 'Int32Array',
						_liveAttribute: { array: [] },
					},
				],
			},
		],
	};

	const wired = wireArtifactStorageBuffersFromAttributes( artifact, [ attr ] );

	assert.equal( wired, 1 );
	assert.equal( artifact.uniformPlan[ 0 ].storageBuffers[ 0 ]._liveAttribute, attr );
	assert.equal( attr.version, 4, 'live attribute version bumps for bind-group rebuilds' );

} );

test( 'wireArtifactStorageBuffersFromAttributes handles ordered storage-buffer refs and skips live entries', () => {

	const live = {
		isStorageBufferAttribute: true,
		array: new Float32Array( 4 ),
		count: 1,
		itemSize: 4,
		version: 1,
	};
	const fallback = {
		isStorageBufferAttribute: true,
		array: new Float32Array( 4 ),
		count: 1,
		itemSize: 4,
		version: 1,
	};
	const ref = { count: 1, itemSize: 4, arrayType: 'Float32Array', _liveAttribute: live };
	const artifact = {
		uniformPlan: [
			{
				storageBuffers: [],
				orderedBindings: [ { type: 'storage-buffer', ref } ],
			},
		],
	};

	const wired = wireArtifactStorageBuffersFromAttributes( artifact, [ fallback ] );

	assert.equal( wired, 0 );
	assert.equal( ref._liveAttribute, live );
	assert.equal( fallback.version, 1 );

} );

test( 'wireArtifactStorageBuffersFromAttributes matches authored storage identities before shape', () => {

	const left = {
		isStorageBufferAttribute: true,
		array: new Uint32Array( 8 ),
		count: 8,
		itemSize: 1,
		version: 0,
	};
	const right = {
		isStorageBufferAttribute: true,
		array: new Uint32Array( 8 ),
		count: 8,
		itemSize: 1,
		version: 0,
	};
	const entry = {
		name: 'StorageBuffer_4',
		count: 8,
		itemSize: 1,
		arrayType: 'Uint32Array',
		source: { kind: 'storage.buffer', attributeName: 'Current_Right' },
	};
	const artifact = { uniformPlan: [ { storageBuffers: [ entry ] } ] };

	const wired = wireArtifactStorageBuffersFromAttributes( artifact, [
		{ attribute: left, binding: { nodeUniform: { name: 'Current_Left' } } },
		{ attribute: right, binding: { nodeUniform: { name: 'Current_Right' } } },
	] );

	assert.equal( wired, 1 );
	assert.equal( entry._liveAttribute, right );
	assert.equal( right.version, 1 );
	assert.equal( left.version, 0 );

} );

test( 'wireArtifactStorageBuffersFromAttributes fails closed for ambiguous or missing identities', () => {

	const makeAttribute = () => ( {
		isStorageBufferAttribute: true,
		array: new Uint32Array( 8 ),
		count: 8,
		itemSize: 1,
		version: 0,
	} );
	const first = makeAttribute();
	const second = makeAttribute();
	const signedEntry = {
		name: 'StorageBuffer_4',
		count: 8,
		itemSize: 1,
		arrayType: 'Uint32Array',
		source: { kind: 'storage.buffer', attributeName: 'Current_Right' },
	};
	const signedArtifact = { uniformPlan: [ { storageBuffers: [ signedEntry ] } ] };
	assert.equal( wireArtifactStorageBuffersFromAttributes( signedArtifact, [
		{ attribute: first, attributeName: 'Current_Right' },
		{ attribute: second, attributeName: 'Current_Right' },
	] ), 0, 'duplicate signed candidates are ambiguous' );
	assert.equal( signedEntry._liveAttribute, undefined );

	const missingEntry = { ...signedEntry, source: { kind: 'storage.buffer', attributeName: 'Missing' } };
	assert.equal( wireArtifactStorageBuffersFromAttributes( { uniformPlan: [ { storageBuffers: [ missingEntry ] } ] }, [
		{ attribute: first, attributeName: 'Current_Left' },
	] ), 0, 'a missing signed identity never falls back by shape' );
	assert.equal( missingEntry._liveAttribute, undefined );

	const legacyEntry = { name: 'legacy', count: 8, itemSize: 1, arrayType: 'Uint32Array' };
	assert.equal( wireArtifactStorageBuffersFromAttributes( { uniformPlan: [ { storageBuffers: [ legacyEntry ] } ] }, [ first, second ] ), 0, 'legacy shape matching must also be unique' );
	assert.equal( legacyEntry._liveAttribute, undefined );

} );

test( 'wireArtifactStorageBuffersFromAttributes coalesces JSON-split flat and ordered aliases', () => {

	const attribute = {
		isStorageBufferAttribute: true,
		array: new Uint32Array( 8 ),
		count: 8,
		itemSize: 1,
		version: 4,
	};
	const flat = {
		name: 'StorageBuffer_4',
		count: 8,
		itemSize: 1,
		arrayType: 'Uint32Array',
		source: { kind: 'storage.buffer', attributeName: 'Current_Right' },
	};
	const ordered = JSON.parse( JSON.stringify( flat ) );
	const artifact = {
		uniformPlan: [ {
			storageBuffers: [ flat ],
			orderedBindings: [ { type: 'storage-buffer', ref: ordered } ],
		} ],
	};

	const wired = wireArtifactStorageBuffersFromAttributes( artifact, [
		{ attribute, attributeName: 'Current_Right' },
	] );

	assert.equal( wired, 1, 'one logical storage binding is wired' );
	assert.equal( flat._liveAttribute, attribute );
	assert.equal( ordered._liveAttribute, attribute );
	assert.equal( attribute.version, 5, 'the alias pair bumps the live attribute once' );

} );

test( 'pingPongInvalidate bumps both texture versions and clears the bind-group cache', () => {

	const texA = { isTexture: true, isStorageTexture: true, version: 3, name: 'A' };
	const texB = { isTexture: true, isStorageTexture: true, version: 5, name: 'B' };
	const slim = fakeRenderer();
	const cachedBindGroup = { bindings: [] };
	const bindGroupBackend = slim.backend.get( cachedBindGroup );
	bindGroupBackend.groups = [ {} ];
	bindGroupBackend.versions = [ 1 ];
	const txA = slim._textures.get( texA );
	const txB = slim._textures.get( texB );
	txA.bindGroups = new Set( [ cachedBindGroup ] );
	txB.bindGroups = new Set( [ cachedBindGroup ] );
	// Also seed view cache entries to confirm clearTextureViewCache runs.
	slim.backend.get( texA )[ 'view-default' ] = { __view: 'A' };
	slim.backend.get( texB )[ 'view-default' ] = { __view: 'B' };

	const ok = pingPongInvalidate( texA, texB, slim );

	assert.equal( ok, true );
	assert.equal( texA.version, 4 );
	assert.equal( texB.version, 6 );
	assert.equal( slim.backend.get( texA ).version, 4 );
	assert.equal( slim.backend.get( texB ).version, 6 );
	assert.equal( slim.backend.get( texA )[ 'view-default' ], undefined, 'view cache cleared on A' );
	assert.equal( slim.backend.get( texB )[ 'view-default' ], undefined, 'view cache cleared on B' );
	assert.equal( bindGroupBackend.groups, undefined );
	assert.equal( bindGroupBackend.versions, undefined );
	assert.equal( txA.bindGroups.size, 0 );
	assert.equal( txB.bindGroups.size, 0 );

} );

test( 'pingPongInvalidate accepts an array of renderers and invalidates all of them', () => {

	const texA = { isTexture: true, isStorageTexture: true, version: 0 };
	const texB = { isTexture: true, isStorageTexture: true, version: 0 };
	const slim = fakeRenderer();
	const full = fakeRenderer();

	const ok = pingPongInvalidate( texA, texB, [ slim, full ] );

	assert.equal( ok, true );
	assert.equal( slim.backend.get( texA ).version, 1 );
	assert.equal( full.backend.get( texA ).version, 1 );
	assert.equal( slim.backend.get( texB ).version, 1 );
	assert.equal( full.backend.get( texB ).version, 1 );

} );

test( 'pingPongInvalidate gracefully no-ops on null / missing args', () => {

	assert.equal( pingPongInvalidate( null, {}, [ fakeRenderer() ] ), false );
	assert.equal( pingPongInvalidate( {}, null, [ fakeRenderer() ] ), false );
	assert.equal( pingPongInvalidate( {}, {}, null ), false );
	assert.equal( pingPongInvalidate( {}, {}, [] ), false );

} );

test( 'shareInstancedAttributeBufferIntoSlim adopts the full buffer and bumps slim attribute version', () => {

	const attr = { isInstancedBufferAttribute: true, name: 'instance-mat4' };
	const full = fakeRenderer();
	const slim = fakeRenderer();

	const gpuBuf = { __gpu: 'instance-buf', size: 4096 };
	full.backend.get( attr ).buffer = gpuBuf;

	const ok = shareInstancedAttributeBufferIntoSlim( attr, full, slim );

	assert.equal( ok, true );
	assert.equal( slim.backend.get( attr ).buffer, gpuBuf, 'slim now references the full renderer GPU buffer' );
	assert.equal( slim._attributes.get( attr ).version, 1, 'slim attribute version seeded' );

} );

test( 'shareInstancedAttributeBufferIntoSlim is a no-op when slim already holds the same buffer', () => {

	const attr = { isInstancedBufferAttribute: true };
	const buf = { __gpu: 'shared' };
	const full = fakeRenderer();
	const slim = fakeRenderer();
	full.backend.get( attr ).buffer = buf;
	slim.backend.get( attr ).buffer = buf; // already adopted

	const ok = shareInstancedAttributeBufferIntoSlim( attr, full, slim );

	assert.equal( ok, false, 'no-op when slim already references identical GPUBuffer' );

} );

test( 'shareInstancedAttributeBufferIntoSlim refuses to overwrite an existing distinct slim buffer', () => {

	const attr = { isInstancedBufferAttribute: true };
	const full = fakeRenderer();
	const slim = fakeRenderer();
	full.backend.get( attr ).buffer = { __gpu: 'fresh' };
	const oldSlimBuf = { __gpu: 'older' };
	slim.backend.get( attr ).buffer = oldSlimBuf;

	const ok = shareInstancedAttributeBufferIntoSlim( attr, full, slim );

	assert.equal( ok, false );
	assert.equal( slim.backend.get( attr ).buffer, oldSlimBuf, 'existing distinct slim buffer untouched' );

} );

test( 'shareInstancedAttributeBufferIntoSlim returns false on null / missing inputs', () => {

	const renderer = fakeRenderer();
	assert.equal( shareInstancedAttributeBufferIntoSlim( null, renderer, renderer ), false );
	assert.equal( shareInstancedAttributeBufferIntoSlim( {}, null, renderer ), false );
	assert.equal( shareInstancedAttributeBufferIntoSlim( {}, renderer, null ), false );
	// Full renderer present but has no buffer for the attribute → false.
	assert.equal( shareInstancedAttributeBufferIntoSlim( { isInstancedBufferAttribute: true }, renderer, renderer ), false );

} );
