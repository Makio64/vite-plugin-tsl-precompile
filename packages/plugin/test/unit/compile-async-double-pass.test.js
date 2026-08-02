import assert from 'node:assert/strict';
import test from 'node:test';

import {
	compileDoublePassPairsSynchronously,
	suppressWebGPUFramebufferCopiesDuringCompile,
} from '../../src/vendor/compile-async-double-pass.js';

test( 'compileAsync double-pass adapter specializes only matched back/front requests and restores exactly', () => {

	const compilationQueue = [];
	const calls = [];
	const original = function createObjectPipeline( ...args ) {

		calls.push( {
			passId: args[ 7 ],
			synchronous: this._compilationPromises === null,
		} );

	};
	const renderer = {
		_compilationPromises: compilationQueue,
		_createObjectPipeline: original,
	};
	const object = {};
	const material = {};
	const invoke = ( passId, sourceObject = object, sourceMaterial = material ) => {

		renderer._createObjectPipeline(
			sourceObject,
			sourceMaterial,
			null,
			null,
			null,
			null,
			null,
			passId,
		);

	};

	const restore = compileDoublePassPairsSynchronously( renderer );
	invoke( 'backSide' );
	invoke( 'frontSide' );
	invoke( 'ordinary' );
	invoke( 'frontSide', {}, material );

	assert.deepEqual( calls, [
		{ passId: 'backSide', synchronous: true },
		{ passId: 'frontSide', synchronous: true },
		{ passId: 'ordinary', synchronous: false },
		{ passId: 'frontSide', synchronous: false },
	] );
	assert.strictEqual( renderer._compilationPromises, compilationQueue );
	assert.notStrictEqual( renderer._createObjectPipeline, original );

	restore();
	assert.strictEqual( renderer._createObjectPipeline, original );
	assert.strictEqual( renderer._compilationPromises, compilationQueue );

} );

test( 'compileAsync framebuffer adapter suppresses only backend copies and restores ownership exactly', () => {

	let copies = 0;
	const prototype = {
		copyFramebufferToTexture() { copies ++; },
	};
	const backend = Object.assign( Object.create( prototype ), {
		isWebGPUBackend: true,
	} );
	const renderer = {
		backend,
		copyFramebufferToTexture() {

			this.backend.copyFramebufferToTexture();

		},
	};

	const restoreInherited = suppressWebGPUFramebufferCopiesDuringCompile( renderer );
	assert.equal( Object.hasOwn( backend, 'copyFramebufferToTexture' ), true );
	renderer.copyFramebufferToTexture();
	assert.equal( copies, 0, 'renderer-level allocation path remains callable while the stale backend copy is suppressed' );
	restoreInherited();
	assert.equal( Object.hasOwn( backend, 'copyFramebufferToTexture' ), false, 'an inherited backend method restores by deleting the adapter' );
	renderer.copyFramebufferToTexture();
	assert.equal( copies, 1 );

	const owned = function ownedCopy() { copies ++; };
	Object.defineProperty( backend, 'copyFramebufferToTexture', {
		value: owned,
		configurable: true,
		writable: true,
	} );
	const descriptor = Object.getOwnPropertyDescriptor( backend, 'copyFramebufferToTexture' );
	const restoreOwned = suppressWebGPUFramebufferCopiesDuringCompile( renderer );
	renderer.copyFramebufferToTexture();
	assert.equal( copies, 1 );
	restoreOwned();
	assert.deepEqual( Object.getOwnPropertyDescriptor( backend, 'copyFramebufferToTexture' ), descriptor );
	renderer.copyFramebufferToTexture();
	assert.equal( copies, 2 );

} );
