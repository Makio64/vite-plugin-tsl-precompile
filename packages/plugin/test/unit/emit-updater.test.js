import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '@babel/parser';

import { emitUpdaterSource } from '../../src/emit-updater.js';
import { linkGeneratedLightIdentitySource, writeGeneratedLightValue } from '../../../runtime/src/generated/light-writer.js';

function executeLightOnlyUpdater( source ) {

	const executable = source
		.replace( /^import .*generated\/light-writer.*;\n?/gm, '' )
		.replace( /export /g, '' );
	return Function( '_tslpLinkLightIdentitySource', '_tslpWriteLightValue', `${ executable }\nreturn { update, updateGroup };` )(
		linkGeneratedLightIdentitySource,
		writeGeneratedLightValue,
	);

}

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

test( 'emitUpdaterSource — renderer.size follows active render target size', () => {

	const artifact = {
		uniformPlan: [ {
			name: 'object',
			slots: [
				{ byteOffset: 32, dtype: 'vec2', source: { kind: 'renderer.size' } },
			],
		} ],
	};
	const { source, unsupportedKinds } = emitUpdaterSource( artifact );
	assert.deepEqual( unsupportedKinds, [] );
	assert.match( source, /function _tslpRendererScreenSize\(frame\)/ );
	assert.match( source, /renderTarget\.width/ );
	assert.match( source, /renderer\.getDrawingBufferSize\(_rSize\)/ );
	assert.match( source, /writeVec2\(view, byteOffset \+ 32, _tslpRendererScreenSize\(frame\)\)/ );

} );

test( 'emitUpdaterSource — renderer.viewport follows active render target viewport', () => {

	const artifact = {
		uniformPlan: [ {
			name: 'object',
			slots: [
				{ byteOffset: 48, dtype: 'vec4', source: { kind: 'renderer.viewport' } },
			],
		} ],
	};
	const { source, unsupportedKinds } = emitUpdaterSource( artifact );
	assert.deepEqual( unsupportedKinds, [] );
	assert.match( source, /function _tslpRendererViewport\(frame\)/ );
	assert.match( source, /renderTarget !== null && renderTarget\.viewport/ );
	assert.match( source, /_rViewport\.multiplyScalar\(renderer\.getPixelRatio\(\)\)/ );
	assert.match( source, /writeVec4\(view, byteOffset \+ 48, _tslpRendererViewport\(frame\)\)/ );

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
	// Wedge 4: frame.time writer honours globalThis.__tslpPinnedClock for
	// PSNR-snapshot replay, falling back to frame.time otherwise.
	assert.match( source, /writeF32\(view, byteOffset \+ 0, \(typeof globalThis\.__tslpPinnedClock === 'number' && Number\.isFinite\(globalThis\.__tslpPinnedClock\) \? globalThis\.__tslpPinnedClock : frame\.time\)\);/ );
	assert.match( source, /writeMat4\(view, byteOffset \+ 16, frame\.camera\.projectionMatrixInverse\);/ );
	assert.match( source, /writeVec3\(view, byteOffset \+ 80, __const0\);/ );
	assert.match( source, /const __const0 = \{ x: 0\.1, y: 0\.2, z: 0\.3 \};/ );

} );

test( 'emitUpdaterSource — temporal frame scope drives frameId and velocity history', () => {

	const artifact = {
		uniformPlan: [ {
			slots: [
				{ offset: 0, source: { kind: 'frame.frameId' } },
				{ offset: 16, source: { kind: 'velocity.previousProjectionMatrix' } },
			],
		} ],
	};
	const { source, unsupportedKinds } = emitUpdaterSource( artifact );
	assert.deepEqual( unsupportedKinds, [] );
	assert.match( source, /Symbol\.for\("@tsl-precompile\/runtime\/temporal-frame@1"\)/ );
	assert.match( source, /Symbol\.for\("@tsl-precompile\/runtime\/velocity-projection-matrix@1"\)/ );
	assert.match( source, /new Matrix4\(\)\.copy\(projectionMatrix\)/ );
	assert.match( source, /temporal\.advance === false/ );
	assert.match( source, /temporal\.frameId !== undefined/ );
	assert.match( source, /Number\.isFinite\(_s\.frameId\) \? _s\.frameId : frame\.frameId/ );

} );

