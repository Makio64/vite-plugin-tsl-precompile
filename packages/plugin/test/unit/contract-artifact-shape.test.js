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

test( 'fingerprintArtifactShape includes material-compute ownership and schedule topology', () => {

	const rows = fingerprintArtifactShape( {
		uniformPlan: [],
		materialCompute: {
			version: 'material-compute@1',
			mode: 'precompiled',
			resources: [ { id: 'resource:0', kind: 'storage-buffer' } ],
			kernels: [ {
				id: 'kernel:0',
				artifact: {
					kind: 'compute',
					uniformPlan: [ {
						name: 'compute',
						slots: [ { name: 'delta', source: { kind: 'frame.deltaTime' } } ],
					} ],
				},
			} ],
			bindings: [ { kernel: 'kernel:0', resource: 'resource:0', group: 2, binding: 3 } ],
			renderBindings: [
				{ resource: 'resource:0', kind: 'attribute', attribute: 1 },
				{ resource: 'resource:0', kind: 'storage-buffer', group: 0, binding: 4 },
			],
			schedule: [ { kernel: 'kernel:0', phase: 'update-before', order: 5, updateType: 'object' } ],
		},
	} );

	assert.deepEqual( rows, [
		'[materialCompute.kernel:0]compute\tslot\tdelta\tframe.deltaTime',
		'material-compute\tcontract\tmaterial-compute@1\tprecompiled',
		'material-compute\tkernel\tkernel:0\tcompute',
		'material-compute\tkernel-binding\tkernel:0@2:3\tresource:0',
		'material-compute\trender-binding\tresource:0@0:4\tstorage-buffer',
		'material-compute\trender-binding\tresource:0@attribute:1\tattribute',
		'material-compute\tresource\tresource:0\tstorage-buffer',
		'material-compute\tschedule\t5:kernel:0\tobject',
	] );

} );
