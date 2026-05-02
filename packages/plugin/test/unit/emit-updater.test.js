import { test } from 'node:test';
import assert from 'node:assert/strict';

import { emitUpdaterSource } from '../../src/emit-updater.js';

test( 'emitUpdaterSource — empty plan → empty update body', () => {

	const { source, unsupportedKinds } = emitUpdaterSource( { uniformPlan: [] } );
	assert.match( source, /export function update\(frame, material, view, byteOffset\)/ );
	assert.match( source, /export function updateGroup\(frame, material, view, byteOffset, groupName\)/ );
	assert.deepEqual( unsupportedKinds, [] );

} );

test( 'emitUpdaterSource — updateGroup gates writes by bind-group name', () => {

	const artifact = {
		uniformPlan: [
			{ name: 'render', slots: [ { byteOffset: 0, source: { kind: 'frame.time' } } ] },
			{ name: 'object', slots: [ { byteOffset: 0, source: { kind: 'material.opacity', property: 'opacity' } } ] },
		],
	};
	const { source, unsupportedKinds } = emitUpdaterSource( artifact );
	assert.deepEqual( unsupportedKinds, [] );
	assert.match( source, /groupName === "render"/ );
	assert.match( source, /groupName === "object"/ );
	assert.match( source, /updateGroup\(frame, material, view, byteOffset, null\)/ );

} );

test( 'emitUpdaterSource — camera matrices', () => {

	const artifact = {
		uniformPlan: [ {
			name: 'scene',
			slots: [
				{ byteOffset: 0, source: { kind: 'camera.projectionMatrix' } },
				{ byteOffset: 64, source: { kind: 'camera.viewMatrix' } },
			],
		} ],
	};
	const { source, unsupportedKinds } = emitUpdaterSource( artifact );
	assert.match( source, /writeMat4\(view, byteOffset \+ 0, frame\.camera\.projectionMatrix\)/ );
	assert.match( source, /writeMat4\(view, byteOffset \+ 64, frame\.camera\.matrixWorldInverse\)/ );
	assert.match( source, /import \{ writeMat4 \}/ );
	assert.deepEqual( unsupportedKinds, [] );

} );

test( 'emitUpdaterSource — material.color + material scalar slots', () => {

	const artifact = {
		uniformPlan: [ {
			name: 'material',
			slots: [
				{ byteOffset: 0, source: { kind: 'material.color', property: 'color' } },
				{ byteOffset: 16, source: { kind: 'material.roughness', property: 'roughness' } },
				{ byteOffset: 20, source: { kind: 'material.alphaTest', property: 'alphaTest' } },
				{ byteOffset: 24, source: { kind: 'material.aoMapIntensity', property: 'aoMapIntensity' } },
			],
		} ],
	};
	const { source } = emitUpdaterSource( artifact );
	assert.match( source, /writeColor\(view, byteOffset \+ 0, material\.color\)/ );
	assert.match( source, /writeF32\(view, byteOffset \+ 16, material\.roughness\)/ );
	assert.match( source, /writeF32\(view, byteOffset \+ 20, material\.alphaTest\)/ );
	assert.match( source, /writeF32\(view, byteOffset \+ 24, material\.aoMapIntensity\)/ );

} );

test( 'emitUpdaterSource — material texture matrix slots read material.<map>.matrix', () => {

	const artifact = {
		uniformPlan: [ {
			name: 'object',
			slots: [
				{ byteOffset: 16, dtype: 'mat3', source: { kind: 'material.map.matrix', property: 'map' } },
			],
		} ],
	};
	const { source, unsupportedKinds } = emitUpdaterSource( artifact );
	assert.deepEqual( unsupportedKinds, [] );
	assert.match( source, /writeMat3\(view, byteOffset \+ 16, material\.map && material\.map\.matrix\)/ );

} );

test( 'emitUpdaterSource — material.normalScale writes vec2', () => {

	const artifact = {
		uniformPlan: [ {
			name: 'object',
			slots: [
				{ byteOffset: 32, dtype: 'vec2', source: { kind: 'material.normalScale', property: 'normalScale' } },
			],
		} ],
	};
	const { source, unsupportedKinds } = emitUpdaterSource( artifact );
	assert.deepEqual( unsupportedKinds, [] );
	assert.match( source, /writeVec2\(view, byteOffset \+ 32, material\.normalScale\)/ );

} );

