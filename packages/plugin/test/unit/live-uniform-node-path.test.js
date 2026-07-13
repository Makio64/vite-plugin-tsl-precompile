import test from 'node:test';
import assert from 'node:assert/strict';

import { extractArtifact } from '../../src/vendor/compileTSL.js';
import { RENDER_BINDING_OWNER_KINDS } from '@tsl-precompile/contract/render-selector';

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

test( 'extractArtifact proves shadow live-uniform paths against every exact caster owner', () => {

	const captured = {
		isUniformNode: true,
		constructor: { type: 'UniformNode' },
		nodeType: 'float',
		value: 2,
	};
	const equivalent = {
		isUniformNode: true,
		constructor: { type: 'UniformNode' },
		nodeType: 'float',
		value: 7,
	};
	const state = {
		vertexShader: 'vertex', fragmentShader: 'fragment', computeShader: '',
		nodeAttributes: [], updateNodes: [], updateBeforeNodes: [], updateAfterNodes: [],
		bindings: [ {
			name: 'object',
			bindings: [ {
				name: 'object', isUniformBuffer: true, isUniformsGroup: true,
				byteLength: 16, visibility: 3, groupNode: { shared: false },
				uniforms: [ makeUniform( captured, 0 ) ],
			} ],
		} ],
	};
	const override = {
		isShadowPassMaterial: true,
		positionNode: { isNode: true, overrideUniform: captured },
	};
	const casterA = {
		castShadowNode: { isNode: true, branch: { isNode: true, effector: captured } },
	};
	const casterB = {
		castShadowNode: { isNode: true, branch: { isNode: true, effector: equivalent } },
	};
	const context = {
		bindingOwnerKind: RENDER_BINDING_OWNER_KINDS.SHADOW_CASTER,
		materialBindingOwners: new Set( [ casterA, casterB ] ),
	};
	const artifact = extractArtifact( 9, state, override, null, context );
	assert.deepEqual( artifact.uniformPlan[ 0 ].slots[ 0 ].source.nodePath, [ 'castShadowNode', 'branch', 'effector' ] );

	const inconsistent = {
		positionNode: { isNode: true, branch: { isNode: true, effector: equivalent } },
	};
	const withoutProof = extractArtifact( 10, state, override, null, {
		...context,
		materialBindingOwners: new Set( [ casterA, inconsistent ] ),
	} );
	assert.equal( withoutProof.uniformPlan[ 0 ].slots[ 0 ].source.nodePath, undefined );

} );

test( 'extractArtifact records caster-relative attribute and storage roots only with shared owner proof', () => {

	const attribute = {
		isBufferAttribute: true,
		isStorageBufferAttribute: true,
		array: new Float32Array( [ 1, 2, 3 ] ),
		count: 1,
		itemSize: 3,
	};
	const equivalent = {
		isBufferAttribute: true,
		isStorageBufferAttribute: true,
		array: new Float32Array( [ 4, 5, 6 ] ),
		count: 1,
		itemSize: 3,
	};
	const carrier = ( value ) => ( {
		isNode: true,
		attribute: value,
		traverse( visit ) { visit( this ); },
	} );
	const state = {
		vertexShader: 'vertex', fragmentShader: 'fragment', computeShader: '',
		nodeAttributes: [ { name: 'graphPosition', type: 'vec3', node: { attribute } } ],
		updateNodes: [], updateBeforeNodes: [], updateAfterNodes: [],
		bindings: [ {
			name: 'object',
			bindings: [ {
				name: 'graphStorage', isStorageBuffer: true,
				visibility: 1, access: 'read_write', attribute,
			} ],
		} ],
	};
	const override = { isShadowPassMaterial: true, colorNode: carrier( attribute ) };
	const casterA = { positionNode: carrier( attribute ) };
	const casterB = { positionNode: carrier( equivalent ) };
	const context = {
		bindingOwnerKind: RENDER_BINDING_OWNER_KINDS.SHADOW_CASTER,
		materialBindingOwners: new Set( [ casterA, casterB ] ),
	};
	const artifact = extractArtifact( 11, state, override, null, context );
	assert.deepEqual( artifact.attributes[ 0 ].userPath, [ 'positionNode' ] );
	assert.deepEqual( artifact.uniformPlan[ 0 ].storageBuffers[ 0 ].userPath, [ 'positionNode' ] );

	const inconsistent = { colorNode: carrier( equivalent ) };
	const withoutProof = extractArtifact( 12, state, override, null, {
		...context,
		materialBindingOwners: new Set( [ casterA, inconsistent ] ),
	} );
	assert.equal( withoutProof.attributes[ 0 ].userPath, undefined );
	assert.equal( withoutProof.uniformPlan[ 0 ].storageBuffers[ 0 ].userPath, undefined );
	assert.deepEqual( withoutProof.attributes[ 0 ].arraySnapshot, [ 1, 2, 3 ] );

} );
