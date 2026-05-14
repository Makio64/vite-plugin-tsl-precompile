import test from 'node:test';
import assert from 'node:assert/strict';

import { extractUniformPlan } from '../../src/vendor/extractUniformPlan.js';

function makeUniformSlot( node, value ) {

	return {
		isNumberUniform: true,
		name: 'nodeUniform0',
		offset: 0,
		itemSize: 1,
		nodeUniform: { node },
		getType() { return 'float'; },
		getValue() { return value; },
	};

}

test( 'extractUniformPlan maps object-owned UniformNode properties', () => {

	const distortionScale = {
		isUniformNode: true,
		constructor: { type: 'UniformNode' },
		nodeType: 'float',
		value: 3.7,
	};
	const state = {
		updateNodes: [],
		bindings: [ {
			name: 'object',
			bindings: [ {
				isUniformsGroup: true,
				byteLength: 16,
				visibility: 2,
				groupNode: { shared: false },
				uniforms: [ makeUniformSlot( distortionScale, distortionScale.value ) ],
			} ],
		} ],
	};

	const plan = extractUniformPlan( state, { object: { distortionScale } } );
	assert.equal( plan[ 0 ].slots[ 0 ].source.kind, 'object3d.nodeUniform' );
	assert.equal( plan[ 0 ].slots[ 0 ].source.property, 'distortionScale' );
	assert.deepEqual( plan[ 0 ].slots[ 0 ].source.valueSnapshot, { type: 'number', data: 3.7 } );

} );
