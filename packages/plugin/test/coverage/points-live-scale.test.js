import { test } from 'node:test';
import assert from 'node:assert/strict';

import { generateForMaterial, assertNoUnknownKinds } from './_helpers.js';

test( 'PointsNodeMaterial live renderer scale maps to renderer.halfHeight', async () => {

	const result = await generateForMaterial( ( { webgpu } ) => {

		const material = new webgpu.PointsNodeMaterial();
		return { material, name: 'coverage-points-live-scale' };

	} );

	const blocked = assertNoUnknownKinds( result, 'PointsNodeMaterial-live-scale' );
	assert.deepEqual( blocked.filter( ( item ) => item.kind === 'uniform.live' ), [] );
	assert.equal(
		result.artifact.uniformPlan.some( ( group ) => group.slots.some( ( slot ) => slot.source && slot.source.kind === 'renderer.halfHeight' ) ),
		true,
	);
	assert.match( result.source, /frame\.renderer\.getSize\(_rSize\)/ );

} );
