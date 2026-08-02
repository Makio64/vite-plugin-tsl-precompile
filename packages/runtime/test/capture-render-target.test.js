import test from 'node:test';
import assert from 'node:assert/strict';

import {
	BACKGROUND_CAPTURE_RENDER_TARGETS,
	MRT_CAPTURE_RENDER_TARGET,
	cloneRenderTargetForCapture,
	getBackgroundCaptureRenderTargets,
	getMRTCaptureRenderTarget,
	rememberBackgroundCaptureRenderTarget,
	rememberMRTCaptureRenderTarget,
	takeBackgroundCaptureRenderTargets,
} from '../src/capture-render-target.js';

function makeCaptureTarget( {
	colorFormat = 1023,
	colorType = 1016,
	depthFormat = 1026,
	depthType = 1015,
	onClone = null,
} = {} ) {

	const target = {
		texture: { format: colorFormat, type: colorType },
		depthTexture: { format: depthFormat, type: depthType },
		clone() {

			const clone = {
				texture: { ...this.texture },
				depthTexture: { ...this.depthTexture },
				disposed: false,
				setSize() {},
				dispose() { this.disposed = true; },
			};
			if ( onClone ) onClone( clone );
			return clone;

		},
	};
	return target;

}

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

test( 'background capture remembers exact target/MRT siblings per renderer, including default output', () => {

	const scene = { userData: {} };
	const renderer = {};
	const otherRenderer = {};
	let floatDepthClone = null;
	let uintDepthClone = null;
	const floatDepthTarget = makeCaptureTarget( { depthType: 1015, onClone: ( clone ) => { floatDepthClone = clone; } } );
	const uintDepthTarget = makeCaptureTarget( { depthType: 1014, onClone: ( clone ) => { uintDepthClone = clone; } } );
	const mrtNode = {};

	rememberBackgroundCaptureRenderTarget( scene, renderer, floatDepthTarget, mrtNode );
	rememberBackgroundCaptureRenderTarget( scene, renderer, null, null );
	rememberBackgroundCaptureRenderTarget( scene, renderer, floatDepthTarget, mrtNode );
	rememberBackgroundCaptureRenderTarget( scene, otherRenderer, uintDepthTarget, null );

	const contexts = getBackgroundCaptureRenderTargets( scene, renderer );
	assert.equal( contexts.length, 2 );
	assert.equal( contexts.find( ( context ) => context.captureRenderTarget ).captureRenderTarget, floatDepthClone );
	assert.equal( contexts.find( ( context ) => ! context.captureRenderTarget ).mrtNode, null );
	assert.equal( contexts.some( ( context ) => context.captureRenderTarget === floatDepthTarget ), false, 'live targets are never retained' );
	const otherContexts = getBackgroundCaptureRenderTargets( scene, otherRenderer );
	assert.equal( otherContexts.length, 1 );
	assert.equal( otherContexts[ 0 ].captureRenderTarget, uintDepthClone );
	assert.equal( scene[ BACKGROUND_CAPTURE_RENDER_TARGETS ].byRenderer instanceof WeakMap, true );
	assert.deepEqual( Object.keys( scene ), [ 'userData' ] );
	assert.doesNotThrow( () => JSON.stringify( scene.userData ) );

} );

test( 'background capture owns one representative for churned topology and consumes each wave', () => {

	const scene = {};
	const renderer = {};
	const mrtNode = {
		outputNodes: { color: {}, normal: {} },
		blendModes: { color: 1, normal: 1 },
	};
	let cloneCalls = 0;
	const ownedClones = [];
	for ( let i = 0; i < 100; i ++ ) {

		const target = makeCaptureTarget( {
			onClone: ( clone ) => {

				cloneCalls ++;
				clone.textures = [
					{ format: 1023, type: 1016, name: 'color' },
					{ format: 1023, type: 1016, name: 'normal' },
				];
				ownedClones.push( clone );

			},
		} );
		target.textures = [
			{ format: 1023, type: 1016, name: 'color' },
			{ format: 1023, type: 1016, name: 'normal' },
		];
		delete target.texture;
		target.samples = 4;
		rememberBackgroundCaptureRenderTarget( scene, renderer, target, mrtNode );

	}

	assert.equal( cloneCalls, 1, 'same-topology churn allocates one owned representative' );
	const retained = getBackgroundCaptureRenderTargets( scene, renderer );
	assert.equal( retained.length, 1 );
	assert.equal( retained[ 0 ].captureRenderTarget, ownedClones[ 0 ] );
	const taken = takeBackgroundCaptureRenderTargets( scene, renderer );
	assert.equal( taken.length, 1 );
	assert.equal( taken[ 0 ].captureRenderTarget, ownedClones[ 0 ] );
	assert.deepEqual( getBackgroundCaptureRenderTargets( scene, renderer ), [], 'consuming a wave releases its strong representatives' );
	taken[ 0 ].captureRenderTarget.dispose();
	assert.equal( ownedClones[ 0 ].disposed, true );

} );

