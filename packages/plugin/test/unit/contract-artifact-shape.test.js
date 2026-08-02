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

test( 'fingerprintArtifactShape detects GPU binding and byte-layout drift without hashing snapshots or WGSL text', () => {

	const makeArtifact = ( {
		offset = 0,
		comparison = false,
		bindingOrder = [ 'ubo', 'sampler' ],
		fragmentShader = 'fragment-a',
	} = {} ) => ( {
		vertexShader: 'vertex-a',
		fragmentShader,
		attributes: [ { name: 'position', type: 'vec3', source: 'geometry' } ],
		bindings: [ {
			name: 'object',
			bindings: [
				{ name: 'object', kind: 'uniform-buffer', visibility: 3, byteLength: 16 },
				{ name: 'shadowSampler', kind: 'sampler', visibility: 2, comparison },
			],
		} ],
		uniformPlan: [ {
			name: 'object',
			shared: false,
			visibility: 3,
			byteLength: 16,
			slots: [ {
				name: 'opacity',
				offset,
				size: 4,
				dtype: 'number',
				source: {
					kind: 'material.opacity',
					valueSnapshot: { type: 'number', data: 0.5 },
				},
			} ],
			textures: [ {
				bindingKind: 'sampler',
				name: 'shadowSampler',
				visibility: 2,
				comparison,
				source: { kind: 'artifact.texture', snapshot: { width: 1, height: 1 } },
			} ],
			orderedBindings: bindingOrder.map( ( type ) => ( {
				type,
				name: type === 'ubo' ? 'object' : 'shadowSampler',
				visibility: type === 'ubo' ? 3 : 2,
				comparison: type === 'sampler' ? comparison : undefined,
			} ) ),
		} ],
	} );

	const baseline = fingerprintArtifactShape( makeArtifact() );
	assert.equal( diffArtifactShapes( baseline, fingerprintArtifactShape( makeArtifact( {
		fragmentShader: 'different WGSL text',
	} ) ) ).ok, true, 'shader text remains deliberately excluded' );

	for ( const changed of [
		makeArtifact( { offset: 4 } ),
		makeArtifact( { comparison: true } ),
		makeArtifact( { bindingOrder: [ 'sampler', 'ubo' ] } ),
	] ) {

		assert.equal( diffArtifactShapes( baseline, fingerprintArtifactShape( changed ) ).ok, false );

	}

	const snapshotOnly = makeArtifact();
	snapshotOnly.uniformPlan[ 0 ].slots[ 0 ].source.valueSnapshot.data = 1;
	snapshotOnly.uniformPlan[ 0 ].textures[ 0 ].source.snapshot.width = 64;
	assert.equal(
		diffArtifactShapes( baseline, fingerprintArtifactShape( snapshotOnly ) ).ok,
		true,
		'numeric and texture snapshots remain deliberately excluded',
	);

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
				nodePath: [ 'positionNode', 'compute' ],
				updates: [ { phase: 'update', order: 0, nodePath: [ 'positionNode', 'time' ], updateType: 'frame' } ],
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
		'material-compute\tkernel-path\tkernel:0\t["positionNode","compute"]',
		'material-compute\tkernel-update\tkernel:0:update:0:["positionNode","time"]\tframe',
		'material-compute\trender-binding\tresource:0@0:4\tstorage-buffer',
		'material-compute\trender-binding\tresource:0@attribute:1\tattribute',
		'material-compute\tresource\tresource:0\tstorage-buffer',
		'material-compute\tschedule\t5:kernel:0\tobject',
	] );

} );

test( 'fingerprintArtifactShape includes variant-local layouts', () => {

	const makeFamily = ( offset ) => ( {
		uniformPlan: [],
		variants: {
			opaque: {
				uniformPlan: [ {
					name: 'material',
					slots: [ {
						name: 'opacity',
						offset,
						size: 4,
						dtype: 'number',
						source: { kind: 'material.opacity' },
					} ],
				} ],
			},
		},
	} );

	const expected = fingerprintArtifactShape( makeFamily( 0 ) );
	const actual = fingerprintArtifactShape( makeFamily( 64 ) );
	assert.equal( diffArtifactShapes( expected, actual ).ok, false );
	assert.match( diffArtifactShapes( expected, actual ).missing[ 0 ], /^\[variant:"opaque"\]/ );

} );

test( 'fingerprintArtifactShape includes compute public mappings and internal-pass schedules', () => {

	const makeArtifact = ( binding, stage = 'horizontal' ) => ( {
		kind: 'compute',
		uniformPlan: [],
		computeBindings: {
			version: 'compute-bindings@1',
			entries: [ {
				key: 'particles',
				target: 'storage-buffer',
				group: 0,
				binding,
				access: 'read-write',
				arrayType: 'Float32Array',
				count: 4,
				itemSize: 4,
				byteLength: 64,
			} ],
		},
		internalPass: {
			schema: 'internal-pass@1',
			family: 'shadow-vsm',
			stage,
			shape: `shadow-vsm-${ stage }`,
			uniforms: [],
			inputs: [],
			output: { topology: { kind: 'texture', dimension: '2d' } },
			config: { order: 1 },
		},
	} );

	const expected = fingerprintArtifactShape( makeArtifact( 0 ) );
	assert.equal( diffArtifactShapes( expected, fingerprintArtifactShape( makeArtifact( 1 ) ) ).ok, false );
	assert.equal( diffArtifactShapes( expected, fingerprintArtifactShape( makeArtifact( 0, 'vertical' ) ) ).ok, false );

} );

test( 'diffArtifactShapes compares row multiplicity', () => {

	assert.deepEqual(
		diffArtifactShapes( [ 'same', 'same' ], [ 'same' ] ),
		{ ok: false, missing: [ 'same' ], extra: [] },
	);
	assert.deepEqual(
		diffArtifactShapes( [ 'same' ], [ 'same', 'same' ] ),
		{ ok: false, missing: [], extra: [ 'same' ] },
	);

} );
