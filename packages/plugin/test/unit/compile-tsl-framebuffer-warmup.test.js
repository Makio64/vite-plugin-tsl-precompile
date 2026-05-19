import assert from 'node:assert/strict';
import test from 'node:test';

import { compileTSL } from '../../src/vendor/compileTSL.js';

test( 'compileTSL binds the renderer framebuffer target during canvas warm-up', async () => {

	const framebufferTarget = { label: 'framebuffer-target', samples: 4 };
	const calls = [];
	let currentRenderTarget = null;

	const manager = {
		nodeBuilderCache: new Map(),
		getForRenderCacheKey() { return 'unused'; },
		getForRender() { return null; },
	};

	const renderer = {
		_nodes: manager,
		needsFrameBufferTarget: true,
		getRenderTarget() { return currentRenderTarget; },
		setRenderTarget( target ) {

			currentRenderTarget = target;
			calls.push( [ 'setRenderTarget', target ] );

		},
		getMRT() { return null; },
		setMRT( target ) { calls.push( [ 'setMRT', target ] ); },
		_getFrameBufferTarget() {

			calls.push( [ '_getFrameBufferTarget' ] );
			return framebufferTarget;

		},
		async compileAsync() {

			calls.push( [ 'compileAsync', currentRenderTarget ] );

		},
		render() {

			calls.push( [ 'render', currentRenderTarget ] );

		},
	};

	const scene = { userData: {}, traverse() {} };
	const artifacts = await compileTSL( renderer, scene, {} );

	assert.equal( artifacts.length, 0 );
	assert.equal( calls.some( ( call ) => call[ 0 ] === '_getFrameBufferTarget' ), true );
	assert.deepEqual( calls.find( ( call ) => call[ 0 ] === 'compileAsync' ), [ 'compileAsync', framebufferTarget ] );
	assert.deepEqual( calls.find( ( call ) => call[ 0 ] === 'render' ), [ 'render', framebufferTarget ] );
	assert.equal( currentRenderTarget, null, 'compileTSL restores the prior canvas render target' );

} );
