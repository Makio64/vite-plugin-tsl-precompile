import test from 'node:test';
import assert from 'node:assert/strict';

import {
	clearViewportTextureIdentityPoolForTests,
	createViewportTextureRebinder,
	shouldSkipViewportCopyForZeroThicknessTransmission,
	shouldUseViewportFallbackForFrame,
} from '../src/hydrate/rebinders/viewport-texture-rebinder.js';

function createBinding( texture ) {

	return {
		texture,
		groupNode: { version: 0 },
		version: 0,
		generation: 1,
	};

}

const defaultRenderer = {
	backend: {
		get: ( texture ) => ( { texture: texture && texture.gpuTexture || null } ),
	},
};

function createFrame( renderId = 1, renderer = defaultRenderer ) {

	return {
		renderId,
		renderer,
	};

}

test( 'viewport texture helper keeps zero-thickness transmission on live viewport copies', () => {

	assert.equal( shouldSkipViewportCopyForZeroThicknessTransmission( {
		defaults: { transmission: 1, thickness: 0 },
		uniformPlan: [ { textures: [] } ],
	} ), false );

	assert.equal( shouldSkipViewportCopyForZeroThicknessTransmission( {
		defaults: { transmission: 1, thickness: 0.1 },
		uniformPlan: [ { textures: [] } ],
	} ), false );

	assert.equal( shouldSkipViewportCopyForZeroThicknessTransmission( {
		defaults: { transmission: 1, thickness: 0 },
		renderState: { transparent: true },
		uniformPlan: [ {
			textures: [ { source: { kind: 'material.alphaMap' } } ],
		} ],
	} ), false );

	assert.equal( shouldSkipViewportCopyForZeroThicknessTransmission( {
		defaults: { transmission: 1, thickness: 0 },
		renderState: { transparent: true },
		uniformPlan: [ {
			textures: [ { source: { kind: 'material.thicknessMap' } } ],
		} ],
	} ), false );

} );

test( 'viewport texture helper chooses fallback only for zero-thickness color viewport entries', () => {

	assert.equal( shouldUseViewportFallbackForFrame( {
		isDepth: false,
		skipZeroThicknessTransmission: true,
		material: { transmission: 1, thickness: 0 },
	} ), true );

	assert.equal( shouldUseViewportFallbackForFrame( {
		isDepth: true,
		skipZeroThicknessTransmission: true,
		material: { transmission: 1, thickness: 0 },
	} ), false );

	assert.equal( shouldUseViewportFallbackForFrame( {
		isDepth: false,
		skipZeroThicknessTransmission: true,
		material: { transmission: 1, thickness: 0.5 },
	} ), false );

	assert.equal( shouldUseViewportFallbackForFrame( {
		forceViewportFallback: true,
		isDepth: false,
		skipZeroThicknessTransmission: true,
		material: { transmission: 1, thickness: 0.5 },
	} ), true );

} );

test( 'viewport texture rebinder honors explicit zero-thickness fallback entries', () => {

	const liveTexture = { uuid: 'live', gpuTexture: { label: 'live-gpu' } };
	const fallbackTexture = { uuid: 'fallback', gpuTexture: { label: 'fallback-gpu' } };
	const binding = createBinding( liveTexture );
	const rebinder = createViewportTextureRebinder( [ {
		binding,
		fallbackTexture,
		isDepth: false,
		skipZeroThicknessTransmission: true,
		material: { transmission: 1, thickness: 0 },
	} ], {
		viewportMipTexture: () => {

			throw new Error( 'viewport node should not be created for fallback path' );

		},
	} );

	assert.equal( rebinder.getUpdateBeforeType(), 'render' );
	assert.equal( rebinder.updateReference(), rebinder );

	rebinder.updateBefore( createFrame() );

	assert.equal( binding.texture, fallbackTexture );
	assert.equal( binding.groupNode.version, 2 );
	assert.equal( binding.version, -1 );
	assert.equal( binding.generation, null );

} );

test( 'viewport texture rebinder drives live viewport copy for zero-thickness transmission', () => {

	const fallbackTexture = { uuid: 'fallback', gpuTexture: { label: 'fallback-gpu' } };
	const liveTexture = { uuid: 'live', gpuTexture: { label: 'live-gpu' } };
	const binding = createBinding( fallbackTexture );
	let factoryCalls = 0;
	let updateBeforeCalls = 0;
	const node = {
		value: liveTexture,
		updateReference: () => {},
		updateBefore: () => {

			updateBeforeCalls ++;

		},
	};
	const rebinder = createViewportTextureRebinder( [ {
		binding,
		fallbackTexture,
		generateMipmaps: true,
		isDepth: false,
		skipZeroThicknessTransmission: false,
		material: { transmission: 1, thickness: 0 },
	} ], {
		viewportMipTexture: () => {

			factoryCalls ++;
			return node;

		},
	} );

	rebinder.updateBefore( createFrame() );

	assert.equal( factoryCalls, 1 );
	assert.equal( updateBeforeCalls, 1 );
	assert.equal( binding.texture, liveTexture );
	assert.equal( binding.groupNode.version, 2 );
	assert.equal( binding.version, -1 );
	assert.equal( binding.generation, null );

} );

