import test from 'node:test';
import assert from 'node:assert/strict';

import {
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

function createFrame( renderId = 1 ) {

	return {
		renderId,
		renderer: {
			backend: {
				get: ( texture ) => ( { texture: texture && texture.gpuTexture || null } ),
			},
		},
	};

}

test( 'viewport texture helper keeps most zero-thickness transmission on live viewport copies', () => {

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
	} ), true );

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
