import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	createLayeredCapturePrearmRegistry,
	isVerifiedLayeredRenderTarget,
} from '../layered-capture-prearm.mjs';

test( 'layered capture requires target-owned array or 3D evidence', () => {

	const arrayTexture = { isArrayTexture: true };
	const data3DTexture = { isData3DTexture: true };

	assert.equal(
		isVerifiedLayeredRenderTarget( {
			isRenderTarget: true,
			depth: 109,
			texture: arrayTexture,
		} ),
		true,
	);
	assert.equal(
		isVerifiedLayeredRenderTarget( {
			isRenderTarget: true,
			isRenderTarget3D: true,
			depth: 109,
			texture: data3DTexture,
		} ),
		true,
	);

	for ( const nearMiss of [
		{ depth: 109, texture: arrayTexture },
		{ isRenderTarget: true, depth: 1, texture: arrayTexture },
		{ isRenderTarget: true, depth: 109, texture: {} },
		{ isRenderTarget: true, isRenderTarget3D: true, depth: 109, texture: arrayTexture },
		{ isRenderTarget: true, depth: 109, texture: data3DTexture },
		{ isRenderTarget: true, isCubeRenderTarget: true, depth: 6, texture: arrayTexture },
		{ isRenderTarget: true, isWebGLCubeRenderTarget: true, depth: 6, texture: arrayTexture },
	] ) {

		assert.equal( isVerifiedLayeredRenderTarget( nearMiss ), false );

	}

} );

test( 'layered capture pre-arms once per material and renderer', () => {

	const registry = createLayeredCapturePrearmRegistry();
	const material = {};
	const firstRenderer = {};
	const secondRenderer = {};
	const target = {
		isRenderTarget: true,
		depth: 109,
		texture: { isArrayTexture: true },
	};

	assert.equal( registry.claim( {
		material,
		renderer: firstRenderer,
		renderTarget: target,
		captureMaintenance: true,
	} ), false, 'maintenance does not consume the claim' );
	assert.equal( registry.claim( { material, renderer: firstRenderer, renderTarget: target } ), true );
	assert.equal( registry.claim( { material, renderer: firstRenderer, renderTarget: target } ), false );
	assert.equal( registry.claim( { material, renderer: secondRenderer, renderTarget: target } ), true );

} );