test( 'viewport texture rebinder drives viewport nodes once per render id and reuses them', () => {

	const fallbackTexture = { uuid: 'fallback', gpuTexture: { label: 'fallback-gpu' } };
	const liveTexture = { uuid: 'live', gpuTexture: { label: 'live-gpu' } };
	const binding = createBinding( fallbackTexture );
	let factoryCalls = 0;
	let updateReferenceCalls = 0;
	let updateBeforeCalls = 0;
	const node = {
		value: liveTexture,
		updateReference: () => {

			updateReferenceCalls ++;

		},
		updateBefore: () => {

			updateBeforeCalls ++;

		},
	};
	const rebinder = createViewportTextureRebinder( [ {
		binding,
		fallbackTexture,
		generateMipmaps: true,
		isDepth: false,
		skipZeroThicknessTransmission: false,
		material: {},
	} ], {
		viewportMipTexture: () => {

			factoryCalls ++;
			return node;

		},
	} );

	rebinder.updateBefore( createFrame( 7 ) );
	rebinder.updateBefore( createFrame( 7 ) );
	rebinder.updateBefore( createFrame( 8 ) );

	assert.equal( factoryCalls, 1 );
	assert.equal( updateReferenceCalls, 3 );
	assert.equal( updateBeforeCalls, 2 );
	assert.equal( binding.texture, liveTexture );

} );

test( 'viewport texture rebinder uses shared viewport nodes for shared entries', () => {

	const fallbackTexture = { uuid: 'fallback', gpuTexture: { label: 'fallback-gpu' } };
	const liveTexture = { uuid: 'shared-live', gpuTexture: { label: 'shared-gpu' } };
	const binding = createBinding( fallbackTexture );
	let sharedFactoryCalls = 0;
	let plainFactoryCalls = 0;
	let updateBeforeCalls = 0;
	const node = {
		value: liveTexture,
		updateReference: () => {},
		updateBefore: () => {

			updateBeforeCalls ++;

		},
	};
	const rebinder = createViewportTextureRebinder( [ {
		binding,
		fallbackTexture,
		generateMipmaps: false,
		isDepth: false,
		shared: true,
		skipZeroThicknessTransmission: false,
		material: {},
	} ], {
		viewportTexture: () => {

			plainFactoryCalls ++;
			return { value: { uuid: 'plain' }, updateBefore() {} };

		},
		viewportSharedTexture: () => {

			sharedFactoryCalls ++;
			return node;

		},
	} );

	rebinder.updateBefore( createFrame( 9 ) );

	assert.equal( sharedFactoryCalls, 1 );
	assert.equal( plainFactoryCalls, 0 );
	assert.equal( updateBeforeCalls, 1 );
	assert.equal( binding.texture, liveTexture );

} );

test( 'distinct shared viewport nodes refresh their common framebuffer in object order', () => {

	const sharedTexture = { uuid: 'shared-live', gpuTexture: { label: 'shared-gpu' } };
	const bindingA = createBinding( { uuid: 'fallback-a' } );
	const bindingB = createBinding( { uuid: 'fallback-b' } );
	const updateBeforeCalls = [];
	let factoryCalls = 0;
	const deps = {
		viewportSharedTexture: () => {

			const id = ++ factoryCalls;
			return {
				value: sharedTexture,
				updateReference: () => sharedTexture,
				updateBefore: () => { updateBeforeCalls.push( id ); },
			};

		},
	};
	const entry = ( binding ) => ( {
		binding,
		fallbackTexture: binding.texture,
		generateMipmaps: false,
		isDepth: false,
		shared: true,
		skipZeroThicknessTransmission: false,
		material: {},
	} );
	const rebinderA = createViewportTextureRebinder( [ entry( bindingA ) ], deps );
	const rebinderB = createViewportTextureRebinder( [ entry( bindingB ) ], deps );

	rebinderA.updateBefore( createFrame( 11 ) );
	rebinderB.updateBefore( createFrame( 11 ) );
	rebinderA.updateBefore( createFrame( 11 ) );
	rebinderB.updateBefore( createFrame( 11 ) );
	rebinderA.updateBefore( createFrame( 12 ) );
	rebinderB.updateBefore( createFrame( 12 ) );

	assert.equal( factoryCalls, 2 );
	assert.deepEqual( updateBeforeCalls, [ 1, 2, 1, 2 ] );
	assert.equal( bindingA.texture, sharedTexture );
	assert.equal( bindingB.texture, sharedTexture );

} );

