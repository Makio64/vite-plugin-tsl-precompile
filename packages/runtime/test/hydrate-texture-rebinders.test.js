import test from 'node:test';
import assert from 'node:assert/strict';

import {
	createArtifactTextureRebinder,
	createMaterialTextureRebinder,
} from '../src/hydrate/rebinders/texture-rebinders.js';

function createBinding( texture ) {

	return {
		texture,
		groupNode: { version: 0 },
		version: 0,
		generation: 1,
	};

}

test( 'material texture rebinder re-resolves material texture bindings', () => {

	const textureA = { uuid: 'a', version: 1 };
	const textureB = { uuid: 'b', version: 1 };
	const binding = createBinding( textureA );
	const artifact = {};
	const material = {};
	let call = null;
	const rebinder = createMaterialTextureRebinder( [ {
		binding,
		artifact,
		groupName: 'render',
		bindingName: 'nodeTexture0',
		material,
	} ], {
		resolveTextureBinding: ( receivedArtifact, groupName, bindingName, receivedMaterial ) => {

			call = { receivedArtifact, groupName, bindingName, receivedMaterial };
			return textureB;

		},
	} );

	assert.equal( rebinder.getUpdateBeforeType(), 'render' );
	assert.equal( rebinder.updateReference(), rebinder );

	rebinder.updateBefore( {
		renderer: {
			backend: {
				get: ( texture ) => ( { texture: { label: texture.uuid } } ),
			},
		},
	} );

	assert.deepEqual( call, {
		receivedArtifact: artifact,
		groupName: 'render',
		bindingName: 'nodeTexture0',
		receivedMaterial: material,
	} );
	assert.equal( binding.texture, textureB );
	assert.equal( binding.groupNode.version, 1 );
	assert.equal( binding.version, -1 );
	assert.equal( binding.generation, null );

} );

test( 'material texture rebinder refreshes the captured UUID relation for uniform writers', () => {

	const textureA = { isTexture: true, uuid: 'fresh-a', version: 1 };
	const textureB = { isTexture: true, uuid: 'fresh-b', version: 1 };
	const binding = createBinding( textureA );
	const artifact = {};
	const source = { kind: 'material.map', property: 'map', textureUuid: 'captured-map' };
	const rebinder = createMaterialTextureRebinder( [ {
		binding,
		artifact,
		groupName: 'render',
		bindingName: 'nodeTexture0',
		material: {},
		source,
	} ], {
		resolveTextureBinding: () => textureB,
	} );

	rebinder.updateBefore( {} );

	assert.equal( artifact._textureRefs.get( source.textureUuid ), textureB );
	assert.equal( Object.prototype.propertyIsEnumerable.call( artifact, '_textureRefs' ), false );

} );

test( 'artifact texture rebinder passes the current render-target texture as an avoid hint', () => {

	const textureA = { uuid: 'a', version: 1 };
	const textureB = { uuid: 'b', version: 1 };
	const avoidTexture = { uuid: 'avoid' };
	const binding = createBinding( textureA );
	let optionsSeen = null;
	const rebinder = createArtifactTextureRebinder( [ {
		binding,
		artifact: {},
		groupName: 'render',
		bindingName: 'nodeTexture0',
		material: {},
	} ], {
		resolveTextureBinding: ( artifact, groupName, bindingName, material, options ) => {

			optionsSeen = options;
			return textureB;

		},
	} );

	const frame = {
		renderer: {
			getRenderTarget: () => ( { texture: avoidTexture } ),
			backend: {
				get: ( texture ) => ( { texture: { label: texture.uuid } } ),
			},
		},
	};
	rebinder.updateBefore( frame );

	assert.deepEqual( optionsSeen, { avoidTexture, frame } );
	assert.equal( binding.texture, textureB );

} );

test( 'artifact texture rebinder refreshes the captured UUID relation for uniform writers', () => {

	const textureA = { isTexture: true, uuid: 'fresh-a', version: 1 };
	const textureB = { isTexture: true, uuid: 'fresh-b', version: 1 };
	const binding = createBinding( textureA );
	const source = { kind: 'artifact.texture', textureUuid: 'captured-texture' };
	const refs = new Map( [ [ source.textureUuid, textureA ] ] );
	const rootArtifact = {};
	Object.defineProperty( rootArtifact, '_textureRefs', {
		value: refs,
		enumerable: false,
		configurable: true,
		writable: true,
	} );
	const artifact = {};
	Object.defineProperty( artifact, '_textureRefs', {
		get: () => rootArtifact._textureRefs,
		set: ( value ) => { rootArtifact._textureRefs = value; },
		configurable: true,
	} );
	const rebinder = createArtifactTextureRebinder( [ {
		binding,
		artifact,
		groupName: 'render',
		bindingName: 'nodeTexture0',
		material: {},
		source,
	} ], {
		resolveTextureBinding: () => textureB,
	} );

	rebinder.updateBefore( {} );

	assert.equal( rootArtifact._textureRefs, refs, 'shared root/view map identity is preserved' );
	assert.equal( artifact._textureRefs, refs );
	assert.equal( artifact._textureRefs.get( source.textureUuid ), textureB );
	assert.equal( Object.prototype.propertyIsEnumerable.call( rootArtifact, '_textureRefs' ), false );

} );

test( 'artifact texture rebinder invalidates when the backend GPU texture changes after first observation', () => {

	const texture = { uuid: 'a', version: 1 };
	const binding = createBinding( texture );
	let gpuTexture = { label: 'gpu-a' };
	const rebinder = createArtifactTextureRebinder( [ {
		binding,
		artifact: {},
		groupName: 'render',
		bindingName: 'nodeTexture0',
		material: {},
	} ], {
		resolveTextureBinding: () => null,
	} );
	const frame = {
		renderer: {
			backend: {
				get: () => ( { texture: gpuTexture } ),
			},
		},
	};

	rebinder.updateBefore( frame );
	assert.equal( binding.groupNode.version, 0 );

	rebinder.updateBefore( frame );
	assert.equal( binding.groupNode.version, 0 );

	gpuTexture = { label: 'gpu-b' };
	rebinder.updateBefore( frame );
	assert.equal( binding.groupNode.version, 1 );
	assert.equal( binding.version, -1 );
	assert.equal( binding.generation, null );

} );
