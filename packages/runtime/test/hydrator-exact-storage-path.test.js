import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
	bindUserNodeAttributesToArtifact,
	bindUserStorageBuffersToArtifact,
} from '../src/hydrate/user-attributes.js';
import { inertNodeStub } from '../src/slim-node-compat.js';

function storageAttribute( values, id = undefined ) {

	return {
		...( id === undefined ? {} : { id } ),
		isBufferAttribute: true,
		isStorageBufferAttribute: true,
		array: new Float32Array( values ),
		count: 1,
		itemSize: 4,
	};

}

function signedStorageEntry( name, ordinal, count = 2 ) {

	return {
		name,
		type: 'vec4',
		storage: true,
		arrayType: 'Float32Array',
		count: 1,
		itemSize: 4,
		source: {
			kind: 'storage.buffer',
			elementType: 'vec4',
			anonymousResourceOrdinal: ordinal,
			anonymousResourceCount: count,
		},
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

test( 'a slim carrier repairs a full-Three path only when one exact-shaped identity exists', () => {

	const expected = storageAttribute( [ 1, 2, 3, 4 ] );
	const carrier = inertNodeStub( [], { attribute: expected, value: expected } );
	const material = { positionNode: inertNodeStub( [ carrier ] ) };
	const path = [ 'positionNode', 'node', 'bNode', 'attribute' ];
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
	assert.equal( attributeEntry._liveAttributeSource, 'userPath-slim-unique' );
	assert.equal( storageBufferEntry._liveAttributeSource, 'userPath-slim-unique' );

} );

test( 'a slim carrier keeps a broken full-Three path closed when live identities are ambiguous', () => {

	const first = storageAttribute( [ 1, 2, 3, 4 ] );
	const second = storageAttribute( [ 5, 6, 7, 8 ] );
	const material = {
		positionNode: inertNodeStub( [
			inertNodeStub( [], { attribute: first, value: first } ),
			inertNodeStub( [], { attribute: second, value: second } ),
		] ),
	};
	const entry = storageEntry( [ 'positionNode', 'node', 'bNode', 'attribute' ] );

	bindUserNodeAttributesToArtifact( { attributes: [ entry ], uniformPlan: [] }, material );

	assert.equal( entry._liveAttribute, undefined );

} );

test( 'signed anonymous storage families bind by construction identity across artifacts and graph order', () => {

	const vertex = storageAttribute( [ 1, 2, 3, 1 ], 7 );
	const normal = storageAttribute( [ - 0.9, 0, 0.3, 0 ], 8 );
	const normalLeaf = { isNode: true, value: normal };
	const vertexLeaf = { isNode: true, value: vertex };
	const sharedRoot = {
		isNode: true,
		first: normalLeaf,
		second: vertexLeaf,
	};
	const material = {
		// Discovery is deliberately the reverse of the signed construction rank.
		normalNode: sharedRoot,
		colorNode: {
			isNode: true,
			first: vertexLeaf,
			second: normalLeaf,
		},
		repeatedNode: sharedRoot,
	};
	const firstNormal = signedStorageEntry( 'StorageBuffer_42', 1 );
	const firstVertex = signedStorageEntry( 'StorageBuffer_43', 0 );
	const secondVertex = signedStorageEntry( 'StorageBuffer_29', 0 );
	const secondNormal = signedStorageEntry( 'StorageBuffer_30', 1 );
	const firstArtifact = {
		uniformPlan: [ {
			storageBuffers: [ firstNormal, firstVertex ],
			orderedBindings: [
				{ type: 'storage-buffer', ref: firstNormal },
				{ type: 'storage-buffer', ref: firstVertex },
			],
		} ],
	};
	const secondArtifact = {
		uniformPlan: [ {
			storageBuffers: [ secondVertex, secondNormal ],
			orderedBindings: [
				{ type: 'storage-buffer', ref: secondVertex },
				{ type: 'storage-buffer', ref: secondNormal },
			],
		} ],
	};

	bindUserStorageBuffersToArtifact( firstArtifact, material );
	bindUserStorageBuffersToArtifact( secondArtifact, material );

	assert.equal( firstVertex._liveAttribute, vertex );
	assert.equal( firstNormal._liveAttribute, normal );
	assert.equal( secondVertex._liveAttribute, vertex );
	assert.equal( secondNormal._liveAttribute, normal );
	assert.equal( firstVertex._liveAttributeSource, 'anonymous-resource-id' );
	assert.equal( firstNormal._liveAttributeSource, 'anonymous-resource-id' );

} );

test( 'an unsigned anonymous singleton remains bindable beside an unrelated exact-path resource', () => {

	const anonymousLive = storageAttribute( [ 1, 2, 3, 1 ], 7 );
	const exactLive = storageAttribute( [ 9, 8, 7, 1 ], 8 );
	const anonymousMaterial = {
		colorNode: { isNode: true, value: anonymousLive },
	};
	const exactMaterial = {
		positionNode: { isNode: true, value: exactLive },
	};
	const anonymousEntry = {
		name: 'StorageBuffer_29',
		type: 'vec4',
		storage: true,
		arrayType: 'Float32Array',
		count: 1,
		itemSize: 4,
		source: { kind: 'storage.buffer', elementType: 'vec4' },
	};
	const exactEntry = {
		...anonymousEntry,
		name: 'StorageBuffer_30',
		userPath: [ 'positionNode', 'value' ],
	};

	bindUserStorageBuffersToArtifact(
		{ uniformPlan: [ { storageBuffers: [ anonymousEntry ] } ] },
		anonymousMaterial,
	);
	bindUserStorageBuffersToArtifact(
		{ uniformPlan: [ { storageBuffers: [ exactEntry ] } ] },
		exactMaterial,
	);

	assert.equal( anonymousEntry._liveAttribute, anonymousLive );
	assert.equal( exactEntry._liveAttribute, exactLive );
	assert.equal( exactEntry._liveAttributeSource, 'userPath-exact' );

} );

test( 'signed anonymous storage families fail closed when compatible live identity is incomplete', () => {

	const onlyCandidate = storageAttribute( [ 1, 2, 3, 1 ], 7 );
	const material = {
		colorNode: {
			isNode: true,
			value: onlyCandidate,
		},
	};
	const vertex = signedStorageEntry( 'StorageBuffer_29', 0 );
	const normal = signedStorageEntry( 'StorageBuffer_30', 1 );
	const artifact = { uniformPlan: [ { storageBuffers: [ vertex, normal ] } ] };

	bindUserStorageBuffersToArtifact( artifact, material );

	assert.equal( vertex._liveAttribute, undefined );
	assert.equal( normal._liveAttribute, undefined );

} );

test( 'signed anonymous storage binding rejects partial and malformed identities', () => {

	const first = storageAttribute( [ 1, 2, 3, 1 ], 7 );
	const second = storageAttribute( [ - 0.9, 0, 0.3, 0 ], 8 );
	const material = {
		colorNode: {
			isNode: true,
			first: { isNode: true, value: first },
			second: { isNode: true, value: second },
		},
	};
	const makeMalformed = ( source ) => ( {
		name: 'StorageBuffer_29',
		type: 'vec4',
		storage: true,
		arrayType: 'Float32Array',
		count: 1,
		itemSize: 4,
		source: {
			kind: 'storage.buffer',
			elementType: 'vec4',
			...source,
		},
	} );
	const ordinalOnly = makeMalformed( { anonymousResourceOrdinal: 0 } );
	const countOnly = makeMalformed( { anonymousResourceCount: 2 } );
	const outOfRange = makeMalformed( {
		anonymousResourceOrdinal: 2,
		anonymousResourceCount: 2,
	} );

	bindUserStorageBuffersToArtifact(
		{ uniformPlan: [ { storageBuffers: [ ordinalOnly, countOnly, outOfRange ] } ] },
		material,
	);

	assert.equal( ordinalOnly._liveAttribute, undefined );
	assert.equal( countOnly._liveAttribute, undefined );
	assert.equal( outOfRange._liveAttribute, undefined );

} );
