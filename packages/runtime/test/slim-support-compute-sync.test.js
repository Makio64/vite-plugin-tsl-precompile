import test from 'node:test';
import assert from 'node:assert/strict';

import {
	getComputeBindGroups,
	computeNodeUsesStorageTexture,
	syncComputeStorageOutputs,
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

test( 'syncComputeStorageOutputs shares storage textures and bumps version', () => {

	const tex = { isTexture: true, isStorageTexture: true, name: 'compute-out', version: 7, generateMipmaps: true };
	const binding = { isSampledTexture: true, texture: tex };
	const bindGroup = { bindings: [ binding ] };

	const full = fakeRenderer( { bindGroupsForNode: () => [ bindGroup ] } );
	full.backend.get( tex ).texture = { __gpu: 'compute-out' };
	full.backend.get( tex ).format = 'rgba16float';

	const slim = fakeRenderer( { bindGroupsForNode: () => [ bindGroup ] } );

	const stats = syncComputeStorageOutputs( 'compute-node', full, slim );

	assert.equal( stats.texturesShared, 1 );
	assert.equal( stats.buffersAdopted, 0 );
	assert.equal( stats.buffersCopied, 0 );
	assert.equal( tex.version, 8, 'JS version bumped by underlying shadow-share' );
	assert.equal( slim.backend.get( tex ).texture, full.backend.get( tex ).texture );
	assert.deepEqual( slim.generateMipmapsCalls, [ tex ], 'mipmaps regenerated for storage texture' );

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
	const stats = syncComputeStorageOutputs( 'n', full, slim, { onStorageAttr: ( a ) => remembered.push( a ) } );

	assert.equal( stats.buffersAdopted, 1 );
	assert.equal( stats.buffersCopied, 0 );
	assert.equal( slim.backend.get( attr ).buffer, fullBuf );
	assert.equal( slimAttrEntry.version, 1 );
	assert.deepEqual( remembered, [ attr ] );
	assert.equal( slim.submittedCommandBuffers.length, 0, 'adopt path enqueues no copy' );

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
	assert.equal( stats.buffersAdopted, 0 );
	assert.equal( slim.copyCalls.length, 1 );
	const call = slim.copyCalls[ 0 ];
	assert.equal( call.srcBuf, fullBuf );
	assert.equal( call.dstBuf, slimBuf );
	assert.equal( call.size, 1024, 'clamped to min(full.size, slim.size)' );
	assert.equal( slim.submittedCommandBuffers.length, 1, 'single command buffer submitted' );

} );

test( 'syncComputeStorageOutputs gracefully handles missing slim device', () => {

	const slim = fakeRenderer();
	slim.backend.device = null;
	const stats = syncComputeStorageOutputs( 'n', fakeRenderer(), slim );
	assert.deepEqual( stats, { texturesShared: 0, buffersAdopted: 0, buffersCopied: 0 } );

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

	assert.deepEqual( stats, { texturesShared: 0, buffersAdopted: 0, buffersCopied: 0 } );
	assert.deepEqual( errs, [ 'encoder-blown' ] );

} );
