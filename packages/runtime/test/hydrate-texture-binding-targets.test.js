import test from 'node:test';
import assert from 'node:assert/strict';

import {
	invalidateOnTextureResourceChange,
	invalidateTextureBindingTarget,
	rebindTextureBindingTargets,
	textureBindingTargets,
} from '../src/hydrate/rebinders/texture-binding-targets.js';

function createBinding( texture ) {

	return {
		texture,
		groupNode: { version: 0 },
		version: 3,
		generation: 5,
	};

}

test( 'texture binding targets include clone-tracked source bindings once', () => {

	const texture = { uuid: 'a' };
	const source = createBinding( texture );
	const clone = createBinding( texture );
	Object.defineProperty( source, '__tslpRebindClones', {
		value: new Set( [ clone, clone, null ] ),
	} );
	Object.defineProperty( clone, '__tslpRebindSource', {
		value: source,
	} );

	assert.deepEqual( textureBindingTargets( clone ), [ source, clone ] );

} );

test( 'texture binding targets rebind clones and invalidate changed targets', () => {

	const textureA = { uuid: 'a' };
	const textureB = { uuid: 'b' };
	const source = createBinding( textureA );
	const clone = createBinding( textureA );
	Object.defineProperty( source, '__tslpRebindClones', {
		value: new Set( [ clone ] ),
	} );

	assert.equal( rebindTextureBindingTargets( source, textureB ), true );
	assert.equal( source.texture, textureB );
	assert.equal( clone.texture, textureB );
	assert.equal( source.groupNode.version, 1 );
	assert.equal( clone.groupNode.version, 1 );
	assert.equal( source.version, -1 );
	assert.equal( clone.version, -1 );
	assert.equal( source.generation, null );
	assert.equal( clone.generation, null );

	assert.equal( rebindTextureBindingTargets( source, textureB ), false );

} );

test( 'texture binding target invalidation can be called directly', () => {

	const target = createBinding( { uuid: 'a' } );

	invalidateTextureBindingTarget( target );

	assert.equal( target.groupNode.version, 1 );
	assert.equal( target.version, -1 );
	assert.equal( target.generation, null );

} );

test( 'texture binding resource signatures track texture, gpu texture, and version', () => {

	const texture = { uuid: 'a', version: 4 };
	const gpuTexture = { label: 'gpu-a' };
	const target = createBinding( texture );
	const renderer = {
		backend: {
			get: ( receivedTexture ) => {

				assert.equal( receivedTexture, texture );
				return { texture: gpuTexture };

			},
		},
	};

	const lastSeen = new WeakMap();
	invalidateOnTextureResourceChange( target, renderer, lastSeen );
	assert.deepEqual( lastSeen.get( target ), { texture, gpuTexture, version: 4 } );

} );

test( 'texture binding resource tracking invalidates after the first observed change', () => {

	const texture = { uuid: 'a', version: 1 };
	const target = createBinding( texture );
	let gpuTexture = { label: 'gpu-a' };
	const renderer = {
		backend: {
			get: () => ( { texture: gpuTexture } ),
		},
	};
	const lastSeen = new WeakMap();

	invalidateOnTextureResourceChange( target, renderer, lastSeen );
	assert.equal( target.groupNode.version, 0 );

	invalidateOnTextureResourceChange( target, renderer, lastSeen );
	assert.equal( target.groupNode.version, 0 );

	texture.version = 2;
	invalidateOnTextureResourceChange( target, renderer, lastSeen );
	assert.equal( target.groupNode.version, 1 );
	assert.equal( target.version, -1 );
	assert.equal( target.generation, null );

	gpuTexture = { label: 'gpu-b' };
	invalidateOnTextureResourceChange( target, renderer, lastSeen );
	assert.equal( target.groupNode.version, 2 );

} );

test( 'stable texture resources retain their snapshot without rewriting tracking state', () => {

	const texture = { version: 1 };
	const target = createBinding( texture );
	const resource = { texture: {} };
	let reads = 0;
	let writes = 0;
	const renderer = { backend: { get() { reads ++; return resource; } } };
	const lastSeen = new class extends WeakMap {

		set( key, value ) { writes ++; return super.set( key, value ); }

	}();
	invalidateOnTextureResourceChange( target, renderer, lastSeen );
	const initial = Object.freeze( lastSeen.get( target ) );
	for ( let i = 0; i < 10; i ++ ) invalidateOnTextureResourceChange( target, renderer, lastSeen );
	assert.equal( lastSeen.get( target ), initial );
	assert.equal( writes, 1 );
	assert.equal( reads, 11, 'the live resource is checked on every call' );
	assert.equal( target.groupNode.version, 0 );

	texture.version ++;
	invalidateOnTextureResourceChange( target, renderer, lastSeen );
	assert.notEqual( lastSeen.get( target ), initial );
	assert.equal( initial.version, 1, 'earlier snapshots are not mutated' );
	assert.equal( writes, 2 );
	assert.equal( target.groupNode.version, 1 );

} );

test( 'texture tracking detects replacement, missing resources and backend transitions', () => {

	const target = createBinding( { version: 1 } );
	const resource = { texture: {} };
	const renderer = { backend: { get: () => resource } };
	const lastSeen = new WeakMap();
	invalidateOnTextureResourceChange( target, renderer, lastSeen );
	let changes = 0;
	const check = ( activeRenderer = renderer ) => {

		invalidateOnTextureResourceChange( target, activeRenderer, lastSeen );
		assert.equal( target.groupNode.version, ++ changes );
		invalidateOnTextureResourceChange( target, activeRenderer, lastSeen );
		assert.equal( target.groupNode.version, changes, 'stable state must not invalidate twice' );

	};

	target.texture = { version: 1 };
	check();
	resource.texture = null;
	check();
	resource.texture = {};
	check();
	check( null );
	check();
	const otherResource = { texture: {} };
	check( { backend: { get: () => otherResource } } );
	check();
	target.texture.version = NaN;
	check();
	target.texture.version = Infinity;
	invalidateOnTextureResourceChange( target, renderer, lastSeen );
	assert.equal( target.groupNode.version, changes, 'non-finite versions share the missing-version state' );
	target.texture = null;
	check();
	target.texture = { version: 0 };
	check();

} );

test( 'source and cloned texture bindings retain independent resource histories', () => {

	const texture = { version: 0 };
	const source = createBinding( texture );
	const clone = createBinding( texture );
	const resource = { texture: {} };
	const renderer = { backend: { get: () => resource } };
	const lastSeen = new WeakMap();
	invalidateOnTextureResourceChange( source, renderer, lastSeen );
	invalidateOnTextureResourceChange( clone, renderer, lastSeen );
	assert.notEqual( lastSeen.get( source ), lastSeen.get( clone ) );
	resource.texture = {};
	invalidateOnTextureResourceChange( source, renderer, lastSeen );
	assert.equal( source.groupNode.version, 1 );
	assert.equal( clone.groupNode.version, 0 );
	invalidateOnTextureResourceChange( clone, renderer, lastSeen );
	assert.equal( clone.groupNode.version, 1 );
	assert.deepEqual( lastSeen.get( source ), lastSeen.get( clone ) );
	assert.notEqual( lastSeen.get( source ), lastSeen.get( clone ) );

} );
