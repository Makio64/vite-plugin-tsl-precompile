import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	bindUserNodeAttributesToArtifact,
	bindUserStorageBuffersToArtifact,
} from '../src/hydrate/user-attributes.js';

function storageAttribute( values ) {

	return {
		isBufferAttribute: true,
		isStorageBufferAttribute: true,
		array: new Float32Array( values ),
		count: 1,
		itemSize: 4,
	};

}

function storageEntry( userPath ) {

	return {
		name: 'positions',
		type: 'vec4',
		source: 'node',
		storage: true,
		arrayType: 'Float32Array',
		count: 1,
		itemSize: 4,
		userPath,
	};

}

test( 'exact storage userPath selects the intended same-shaped leaf without a DFS fallback', () => {

	const wrong = storageAttribute( [ 9, 9, 9, 9 ] );
	const expected = storageAttribute( [ 1, 2, 3, 4 ] );
	const material = {
		positionNode: {
			isNode: true,
			first: { isNode: true, value: wrong },
			second: { isNode: true, value: expected },
		},
	};
	const path = [ 'positionNode', 'second', 'value' ];
	const attributeEntry = storageEntry( path );
	const storageBufferEntry = storageEntry( path );
	const artifact = {
		attributes: [ attributeEntry ],
		uniformPlan: [ {
			storageBuffers: [ storageBufferEntry ],
			orderedBindings: [ { type: 'storage-buffer', ref: storageBufferEntry } ],
		} ],
	};

	bindUserNodeAttributesToArtifact( artifact, material );
	bindUserStorageBuffersToArtifact( artifact, material );

	assert.equal( attributeEntry._liveAttribute, expected );
	assert.equal( storageBufferEntry._liveAttribute, expected );
	assert.equal( attributeEntry._liveAttributeSource, 'userPath-exact' );
	assert.equal( storageBufferEntry._liveAttributeSource, 'userPath-exact' );

} );

test( 'a broken exact storage path fails closed instead of taking a same-shaped sibling', () => {

	const wrong = storageAttribute( [ 9, 9, 9, 9 ] );
	const material = {
		positionNode: {
			isNode: true,
			first: { isNode: true, value: wrong },
		},
		__tslpPrecompileObject: {
			isInstancedMesh: true,
			count: 1,
			instanceColor: wrong,
		},
	};
	const entry = storageEntry( [ 'positionNode', 'missing', 'value' ] );
	const artifact = { attributes: [ entry ], uniformPlan: [] };

	bindUserNodeAttributesToArtifact( artifact, material );

	assert.equal( entry._liveAttribute, undefined );

} );
