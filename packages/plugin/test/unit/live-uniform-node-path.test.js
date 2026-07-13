import test from 'node:test';
import assert from 'node:assert/strict';

import { extractArtifact } from '../../src/vendor/compileTSL.js';

function makeUniform( node, offset ) {

	return {
		isNumberUniform: true,
		name: `nodeUniform${ offset }`,
		offset,
		itemSize: 1,
		nodeUniform: { node },
		getType() { return 'float'; },
		getValue() { return node.value; },
	};

}

test( 'extractArtifact serializes exact material paths for anonymous live uniforms', () => {

	const effectorA = {
		isUniformNode: true,
		constructor: { type: 'UniformNode' },
		nodeType: 'float',
		value: - 0.2,
	};
	const effectorB = {
		isUniformNode: true,
		constructor: { type: 'UniformNode' },
		nodeType: 'float',
		value: - 0.2,
	};
	const state = {
		vertexShader: 'vertex',
		fragmentShader: 'fragment',
		computeShader: '',
		nodeAttributes: [],
		updateNodes: [],
		updateBeforeNodes: [],
		updateAfterNodes: [],
		bindings: [ {
			name: 'object',
			bindings: [ {
				name: 'object',
				isUniformBuffer: true,
				isUniformsGroup: true,
				byteLength: 16,
				visibility: 3,
				groupNode: { shared: false },
				uniforms: [
					makeUniform( effectorA, 0 ),
					makeUniform( effectorB, 1 ),
					makeUniform( effectorA, 2 ),
					makeUniform( effectorB, 3 ),
				],
			} ],
		} ],
	};
	const material = {
		isMeshStandardNodeMaterial: true,
		positionNode: {
			isNode: true,
			branchB: { isNode: true, effector: effectorB },
			branchA: { isNode: true, effector: effectorA },
		},
	};

	const artifact = extractArtifact( 7, state, material );
	const slots = artifact.uniformPlan[ 0 ].slots;
	assert.deepEqual( slots[ 0 ].source.nodePath, [ 'positionNode', 'branchA', 'effector' ] );
	assert.deepEqual( slots[ 1 ].source.nodePath, [ 'positionNode', 'branchB', 'effector' ] );
	assert.deepEqual( slots[ 2 ].source.nodePath, [ 'positionNode', 'branchA', 'effector' ] );
	assert.deepEqual( slots[ 3 ].source.nodePath, [ 'positionNode', 'branchB', 'effector' ] );
	assert.deepEqual( slots.map( ( slot ) => slot.source.liveNodeId ), [ 0, 1, 0, 1 ] );
	assert.equal( slots[ 0 ].source.kind, 'uniform.live' );
	assert.deepEqual( slots[ 0 ].source.valueSnapshot, { type: 'number', data: - 0.2 } );
	assert.equal( JSON.parse( JSON.stringify( artifact ) ).uniformPlan[ 0 ].slots[ 0 ].source.nodePath[ 0 ], 'positionNode' );

} );
