import test from 'node:test';
import assert from 'node:assert/strict';

import {
	BLOCKED_KINDS,
	KINDS,
	blockedKindReason,
	isBlockedKind,
	isArtifactCollection,
	isKnownKind,
	validateArtifact,
} from '@tsl-precompile/contract/kinds';

test( 'contract kind registry recognises codegen and runtime texture kinds', () => {

	assert.ok( isKnownKind( 'camera.projectionMatrix' ) );
	assert.ok( isKnownKind( 'light.shadowMatrix' ) );
	assert.ok( isKnownKind( 'material.color' ) );
	assert.ok( isKnownKind( 'material.map' ) );
	assert.ok( isKnownKind( 'material.map.matrix' ) );
	assert.ok( isKnownKind( 'builtin.dfgLUT' ) );
	assert.ok( isBlockedKind( 'builtin.dfgLUT' ) );
	assert.match( blockedKindReason( 'builtin.dfgLUT' ), /DFG LUT/ );
	assert.equal( isKnownKind( 'totally.new.kind' ), false );

} );

test( 'contract blocked kinds are all registered with metadata', () => {

	for ( const [ kind, reason ] of Object.entries( BLOCKED_KINDS ) ) {

		assert.ok( KINDS[ kind ], `${ kind } missing from KINDS` );
		assert.equal( KINDS[ kind ].reason, reason );

	}

} );

test( 'contract artifact validation rejects unknown source kinds', () => {

	const result = validateArtifact( {
		artifact: {
			vertexShader: 'v',
			fragmentShader: 'f',
			uniformPlan: [ {
				name: 'object',
				slots: [ { source: { kind: 'mystery.kind' } } ],
				textures: [ { source: { kind: 'material.map' } } ],
			} ],
		},
	}, { label: 'fixture' } );

	assert.equal( result.ok, false );
	assert.deepEqual( result.sourceKinds, [ 'material.map', 'mystery.kind' ] );
	assert.equal( result.errors[ 0 ].code, 'source.kind.unknown' );
	assert.match( result.errors[ 0 ].message, /mystery\.kind/ );

} );

test( 'contract artifact validation accepts known slot and texture kinds', () => {

	const result = validateArtifact( {
		vertexShader: 'v',
		fragmentShader: 'f',
		uniformPlan: [ {
			name: 'object',
			slots: [
				{ source: { kind: 'camera.viewMatrix' } },
				{ source: { kind: 'material.map.matrix' } },
			],
			textures: [
				{ source: { kind: 'material.map' } },
				{ source: { kind: 'artifact.texture' } },
			],
		} ],
	}, { label: 'fixture' } );

	assert.equal( result.ok, true );
	assert.deepEqual( result.errors, [] );

} );

test( 'contract artifact validation accepts aggregate artifact dumps', () => {

	const collection = {
		first: {
			__hash: 'sha256:first',
			name: 'first',
			artifact: {
				vertexShader: 'v',
				fragmentShader: 'f',
				uniformPlan: [ {
					name: 'object',
					slots: [ { source: { kind: 'camera.viewMatrix' } } ],
				} ],
			},
		},
		second: {
			__hash: 'sha256:second',
			name: 'second',
			artifact: {
				vertexShader: 'v',
				fragmentShader: 'f',
				uniformPlan: [ {
					name: 'material',
					textures: [ { source: { kind: 'material.normalMap' } } ],
				} ],
			},
		},
	};
	const result = validateArtifact( collection, { label: 'aggregate' } );

	assert.equal( isArtifactCollection( collection ), true );
	assert.equal( result.ok, true );
	assert.deepEqual( result.sourceKinds, [ 'camera.viewMatrix', 'material.normalMap' ] );

} );

test( 'contract artifact validation can accept empty aggregate dumps explicitly', () => {

	assert.equal( isArtifactCollection( [], { allowEmpty: true } ), true );
	const result = validateArtifact( [], { label: 'empty-aggregate', allowEmptyCollection: true } );

	assert.equal( result.ok, true );
	assert.deepEqual( result.sourceKinds, [] );

} );
