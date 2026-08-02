import test from 'node:test';
import assert from 'node:assert/strict';

import { createArtifactVariantPayload } from '@tsl-precompile/contract/artifact-variants';
import { validateArtifact } from '@tsl-precompile/contract/kinds';
import { extractComputeArtifact } from '../../src/vendor/compileTSL.js';

function transformFeedbackState() {

	const attribute = {
		isBufferAttribute: true,
		isStorageBufferAttribute: true,
		array: new Float32Array( [ 1, 2, 3, 4, 5, 6, 7, 8 ] ),
		count: 2,
		itemSize: 4,
		usage: 35048,
	};
	const attributeNode = {
		isNode: true,
		isBufferNode: true,
		attribute,
		value: attribute,
	};
	const nodeAttribute = {
		isNodeAttribute: true,
		name: 'nodeAttribute0',
		type: 'vec4',
		node: attributeNode,
	};
	return {
		attribute,
		attributeNode,
		state: {
			computeShader: '#version 300 es\nvoid main() {}',
			vertexShader: '',
			fragmentShader: '',
			nodeAttributes: [ nodeAttribute ],
			transforms: [ { varyingName: 'nodeVarying0', attributeNode } ],
			bindings: [],
			updateNodes: [],
			updateBeforeNodes: [],
			updateAfterNodes: [],
		},
	};

}

function computeNode() {

	return {
		isNode: true,
		isComputeNode: true,
		name: 'transform-feedback',
		count: 2,
		workgroupSize: [ 1 ],
	};

}

test( 'extractComputeArtifact serializes WebGL2 transforms by exact node-attribute identity', () => {

	const fixture = transformFeedbackState();
	const artifact = extractComputeArtifact( 7, fixture.state, computeNode() );

	assert.deepEqual( artifact.transforms, [ { varyingName: 'nodeVarying0', attribute: 0 } ] );
	assert.equal( artifact.attributes.length, 1 );
	assert.equal( artifact.attributes[ 0 ].source, 'node' );
	assert.equal( artifact.attributes[ 0 ].storage, true );
	assert.equal( artifact.attributes[ 0 ]._liveAttribute, fixture.attribute );
	assert.equal( fixture.state.nodeAttributes[ 0 ].node, fixture.attributeNode, 'capture state identity remains untouched' );
	assert.equal( fixture.state.transforms[ 0 ].attributeNode, fixture.attributeNode, 'raw transform identity remains untouched' );

	const serialized = JSON.parse( JSON.stringify( artifact ) );
	assert.deepEqual( serialized.transforms, artifact.transforms );
	assert.equal( serialized.attributes[ 0 ]._liveAttribute, undefined );
	assert.equal( serialized.attributes[ 0 ].node, undefined );
	assert.deepEqual( createArtifactVariantPayload( artifact ).transforms, artifact.transforms );
	assert.equal( validateArtifact( serialized ).ok, true );

} );

test( 'extractComputeArtifact fails closed when a transform lacks one exact node-attribute owner', () => {

	const fixture = transformFeedbackState();
	fixture.state.transforms[ 0 ].attributeNode = {
		...fixture.attributeNode,
		attribute: fixture.attribute,
	};

	assert.throws(
		() => extractComputeArtifact( 8, fixture.state, computeNode() ),
		( error ) => {

			assert.equal( error.code, 'TSLP_COMPUTE_TRANSFORM_ATTRIBUTE_UNMAPPED' );
			assert.match( error.message, /exact state\.nodeAttributes\[\]\.node identity/ );
			assert.match( error.message, /no public-resource identity is inferred/ );
			return true;

		},
	);

} );