test( 'viewport texture rebinder preserves captured reference equality across materials', () => {

	clearViewportTextureIdentityPoolForTests();
	const liveTexture = { uuid: 'identity-live', gpuTexture: { label: 'identity-gpu' } };
	const bindingA = createBinding( { uuid: 'fallback-a' } );
	const bindingB = createBinding( { uuid: 'fallback-b' } );
	let factoryCalls = 0;
	let updateBeforeCalls = 0;
	const deps = {
		viewportMipTexture: () => {

			factoryCalls ++;
			return {
				value: liveTexture,
				updateReference() {},
				updateBefore() { updateBeforeCalls ++; },
			};

		},
	};
	const entry = ( binding ) => ( {
		binding,
		fallbackTexture: binding.texture,
		generateMipmaps: true,
		isDepth: false,
		sourceIdentity: 'viewport-reference@1#captured-reference',
		skipZeroThicknessTransmission: false,
		material: {},
	} );
	const rebinderA = createViewportTextureRebinder( [ entry( bindingA ) ], deps );
	const rebinderB = createViewportTextureRebinder( [ entry( bindingB ) ], deps );

	rebinderA.updateBefore( createFrame( 21 ) );
	rebinderB.updateBefore( createFrame( 21 ) );
	rebinderA.updateBefore( createFrame( 22 ) );
	rebinderB.updateBefore( createFrame( 22 ) );

	assert.equal( factoryCalls, 1 );
	assert.equal( updateBeforeCalls, 2 );
	assert.equal( bindingA.texture, liveTexture );
	assert.equal( bindingB.texture, liveTexture );
	clearViewportTextureIdentityPoolForTests();

} );

test( 'viewport identity sharing wins over reconstructed copy variants', () => {

	clearViewportTextureIdentityPoolForTests();
	const liveTexture = { uuid: 'shared-variant-live', gpuTexture: { label: 'shared-variant-gpu' } };
	const mipBinding = createBinding( { uuid: 'mip-fallback' } );
	const plainBinding = createBinding( { uuid: 'plain-fallback' } );
	let mipFactoryCalls = 0;
	let plainFactoryCalls = 0;
	let updateBeforeCalls = 0;
	const node = {
		value: liveTexture,
		updateReference() { return liveTexture; },
		updateBefore() { updateBeforeCalls ++; },
	};
	const deps = {
		viewportMipTexture: () => { mipFactoryCalls ++; return node; },
		viewportTexture: () => { plainFactoryCalls ++; return node; },
	};
	const entry = ( binding, generateMipmaps ) => ( {
		binding,
		fallbackTexture: binding.texture,
		generateMipmaps,
		isDepth: false,
		sourceIdentity: 'viewport-reference@1#shared-copy-reference',
		skipZeroThicknessTransmission: false,
		material: {},
	} );
	const mip = createViewportTextureRebinder( [ entry( mipBinding, true ) ], deps );
	const plain = createViewportTextureRebinder( [ entry( plainBinding, false ) ], deps );

	mip.updateBefore( createFrame( 25 ) );
	plain.updateBefore( createFrame( 25 ) );

	assert.equal( mipFactoryCalls, 1 );
	assert.equal( plainFactoryCalls, 0 );
	assert.equal( updateBeforeCalls, 1 );
	assert.equal( mipBinding.texture, liveTexture );
	assert.equal( plainBinding.texture, liveTexture );
	clearViewportTextureIdentityPoolForTests();

} );

test( 'viewport texture copy cadence follows the live render-target reference', () => {

	clearViewportTextureIdentityPoolForTests();
	const referenceA = { uuid: 'target-a', gpuTexture: { label: 'target-a-gpu' } };
	const referenceB = { uuid: 'target-b', gpuTexture: { label: 'target-b-gpu' } };
	const binding = createBinding( { uuid: 'fallback' } );
	let activeReference = referenceA;
	let updateBeforeCalls = 0;
	const node = {
		value: activeReference,
		updateReference() {

			this.value = activeReference;
			return activeReference;

		},
		updateBefore() { updateBeforeCalls ++; },
	};
	const rebinder = createViewportTextureRebinder( [ {
		binding,
		fallbackTexture: binding.texture,
		generateMipmaps: true,
		isDepth: false,
		sourceIdentity: 'viewport-reference@1#multi-target-reference',
		skipZeroThicknessTransmission: false,
		material: {},
	} ], {
		viewportMipTexture: () => node,
	} );

	rebinder.updateBefore( createFrame( 31 ) );
	activeReference = referenceB;
	rebinder.updateBefore( createFrame( 31 ) );
	rebinder.updateBefore( createFrame( 31 ) );

	assert.equal( updateBeforeCalls, 2 );
	assert.equal( binding.texture, referenceB );
	clearViewportTextureIdentityPoolForTests();

} );