test( 'emitUpdaterSource — frame.time.scaled bakes scale literal and honours __tslpPinnedClock (Wave 6 S1)', () => {

	const artifact = {
		uniformPlan: [ {
			slots: [
				{ offset: 0, source: { kind: 'frame.time.scaled', scale: 0.5 } },
				{ offset: 4, source: { kind: 'frame.time.scaled', scale: -1.25 } },
				// Defensive: a missing/NaN scale should fall back to 1 so the slot
				// still produces a `* 1` writer instead of `* undefined`.
				{ offset: 8, source: { kind: 'frame.time.scaled' } },
			],
		} ],
	};
	const { source, unsupportedKinds } = emitUpdaterSource( artifact );
	assert.deepEqual( unsupportedKinds, [] );
	assert.match( source, /writeF32\(view, byteOffset \+ 0, \(typeof globalThis\.__tslpPinnedClock === 'number' && Number\.isFinite\(globalThis\.__tslpPinnedClock\) \? globalThis\.__tslpPinnedClock : frame\.time\) \* 0\.5\);/ );
	assert.match( source, /writeF32\(view, byteOffset \+ 4, \(typeof globalThis\.__tslpPinnedClock === 'number' && Number\.isFinite\(globalThis\.__tslpPinnedClock\) \? globalThis\.__tslpPinnedClock : frame\.time\) \* -1\.25\);/ );
	assert.match( source, /writeF32\(view, byteOffset \+ 8, \(typeof globalThis\.__tslpPinnedClock === 'number' && Number\.isFinite\(globalThis\.__tslpPinnedClock\) \? globalThis\.__tslpPinnedClock : frame\.time\) \* 1\);/ );

} );

