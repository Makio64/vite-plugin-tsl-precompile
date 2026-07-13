import test from 'node:test';
import assert from 'node:assert/strict';

import {
	MRT_CAPTURE_RENDER_TARGET,
	cloneRenderTargetForCapture,
	getMRTCaptureRenderTarget,
	rememberMRTCaptureRenderTarget,
} from '../src/capture-render-target.js';

test( 'MRT capture targets stay outside serialisable Scene.userData', () => {

	const scene = { userData: {} };
	const mrtNode = {};
	const target = { textures: [] };
	rememberMRTCaptureRenderTarget( scene, target, mrtNode );

	assert.equal( getMRTCaptureRenderTarget( scene ), target );
	assert.equal( getMRTCaptureRenderTarget( scene, mrtNode ), target );
	assert.equal( scene[ MRT_CAPTURE_RENDER_TARGET ].latest, target );
	assert.deepEqual( Object.keys( scene ), [ 'userData' ] );
	assert.doesNotThrow( () => JSON.stringify( scene.userData ) );

} );

test( 'capture target clones preserve a complete named topology and shrink private resources', () => {

	const sourceDepth = { image: { width: 640, height: 480 } };
	const cloneDepth = { image: { width: 640, height: 480 } };
	const clone = {
		width: 640,
		height: 480,
		depthTexture: cloneDepth,
		setSize( width, height ) {

			this.width = width;
			this.height = height;

		},
	};
	const source = {
		textures: [ { name: 'output' }, { name: 'velocity' } ],
		depthTexture: sourceDepth,
		clone: () => clone,
	};

	assert.equal( cloneRenderTargetForCapture( source, [ 'output', 'velocity' ] ), clone );
	assert.deepEqual( [ clone.width, clone.height ], [ 1, 1 ] );
	assert.deepEqual( cloneDepth.image, { width: 1, height: 1 } );
	assert.deepEqual( sourceDepth.image, { width: 640, height: 480 }, 'the live depth texture is untouched' );

} );

test( 'MRT capture targets stay associated with their owning MRT node', () => {

	const scene = {};
	const firstMRT = {};
	const secondMRT = {};
	const firstTarget = { label: 'first' };
	const secondTarget = { label: 'second' };
	rememberMRTCaptureRenderTarget( scene, firstTarget, firstMRT );
	rememberMRTCaptureRenderTarget( scene, secondTarget, secondMRT );

	assert.equal( getMRTCaptureRenderTarget( scene, firstMRT ), firstTarget );
	assert.equal( getMRTCaptureRenderTarget( scene, secondMRT ), secondTarget );
	assert.equal( getMRTCaptureRenderTarget( scene ), secondTarget );
	assert.equal( getMRTCaptureRenderTarget( scene, {} ), null, 'unknown MRT nodes never borrow the latest pass target' );

} );

test( 'capture target cloning accepts reordered complete named MRT attachments', () => {

	const clone = { setSize() {} };
	const source = {
		textures: [ { name: 'velocity' }, { name: 'output' } ],
		clone: () => clone,
	};

	assert.equal( cloneRenderTargetForCapture( source, [ 'output', 'velocity' ] ), clone );

} );

test( 'capture target cloning rejects incomplete or duplicate MRT attachments', () => {

	let cloneCalls = 0;
	const clone = () => { cloneCalls ++; return {}; };

	assert.equal( cloneRenderTargetForCapture( { textures: [ { name: 'output' }, { name: 'velocity' } ], clone }, [ 'output', 'normal', 'velocity' ] ), null );
	assert.equal( cloneRenderTargetForCapture( { textures: [ { name: 'output' }, { name: 'output' } ], clone }, [ 'output', 'velocity' ] ), null );
	assert.equal( cloneCalls, 0, 'invalid live topology never reaches clone allocation' );

} );

test( 'capture target cloning preserves layers and disposes failed private clones', () => {

	let disposeCalls = 0;
	const clone = {
		depth: 6,
		setSize( width, height, depth ) {

			assert.deepEqual( [ width, height, depth ], [ 1, 1, 6 ] );
			throw new Error( 'resize failed' );

		},
		dispose() { disposeCalls ++; },
	};
	const source = { clone: () => clone };

	assert.equal( cloneRenderTargetForCapture( source ), null );
	assert.equal( disposeCalls, 1 );

} );
