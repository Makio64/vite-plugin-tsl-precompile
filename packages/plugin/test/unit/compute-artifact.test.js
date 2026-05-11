import { test } from 'node:test';
import assert from 'node:assert/strict';

import { extractComputeArtifact } from '../../src/vendor/compileTSL.js';

function fakeState() {

	return {
		computeShader: '@compute @workgroup_size( 1 ) fn main() {}',
		bindings: [],
		updateNodes: [],
		updateBeforeNodes: [],
		updateAfterNodes: [],
	};

}

test( 'extractComputeArtifact preserves numeric compute count and workgroup size', () => {

	const artifact = extractComputeArtifact( 1, fakeState(), {
		name: 'particles',
		count: 512,
		dispatchSize: null,
		workgroupSize: [ 128 ],
	} );

	assert.equal( artifact.kind, 'compute' );
	assert.equal( artifact.dispatchSize, 512 );
	assert.deepEqual( artifact.workgroupSize, [ 128, 1, 1 ] );

} );

test( 'extractComputeArtifact preserves explicit 3D dispatch size when count is null', () => {

	const artifact = extractComputeArtifact( 1, fakeState(), {
		name: 'volume',
		count: null,
		dispatchSize: [ 4, 8, 2 ],
		workgroupSize: [ 8, 4, 2 ],
	} );

	assert.deepEqual( artifact.dispatchSize, [ 4, 8, 2 ] );
	assert.deepEqual( artifact.workgroupSize, [ 8, 4, 2 ] );

} );
