import test from 'node:test';
import assert from 'node:assert/strict';

import {
	diffArtifactShapes,
	fingerprintArtifactShape,
} from '@tsl-precompile/contract/artifact-shape';

test( 'fingerprintArtifactShape collects sorted group/slot/texture kinds', () => {

	const fingerprint = fingerprintArtifactShape( {
		artifact: {
			uniformPlan: [
				{
					name: 'object',
					slots: [
						{ name: 'worldMatrix', source: { kind: 'object.worldMatrix' } },
						{ name: 'color', source: { kind: 'material.color' } },
					],
					textures: [
						{ name: 'map', source: { kind: 'material.map' } },
					],
				},
				{
					name: 'camera',
					slots: [
						{ name: 'projectionMatrix', source: { kind: 'camera.projectionMatrix' } },
					],
				},
			],
		},
	} );

	assert.deepEqual( fingerprint, [
		'camera\tslot\tprojectionMatrix\tcamera.projectionMatrix',
		'object\tslot\tcolor\tmaterial.color',
		'object\tslot\tworldMatrix\tobject.worldMatrix',
		'object\ttexture\tmap\tmaterial.map',
	] );

} );

test( 'diffArtifactShapes reports missing and extra rows', () => {

	const expected = fingerprintArtifactShape( {
		uniformPlan: [ {
			name: 'object',
			slots: [ { name: 'a', source: { kind: 'material.color' } } ],
			textures: [ { name: 'map', source: { kind: 'material.map' } } ],
		} ],
	} );
	const actual = fingerprintArtifactShape( {
		uniformPlan: [ {
			name: 'object',
			slots: [ { name: 'a', source: { kind: 'material.color' } } ],
			textures: [ { name: 'env', source: { kind: 'material.envMap' } } ],
		} ],
	} );

	const diff = diffArtifactShapes( expected, actual );
	assert.equal( diff.ok, false );
	assert.deepEqual( diff.missing, [ 'object\ttexture\tmap\tmaterial.map' ] );
	assert.deepEqual( diff.extra, [ 'object\ttexture\tenv\tmaterial.envMap' ] );

} );

test( 'diffArtifactShapes accepts identical fingerprints', () => {

	const rows = [ 'object\tslot\ta\tmaterial.color' ];
	assert.deepEqual( diffArtifactShapes( rows, rows ), { ok: true, missing: [], extra: [] } );

} );