test( 'emitUpdaterSource — uniform.live with valueSnapshot falls back to frozen snapshot, severity=blocked', () => {

	const artifact = {
		uniformPlan: [ {
			slots: [
				{ offset: 0, source: { kind: 'uniform.live', name: 'shadowMatrix', valueSnapshot: { type: 'mat4', data: new Array( 16 ).fill( 0 ).map( ( _, i ) => i ) } } },
				{ offset: 64, dtype: 'int', source: { kind: 'uniform.live', name: 'dynamicLightCount', valueSnapshot: { type: 'number', data: 2 } } },
			],
		} ],
	};
	const { source, unsupportedKinds } = emitUpdaterSource( artifact );
	assert.equal( unsupportedKinds.length, 2 );
	assert.equal( unsupportedKinds[ 0 ].kind, 'uniform.live' );
	assert.equal( unsupportedKinds[ 0 ].severity, 'blocked' );
	assert.match( source, /writeMat4\(view, byteOffset \+ 0, __const0\);/ );
	assert.match( source, /writeI32\(view, byteOffset \+ 64, __const1\);/ );

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

test( 'emitUpdaterSource — object3d.position can target the frame camera', () => {

	const artifact = {
		uniformPlan: [ {
			slots: [
				{ offset: 0, source: { kind: 'object3d.position', target: 'camera', valueSnapshot: { type: 'vec3', data: [ 1, 2, 3 ] } } },
			],
		} ],
	};
	const { source, unsupportedKinds } = emitUpdaterSource( artifact );
	assert.deepEqual( unsupportedKinds, [] );
	assert.match( source, /__tslpObject3DTargets && material\.__tslpObject3DTargets\.camera/ );
	assert.match( source, /writeVec3\(view, byteOffset \+ 0, _target && _target\.position \? _target\.position : \{ x: 1, y: 2, z: 3 \}/ );

} );

test( 'emitUpdaterSource — object3d.nodeUniform reads frame.object[property].value live', () => {

	const artifact = {
		uniformPlan: [ {
			slots: [
				{ offset: 0, source: { kind: 'object3d.nodeUniform', property: 'distortionScale', valueSnapshot: { type: 'number', data: 3.7 } } },
			],
		} ],
	};
	const { source, unsupportedKinds } = emitUpdaterSource( artifact );
	assert.deepEqual( unsupportedKinds, [] );
	assert.match( source, /frame\.object && frame\.object\["distortionScale"\]/ );
	assert.match( source, /const _value = _node && _node\.value !== undefined \? _node\.value : _node; writeF32\(view, byteOffset \+ 0, _value\);/ );
	assert.match( source, /writeF32\(view, byteOffset \+ 0, __const0\);/ );

} );

test( 'emitUpdaterSource — object3d.nodeUniform reads direct frame.object[property] values', () => {

	const artifact = {
		uniformPlan: [ {
			slots: [
				{ offset: 0, dtype: 'color', source: { kind: 'object3d.nodeUniform', property: 'color', valueSnapshot: { type: 'color', data: [ 0.1, 0.2, 0.3 ] } } },
			],
		} ],
	};
	const { source, unsupportedKinds } = emitUpdaterSource( artifact );
	assert.deepEqual( unsupportedKinds, [] );
	assert.match( source, /frame\.object && frame\.object\["color"\]/ );
	assert.match( source, /const _value = _node && _node\.value !== undefined \? _node\.value : _node; writeColor\(view, byteOffset \+ 0, _value\);/ );

} );

test( 'emitUpdaterSource — object3d.nodeUniform with opaque valueType + numeric snapshot infers writeF32 (Sky showSunDisc)', () => {

	const artifact = {
		uniformPlan: [ {
			slots: [
				{ offset: 0, source: { kind: 'object3d.nodeUniform', property: 'showSunDisc', uniformType: null, valueSnapshot: { type: 'undefined', data: 1 } } },
			],
		} ],
	};
	const { source, unsupportedKinds } = emitUpdaterSource( artifact );
	assert.deepEqual( unsupportedKinds, [] );
	assert.match( source, /frame\.object && frame\.object\["showSunDisc"\]/ );
	assert.match( source, /const _value = _node && _node\.value !== undefined \? _node\.value : _node; writeF32\(view, byteOffset \+ 0, _value\);/ );

} );

test( 'emitUpdaterSource — object3d.nodeUniform with fully-opaque valueType downgrades to blocked + no-op (does not throw)', () => {

	const artifact = {
		uniformPlan: [ {
			slots: [
				{ offset: 0, source: { kind: 'object3d.nodeUniform', property: 'mysteryFlag', uniformType: null, valueSnapshot: { type: 'undefined', data: undefined } } },
			],
		} ],
	};
	const { source, unsupportedKinds } = emitUpdaterSource( artifact );
	assert.equal( unsupportedKinds.length, 1 );
	assert.equal( unsupportedKinds[ 0 ].severity, 'blocked' );
	assert.equal( unsupportedKinds[ 0 ].kind, 'object3d.nodeUniform' );
	assert.match( unsupportedKinds[ 0 ].reason, /unknown valueType/ );
	assert.doesNotMatch( source, /throw new Error/ );
	assert.match( source, /frozen to 0/ );

} );

test( 'emitUpdaterSource — object.scale and attenuationDistance', () => {

	const artifact = {
		uniformPlan: [ {
			slots: [
				{ offset: 0, source: { kind: 'object.scale' } },
				{ offset: 16, source: { kind: 'object.radius', valueSnapshot: { type: 'number', data: 1.25 } } },
				{ offset: 20, source: { kind: 'material.attenuationDistance', property: 'attenuationDistance' } },
				{ offset: 24, source: { kind: 'object3d.radius', valueSnapshot: { type: 'number', data: 2.5 } } },
			],
		} ],
	};
	const { source, unsupportedKinds } = emitUpdaterSource( artifact );
	assert.deepEqual( unsupportedKinds, [] );
	assert.match( source, /writeVec3\(view, byteOffset \+ 0, frame\.object\.scale\);/ );
	assert.match( source, /const _g = frame\.object && frame\.object\.geometry/ );
	assert.match( source, /_g\.computeBoundingSphere\(\)/ );
	assert.match( source, /writeF32\(view, byteOffset \+ 16, _g && _g\.boundingSphere \? _g\.boundingSphere\.radius : 1\.25\);/ );
	assert.match( source, /writeF32\(view, byteOffset \+ 20, material\.attenuationDistance\);/ );
	assert.match( source, /writeF32\(view, byteOffset \+ 24, _g && _g\.boundingSphere \? _g\.boundingSphere\.radius : 2\.5\);/ );

} );

test( 'emitUpdaterSource — object matrices recompute from live frame object', () => {

	const artifact = {
		uniformPlan: [ {
			name: 'object',
			slots: [
				{ offset: 0, source: { kind: 'object.normalMatrix' } },
				{ offset: 48, source: { kind: 'object.modelViewMatrix' } },
			],
		} ],
	};
	const { source, unsupportedKinds } = emitUpdaterSource( artifact );
	assert.deepEqual( unsupportedKinds, [] );
	assert.match( source, /frame\.object\.normalMatrix\.getNormalMatrix\(frame\.object\.matrixWorld\)/ );
	assert.match( source, /frame\.object\.modelViewMatrix\.multiplyMatrices\(frame\.camera\.matrixWorldInverse, frame\.object\.matrixWorld\)/ );
	assert.match( source, /writeMat3\(view, byteOffset \+ 0, frame\.object && frame\.object\.normalMatrix\);/ );
	assert.match( source, /writeMat4\(view, byteOffset \+ 48, frame\.object && frame\.object\.modelViewMatrix\);/ );

	// Wave 5 Phase A1: recompute is gated for SkinnedMesh / InstancedMesh /
	// PointsNodeMaterial — their renderer path already encodes additional
	// transforms (skinning offsets, instanceMatrix, billboard alignment) that
	// a naive `camera.matrixWorldInverse * matrixWorld` would clobber.
	assert.match( source, /frame\.object\.isSkinnedMesh !== true/ );
	assert.match( source, /frame\.object\.isInstancedMesh !== true/ );
	assert.match( source, /frame\.object\.material\.isPointsNodeMaterial !== true/ );

} );

test( 'emitUpdaterSource — light slots delegate to the canonical generated light writer', () => {

	const artifact = {
		uniformPlan: [ {
			name: 'render',
			slots: [
				{ offset: 240, source: { kind: 'light.shadowMatrix', lightIndex: 1, lightUuid: 'captured-light', valueSnapshot: { type: 'mat4', data: [ 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1 ] } } },
			],
		} ],
	};
	const { source, unsupportedKinds } = emitUpdaterSource( artifact );
	assert.deepEqual( unsupportedKinds, [] );
	assert.match( source, /linkGeneratedLightIdentitySource as _tslpLinkLightIdentitySource/ );
	assert.match( source, /writeGeneratedLightValue as _tslpWriteLightValue/ );
	assert.match( source, /const __lightIdentityTable = Object\.freeze\(\[Object\.freeze/ );
	assert.match( source, /const __lightSource0 = Object\.freeze\(\{"kind":"light\.shadowMatrix","lightIndex":1,"lightUuid":"captured-light"/ );
	assert.match( source, /"lightIdentity":0/ );
	assert.match( source, /_tslpLinkLightIdentitySource\(__lightSource0, __lightIdentityTable\)/ );
	assert.match( source, /_tslpWriteLightValue\(view, byteOffset \+ 240, "light\.shadowMatrix", __lightSource0, frame\)/ );

} );

test( 'emitUpdaterSource — duplicate light source descriptors share one frozen literal', () => {

	const artifact = {
		uniformPlan: [ {
			name: 'render',
			slots: [
				{ offset: 0, source: { kind: 'light.distance', lightIndex: 0, lightUuid: 'same' } },
				{ offset: 4, source: { kind: 'light.distance', lightIndex: 0, lightUuid: 'same' } },
			],
		} ],
	};
	const { source, unsupportedKinds } = emitUpdaterSource( artifact );
	assert.deepEqual( unsupportedKinds, [] );
	assert.equal( source.match( /const __lightSource0 =/g ).length, 1 );
	assert.doesNotMatch( source, /__lightSource1/ );
	assert.equal( source.match( /__lightSource0, frame\)/g ).length, 2 );

} );

test( 'emitUpdaterSource — generated and hydrated missing-light writes are byte-identical', () => {

	const sourceDescriptor = {
		kind: 'light.distance',
		lightIndex: 7,
		lightUuid: 'missing-live-light',
		valueSnapshot: { type: 'f32', data: 91.5 },
	};
	const { source } = emitUpdaterSource( {
		uniformPlan: [ { name: 'render', slots: [ { offset: 0, source: sourceDescriptor } ] } ],
	} );
	const generated = executeLightOnlyUpdater( source );
	const frame = { scene: { traverse() {} } };
	const generatedView = new DataView( new ArrayBuffer( 4 ) );
	const hydratedView = new DataView( new ArrayBuffer( 4 ) );

	generated.updateGroup( frame, null, generatedView, 0, 'render' );
	writeGeneratedLightValue( hydratedView, 0, sourceDescriptor.kind, sourceDescriptor, frame );

	assert.deepEqual( new Uint8Array( generatedView.buffer ), new Uint8Array( hydratedView.buffer ) );
	assert.equal( generatedView.getFloat32( 0, true ), 91.5 );

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

test( 'emitUpdaterSource — renderer.toneMappingExposure writes frame.renderer.toneMappingExposure', () => {

	const artifact = {
		uniformPlan: [ {
			name: 'render',
			slots: [
				{ offset: 128, source: { kind: 'renderer.toneMappingExposure' } },
			],
		} ],
	};
	const { source, unsupportedKinds } = emitUpdaterSource( artifact );
	assert.deepEqual( unsupportedKinds, [] );
	assert.match( source, /writeF32\(view, byteOffset \+ 128, frame\.renderer \? frame\.renderer\.toneMappingExposure : 1\.0\)/ );
	assert.match( source, /import \{ writeF32 \}/ );

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

test( 'emitUpdaterSource — generated modules parse as ESM', () => {

	const artifacts = [
		{ uniformPlan: [] },
		{
			uniformPlan: [ {
				name: 'scene',
				slots: [
					{ offset: 0, source: { kind: 'camera.projectionMatrix' } },
					{ offset: 64, source: { kind: 'camera.viewMatrix' } },
					{ offset: 128, source: { kind: 'frame.time' } },
					{ offset: 144, source: { kind: 'material.color', property: 'color' } },
					{ offset: 160, source: { kind: 'material.map.matrix', property: 'map' } },
					{ offset: 208, source: { kind: 'constant', valueSnapshot: { type: 'vec4', data: [ 1, 0.5, 0.25, 1 ] } } },
				],
			} ],
		},
		{
			uniformPlan: [ {
				name: 'object',
				slots: [
					{ offset: 0, source: { kind: 'scene.fog.color', property: 'color' } },
					{ offset: 16, source: { kind: 'object3d.userData', property: 'wind', uniformType: 'float' } },
					{ offset: 32, source: { kind: 'renderer.toneMappingExposure' } },
				],
			} ],
		},
		{
			uniformPlan: [ {
				name: 'blocked',
				slots: [
					{ offset: 0, source: { kind: 'builtin.dfgLUT' } },
					{ offset: 16, source: { kind: 'mystery.kind' } },
				],
			} ],
		},
	];

	for ( const artifact of artifacts ) {

		const { source } = emitUpdaterSource( artifact );
		assert.doesNotThrow( () => parse( source, { sourceType: 'module' } ) );

	}

} );
