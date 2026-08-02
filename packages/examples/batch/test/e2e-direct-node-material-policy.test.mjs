import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyDirectNodeMaterialCapture } from '../e2e-direct-node-material-policy.mjs';

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