test( 'emitUpdaterSource — renderer.halfHeight writes half logical renderer height', () => {

	const artifact = {
		uniformPlan: [ {
			name: 'object',
			slots: [
				{ byteOffset: 88, dtype: 'number', source: { kind: 'renderer.halfHeight' } },
			],
		} ],
	};
	const { source, unsupportedKinds } = emitUpdaterSource( artifact );
	assert.deepEqual( unsupportedKinds, [] );
	assert.match( source, /frame\.renderer\.getSize\(_rSize\)/ );
	assert.match( source, /writeF32\(view, byteOffset \+ 88, 0\.5 \* _rSize\.y\)/ );

} );

test( 'emitUpdaterSource — unknown kind → records unsupported, emits throw', () => {

	const artifact = {
		uniformPlan: [ {
			slots: [ { byteOffset: 0, source: { kind: 'mystery.kind' } } ],
		} ],
	};
	const { source, unsupportedKinds } = emitUpdaterSource( artifact );
	assert.equal( unsupportedKinds.length, 1 );
	assert.equal( unsupportedKinds[ 0 ].kind, 'mystery.kind' );
	assert.equal( unsupportedKinds[ 0 ].severity, 'unknown' );
	assert.equal( unsupportedKinds[ 0 ].byteOffset, 0 );
	assert.match( source, /unsupported source.kind: mystery\.kind/ );

} );

test( 'emitUpdaterSource — documented-blocked kind → severity=blocked, emits throw', () => {

	const artifact = {
		uniformPlan: [ {
			slots: [ { byteOffset: 32, source: { kind: 'builtin.dfgLUT' } } ],
		} ],
	};
	const { unsupportedKinds } = emitUpdaterSource( artifact );
	assert.equal( unsupportedKinds.length, 1 );
	assert.equal( unsupportedKinds[ 0 ].kind, 'builtin.dfgLUT' );
	assert.equal( unsupportedKinds[ 0 ].severity, 'blocked' );
	assert.equal( unsupportedKinds[ 0 ].byteOffset, 32 );
	assert.match( unsupportedKinds[ 0 ].reason, /DFG LUT/ );

} );

test( 'emitUpdaterSource — extractor dialect (frame.time, constant with valueSnapshot, camera.projectionMatrixInverse)', () => {

	const artifact = {
		uniformPlan: [ {
			slots: [
				// The extractor emits `offset` (byte-offset), not `byteOffset`.
				{ offset: 0, source: { kind: 'frame.time' } },
				{ offset: 16, source: { kind: 'camera.projectionMatrixInverse' } },
				{ offset: 80, source: { kind: 'constant', valueSnapshot: { type: 'vec3', data: [ 0.1, 0.2, 0.3 ] } } },
			],
		} ],
	};
	const { source, unsupportedKinds } = emitUpdaterSource( artifact );
	assert.deepEqual( unsupportedKinds, [] );
	assert.match( source, /writeF32\(view, byteOffset \+ 0, frame\.time\);/ );
	assert.match( source, /writeMat4\(view, byteOffset \+ 16, frame\.camera\.projectionMatrixInverse\);/ );
	assert.match( source, /writeVec3\(view, byteOffset \+ 80, __const0\);/ );
	assert.match( source, /const __const0 = \{ x: 0\.1, y: 0\.2, z: 0\.3 \};/ );

} );

test( 'emitUpdaterSource — uniform.live with valueSnapshot falls back to frozen snapshot, severity=blocked', () => {

	const artifact = {
		uniformPlan: [ {
			slots: [
				{ offset: 0, source: { kind: 'uniform.live', name: 'shadowMatrix', valueSnapshot: { type: 'mat4', data: new Array( 16 ).fill( 0 ).map( ( _, i ) => i ) } } },
			],
		} ],
	};
	const { source, unsupportedKinds } = emitUpdaterSource( artifact );
	assert.equal( unsupportedKinds.length, 1 );
	assert.equal( unsupportedKinds[ 0 ].kind, 'uniform.live' );
	assert.equal( unsupportedKinds[ 0 ].severity, 'blocked' );
	assert.match( source, /writeMat4\(view, byteOffset \+ 0, __const0\);/ );

} );

