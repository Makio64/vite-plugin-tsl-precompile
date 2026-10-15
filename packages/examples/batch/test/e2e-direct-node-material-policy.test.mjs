import assert from 'node:assert/strict';
import test from 'node:test';

import {
	classifyDirectNodeMaterialCapture,
	isRendererOwnedBackgroundMaterial,
	isRendererOwnedVsmMaterial,
} from '../e2e-direct-node-material-policy.mjs';

const BASE = Object.freeze( {
	materialClassName: 'NodeMaterial',
	authoredUserScene: true,
	syntheticScene: false,
	pmremRunning: false,
	syntheticRenderActive: false,
	offscreenRenderPass: false,
	objectSceneRelation: 'same',
} );

function classify( overrides = {} ) {

	return classifyDirectNodeMaterialCapture( { ...BASE, ...overrides } );

}

test( 'claims only the supported same-scene and detached direct-draw topology', () => {

	const cases = [
		{
			name: 'same-scene onscreen',
			input: { objectSceneRelation: 'same', offscreenRenderPass: false },
			expected: { claim: true, sceneHint: false, reason: 'scene-owned-onscreen' },
		},
		{
			name: 'detached onscreen',
			input: { objectSceneRelation: 'detached', offscreenRenderPass: false },
			expected: { claim: true, sceneHint: true, reason: 'detached-onscreen' },
		},
		{
			name: 'detached offscreen',
			input: { objectSceneRelation: 'detached', offscreenRenderPass: true },
			expected: { claim: true, sceneHint: true, reason: 'detached-offscreen' },
		},
		{
			name: 'same-scene offscreen',
			input: { objectSceneRelation: 'same', offscreenRenderPass: true },
			expected: { claim: false, sceneHint: false, reason: 'scene-owned-offscreen' },
		},
		{
			name: 'cross-scene',
			input: { objectSceneRelation: 'other' },
			expected: { claim: false, sceneHint: false, reason: 'cross-scene-object' },
		},
		{
			name: 'no scene relation',
			input: { objectSceneRelation: 'absent' },
			expected: { claim: false, sceneHint: false, reason: 'object-scene-absent' },
		},
	];

	for ( const { name, input, expected } of cases ) {

		assert.deepEqual( classify( input ), expected, name );

	}

} );

test( 'fails closed outside an authored non-synthetic user scene', () => {

	const cases = [
		{
			name: 'PMREM maintenance',
			input: { pmremRunning: true },
			expected: { claim: false, sceneHint: false, reason: 'pmrem-maintenance' },
		},
		{
			name: 'synthetic render scope',
			input: { syntheticRenderActive: true },
			expected: { claim: false, sceneHint: false, reason: 'synthetic-render-active' },
		},
		{
			name: 'synthetic scene',
			input: { syntheticScene: true },
			expected: { claim: false, sceneHint: false, reason: 'synthetic-scene' },
		},
		{
			name: 'non-authored scene',
			input: { authoredUserScene: false },
			expected: { claim: false, sceneHint: false, reason: 'non-authored-scene' },
		},
		{
			name: 'NodeMaterial subclass',
			input: { materialClassName: 'LensflareNodeMaterial' },
			expected: { claim: false, sceneHint: false, reason: 'non-generic-node-material' },
		},
		{
			name: 'invalid topology vocabulary',
			input: { objectSceneRelation: 'unknown' },
			expected: { claim: false, sceneHint: false, reason: 'invalid-object-scene-relation' },
		},
	];

	for ( const { name, input, expected } of cases ) {

		assert.deepEqual( classify( input ), expected, name );

	}

} );

test( 'defaults fail closed with a stable result shape', () => {

	assert.deepEqual( classifyDirectNodeMaterialCapture(), {
		claim: false,
		sceneHint: false,
		reason: 'non-authored-scene',
	} );
	assert.deepEqual( Object.keys( classify() ), [ 'claim', 'sceneHint', 'reason' ] );

} );

test( 'recognizes only Three r185 VSM materials in their private renderer lifecycle', () => {

	const VSM_SHADOW_MAP = Symbol( 'VSMShadowMap' );
	const RG_FORMAT = Symbol( 'RGFormat' );
	const HALF_FLOAT_TYPE = Symbol( 'HalfFloatType' );
	const camera = {};
	const material = {
		name: 'VSMVertical',
		isNodeMaterial: true,
		fragmentNode: { isNode: true },
	};
	const object = { isQuadMesh: true, material, camera, parent: null };
	const renderTarget = {
		isRenderTarget: true,
		depthBuffer: false,
		texture: {
			isTexture: true,
			format: RG_FORMAT,
			type: HALF_FLOAT_TYPE,
			name: '',
		},
	};
	const renderer = {
		shadowMap: { enabled: true, type: VSM_SHADOW_MAP },
		getRenderTarget: () => renderTarget,
	};
	const classifyVsm = ( candidateMaterial = material, candidateObject = object, candidateRenderer = renderer, candidateCamera = camera ) =>
		isRendererOwnedVsmMaterial(
			candidateMaterial,
			candidateObject,
			candidateRenderer,
			candidateCamera,
			VSM_SHADOW_MAP,
			RG_FORMAT,
			HALF_FLOAT_TYPE,
		);

	assert.equal( classifyVsm(), true );
	const horizontal = { ...material, name: 'VSMHorizontal' };
	assert.equal( classifyVsm(
		horizontal,
		{ ...object, material: horizontal },
		{ ...renderer, getRenderTarget: () => ( { ...renderTarget, texture: { ...renderTarget.texture, name: 'VSMHorizontal' } } ) },
	), true );

	const authoredCollision = { ...material, name: 'VSMVertical' };
	assert.equal(
		classifyVsm( authoredCollision, { isMesh: true, material: authoredCollision, camera, parent: null } ),
		false,
		'an authored regular Mesh cannot be skipped by an exact public-name collision',
	);
	assert.equal( classifyVsm( { ...material, name: 'MyVSMVertical' } ), false );
	assert.equal( classifyVsm( { ...material, name: 'vsmhorizontal' } ), false );
	assert.equal( classifyVsm( material, { ...object, material: {} } ), false );
	assert.equal( classifyVsm( material, { ...object, camera: {} } ), false );
	assert.equal( classifyVsm( material, object, { ...renderer, getRenderTarget: () => null } ), false );
	assert.equal( classifyVsm( material, object, { ...renderer, shadowMap: { enabled: false, type: VSM_SHADOW_MAP } } ), false );
	assert.equal( classifyVsm( material, object, { ...renderer, getRenderTarget: () => {

		throw new Error( 'target unavailable' );

	} } ), false );
	assert.equal( classifyVsm( null ), false );

} );

test( 'recognizes only the exact detached Three r185 background mesh and material pair', () => {

	const material = { name: 'Background.material', allowOverride: false };
	const object = { name: 'Background.mesh', frustumCulled: false, parent: null };
	assert.equal( isRendererOwnedBackgroundMaterial( material, object ), true );
	assert.equal( isRendererOwnedBackgroundMaterial( { ...material, name: 'My Background.material' }, object ), false );
	assert.equal( isRendererOwnedBackgroundMaterial( { ...material, allowOverride: true }, object ), false );
	assert.equal( isRendererOwnedBackgroundMaterial( material, { ...object, name: 'AuthoredBackground.mesh' } ), false );
	assert.equal( isRendererOwnedBackgroundMaterial( material, { ...object, frustumCulled: true } ), false );
	assert.equal( isRendererOwnedBackgroundMaterial( material, { ...object, parent: {} } ), false );
	assert.equal( isRendererOwnedBackgroundMaterial( null, object ), false );

} );
