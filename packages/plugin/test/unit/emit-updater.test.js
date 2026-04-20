import { test } from 'node:test';
import assert from 'node:assert/strict';

import { emitUpdaterSource } from '../../src/emit-updater.js';

test( 'emitUpdaterSource — empty plan → empty update body', () => {

	const { source, unsupportedKinds } = emitUpdaterSource( { uniformPlan: [] } );
	assert.match( source, /export function update\(frame, material, view, byteOffset\)/ );
	assert.deepEqual( unsupportedKinds, [] );

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

test( 'emitUpdaterSource — material.color + material.roughness', () => {

	const artifact = {
		uniformPlan: [ {
			name: 'material',
			slots: [
				{ byteOffset: 0, source: { kind: 'material.color', property: 'color' } },
				{ byteOffset: 16, source: { kind: 'material.roughness', property: 'roughness' } },
			],
		} ],
	};
	const { source } = emitUpdaterSource( artifact );
	assert.match( source, /writeColor\(view, byteOffset \+ 0, material\.color\)/ );
	assert.match( source, /writeF32\(view, byteOffset \+ 16, material\.roughness\)/ );

} );

test( 'emitUpdaterSource — unknown kind → records unsupported, emits throw', () => {

	const artifact = {
		uniformPlan: [ {
			slots: [ { byteOffset: 0, source: { kind: 'mystery.kind' } } ],
		} ],
	};
	const { source, unsupportedKinds } = emitUpdaterSource( artifact );
	assert.deepEqual( unsupportedKinds, [ 'mystery.kind' ] );
	assert.match( source, /unsupported source.kind: mystery\.kind/ );

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