test( 'emitUpdaterSource — scene.fog.* + object3d.position', () => {

	const artifact = {
		uniformPlan: [ {
			slots: [
				{ offset: 0, source: { kind: 'scene.fog.color', property: 'color' } },
				{ offset: 16, source: { kind: 'scene.fog.near', property: 'near' } },
				{ offset: 32, source: { kind: 'object3d.position' } },
			],
		} ],
	};
	const { source, unsupportedKinds } = emitUpdaterSource( artifact );
	assert.deepEqual( unsupportedKinds, [] );
	assert.match( source, /writeColor\(view, byteOffset \+ 0, frame\.scene\.fog\.color\);/ );
	assert.match( source, /writeF32\(view, byteOffset \+ 16, frame\.scene\.fog\.near\);/ );
	assert.match( source, /writeVec3\(view, byteOffset \+ 32, frame\.object\.position\);/ );

} );

test( 'emitUpdaterSource — object.scale and attenuationDistance', () => {

	const artifact = {
		uniformPlan: [ {
			slots: [
				{ offset: 0, source: { kind: 'object.scale' } },
				{ offset: 16, source: { kind: 'material.attenuationDistance', property: 'attenuationDistance' } },
			],
		} ],
	};
	const { source, unsupportedKinds } = emitUpdaterSource( artifact );
	assert.deepEqual( unsupportedKinds, [] );
	assert.match( source, /writeVec3\(view, byteOffset \+ 0, frame\.object\.scale\);/ );
	assert.match( source, /writeF32\(view, byteOffset \+ 16, material\.attenuationDistance\);/ );

} );

test( 'emitUpdaterSource — object3d.userData float reads frame.object.userData[property]', () => {

	const artifact = {
		uniformPlan: [ {
			name: 'object',
			slots: [
				{ byteOffset: 0, source: { kind: 'object3d.userData', property: 'rotation', uniformType: 'float' } },
			],
		} ],
	};
	const { source, unsupportedKinds } = emitUpdaterSource( artifact );
	assert.deepEqual( unsupportedKinds, [] );
	assert.match( source, /writeF32\(view, byteOffset \+ 0, frame\.object && frame\.object\.userData != null \? frame\.object\.userData\["rotation"\] : undefined\)/ );
	assert.match( source, /import \{ writeF32 \}/ );

} );

test( 'emitUpdaterSource — object3d.userData missing property emits blocked unsupportedKind', () => {

	const artifact = {
		uniformPlan: [ {
			name: 'object',
			slots: [
				{ byteOffset: 0, source: { kind: 'object3d.userData' } },
			],
		} ],
	};
	const { unsupportedKinds } = emitUpdaterSource( artifact );
	assert.equal( unsupportedKinds.length, 1 );
	assert.equal( unsupportedKinds[ 0 ].kind, 'object3d.userData' );
	assert.equal( unsupportedKinds[ 0 ].severity, 'blocked' );

} );

test( 'emitUpdaterSource — inlined constants', () => {

	const artifact = {
		uniformPlan: [ {
			slots: [
				{ byteOffset: 0, source: { kind: 'uniform.constant', valueType: 'f32', value: 1.5 } },
				{ byteOffset: 16, source: { kind: 'uniform.constant', valueType: 'vec3', value: [ 0.1, 0.2, 0.3 ] } },
			],
		} ],
	};
	const { source } = emitUpdaterSource( artifact );
	assert.match( source, /const __const0 = 1\.5;/ );
	assert.match( source, /const __const1 = \{ x: 0\.1, y: 0\.2, z: 0\.3 \};/ );
	assert.match( source, /writeF32\(view, byteOffset \+ 0, __const0\);/ );
	assert.match( source, /writeVec3\(view, byteOffset \+ 16, __const1\);/ );

} );