test( 'background capture target topology history fails closed at its fixed bound and drains cleanly', () => {

	const scene = {};
	const renderer = {};
	const ownedClones = [];
	for ( let i = 0; i < 48; i ++ ) {

		const target = makeCaptureTarget( {
			colorFormat: 1023 + i,
			onClone: ( clone ) => ownedClones.push( clone ),
		} );
		rememberBackgroundCaptureRenderTarget( scene, renderer, target );

	}

	const retained = getBackgroundCaptureRenderTargets( scene, renderer );
	assert.equal( retained.length, 32 );
	assert.equal( ownedClones.length, 32, 'overflow does not allocate unbounded private targets' );
	assert.throws(
		() => takeBackgroundCaptureRenderTargets( scene, renderer ),
		( error ) => error && error.code === 'TSLP_BACKGROUND_CAPTURE_TARGET_OVERFLOW',
	);
	assert.equal( ownedClones.every( ( clone ) => clone.disposed ), true, 'failed wave releases every owned target' );

	const nextTarget = makeCaptureTarget( { colorFormat: 2048 } );
	rememberBackgroundCaptureRenderTarget( scene, renderer, nextTarget );
	const nextWave = takeBackgroundCaptureRenderTargets( scene, renderer );
	assert.equal( nextWave.length, 1, 'overflow cannot poison a later valid wave' );
	nextWave[ 0 ].captureRenderTarget.dispose();

} );

test( 'a fresh same-topology target replaces an uncloneable stale representative', () => {

	const scene = {};
	const renderer = {};
	const staleTarget = {
		texture: { format: 1023, type: 1016 },
		depthTexture: { format: 1026, type: 1015 },
		clone: () => null,
	};
	const freshTarget = {
		texture: { format: 1023, type: 1016 },
		depthTexture: { format: 1026, type: 1015 },
		clone: () => ( { setSize() {}, disposed: false, dispose() { this.disposed = true; } } ),
	};

	rememberBackgroundCaptureRenderTarget( scene, renderer, staleTarget );
	rememberBackgroundCaptureRenderTarget( scene, renderer, freshTarget );

	const taken = takeBackgroundCaptureRenderTargets( scene, renderer );
	assert.equal( taken.length, 1 );
	assert.notEqual( taken[ 0 ].captureRenderTarget, freshTarget );
	assert.equal( taken[ 0 ].ownsRenderTarget, true );
	taken[ 0 ].captureRenderTarget.dispose();

} );

test( 'an uncloneable wave fails once without poisoning the next valid wave', () => {

	const scene = {};
	const renderer = {};
	const staleTarget = {
		texture: { format: 1023, type: 1016 },
		depthTexture: { format: 1026, type: 1015 },
		clone: () => null,
	};
	rememberBackgroundCaptureRenderTarget( scene, renderer, staleTarget );
	assert.throws(
		() => takeBackgroundCaptureRenderTargets( scene, renderer ),
		( error ) => error && error.code === 'TSLP_BACKGROUND_CAPTURE_TARGET_UNCLONEABLE',
	);

	const validTarget = makeCaptureTarget();
	rememberBackgroundCaptureRenderTarget( scene, renderer, validTarget );
	const nextWave = takeBackgroundCaptureRenderTargets( scene, renderer );
	assert.equal( nextWave.length, 1 );
	assert.equal( nextWave[ 0 ].ownsRenderTarget, true );
	nextWave[ 0 ].captureRenderTarget.dispose();

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
		isPostProcessingRenderTarget: true,
		clone: () => clone,
	};

	assert.equal( cloneRenderTargetForCapture( source, [ 'output', 'velocity' ] ), clone );
	assert.deepEqual( [ clone.width, clone.height ], [ 1, 1 ] );
	assert.deepEqual( cloneDepth.image, { width: 1, height: 1 } );
	assert.equal( clone.isPostProcessingRenderTarget, true, 'private output-intermediate topology survives cloning' );
	assert.deepEqual( sourceDepth.image, { width: 640, height: 480 }, 'the live depth texture is untouched' );

} );

test( 'capture target clones retain the minimum legal extent for manual mip chains', () => {

	const clone = {
		width: 640,
		height: 480,
		texture: { name: 'SSRNode.Blur', mipmaps: [ {}, {}, {}, {}, {} ] },
		setSize( width, height ) {

			this.width = width;
			this.height = height;

		},
	};
	const source = {
		texture: { name: 'SSRNode.Blur', mipmaps: [ {}, {}, {}, {}, {} ] },
		clone: () => clone,
	};

	assert.equal( cloneRenderTargetForCapture( source ), clone );
	assert.deepEqual( [ clone.width, clone.height ], [ 16, 16 ] );

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
