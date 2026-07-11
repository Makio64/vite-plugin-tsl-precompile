/**
 * Extractor convergence guard — first wedge for ARCHITECTURE_EVOLUTION §P2.10.
 *
 * Proves the Node harness produces a stable uniform-plan *shape* across
 * repeated extracts of the same material factory. Full browser-capture vs
 * Node re-extract diffs remain a follow-up (needs committed capture fixtures
 * wired through verify.js).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
	diffArtifactShapes,
	fingerprintArtifactShape,
} from '@tsl-precompile/contract/artifact-shape';
import { extractMaterial } from '../../src/node-harness.js';

test( 'node harness extract is shape-stable across two runs of the same factory', async () => {

	const factory = ( { webgpu, tsl } ) => {

		const { MeshStandardNodeMaterial } = webgpu;
		const { color, mix, uv } = tsl;
		const material = new MeshStandardNodeMaterial();
		material.colorNode = mix( color( 'red' ), color( 'blue' ), uv().x );
		return { material, name: 'convergence-guard' };

	};

	const first = await extractMaterial( factory );
	const second = await extractMaterial( factory );
	const left = fingerprintArtifactShape( first.artifact );
	const right = fingerprintArtifactShape( second.artifact );
	const diff = diffArtifactShapes( left, right );

	assert.equal(
		diff.ok,
		true,
		`node extract shape drifted:\n  missing=${ JSON.stringify( diff.missing ) }\n  extra=${ JSON.stringify( diff.extra ) }`,
	);
	assert.ok( left.length > 0, 'expected a non-empty uniform-plan fingerprint' );

} );
