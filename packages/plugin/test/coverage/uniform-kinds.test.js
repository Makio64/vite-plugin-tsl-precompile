import { test } from 'node:test';
import { generateForPlan, assertGenerates } from './_helpers.js';

test( 'cell: uniform.constant f32 → inlined', () => {

	const r = generateForPlan( { groups: [ { slots: [ { byteOffset: 0, source: { kind: 'uniform.constant', valueType: 'f32', value: 2.5 } } ] } ] } );
	assertGenerates( r, 'const __const0 = 2.5;' );
	assertGenerates( r, 'writeF32(view, byteOffset + 0, __const0)' );

} );

test( 'cell: uniform.constant vec4 → inlined', () => {

	const r = generateForPlan( { groups: [ { slots: [ { byteOffset: 0, source: { kind: 'uniform.constant', valueType: 'vec4', value: [ 1, 2, 3, 4 ] } } ] } ] } );
	assertGenerates( r, 'const __const0 = { x: 1, y: 2, z: 3, w: 4 };' );
	assertGenerates( r, 'writeVec4(view, byteOffset + 0, __const0)' );

} );

test( 'cell: uniform.constant color → inlined', () => {

	const r = generateForPlan( { groups: [ { slots: [ { byteOffset: 0, source: { kind: 'uniform.constant', valueType: 'color', value: [ 0.5, 0.6, 0.7 ] } } ] } ] } );
	assertGenerates( r, 'const __const0 = { r: 0.5, g: 0.6, b: 0.7 };' );
	assertGenerates( r, 'writeColor(view, byteOffset + 0, __const0)' );

} );

test( 'cell: uniform.live vec3 → reads property', () => {

	const r = generateForPlan( { groups: [ { slots: [ { byteOffset: 0, source: { kind: 'uniform.live', valueType: 'vec3', property: 'lightPosition' } } ] } ] } );
	assertGenerates( r, 'writeVec3(view, byteOffset + 0, material.lightPosition)' );

} );

test( 'cell: light.shadowBias → delegates its full source to the canonical writer', () => {

	const r = generateForPlan( { groups: [ { slots: [ { byteOffset: 16, source: { kind: 'light.shadowBias', property: 'bias', lightIndex: 0, lightUuid: 'capture-a' } } ] } ] } );
	assertGenerates( r, '"kind":"light.shadowBias","property":"bias","lightIndex":0,"lightUuid":"capture-a"' );
	assertGenerates( r, '_tslpWriteLightValue(view, byteOffset + 16, "light.shadowBias", __lightSource0, frame)' );

} );

test( 'cell: light.shadow scalar families → all delegate to the canonical writer', () => {

	const r = generateForPlan( { groups: [ { slots: [
		{ byteOffset: 0, source: { kind: 'light.shadowNormalBias', property: 'normalBias', lightIndex: 1 } },
		{ byteOffset: 4, source: { kind: 'light.shadowRadius', property: 'radius', lightIndex: 1 } },
		{ byteOffset: 8, source: { kind: 'light.shadowIntensity', property: 'intensity', lightIndex: 1 } },
		{ byteOffset: 12, source: { kind: 'light.shadowBlurSamples', property: 'blurSamples', lightIndex: 1 } },
		{ byteOffset: 16, source: { kind: 'light.shadowCameraNear', property: 'camera.near', lightIndex: 1 } },
		{ byteOffset: 20, source: { kind: 'light.shadowCameraFar', property: 'camera.far', lightIndex: 1 } },
	] } ] } );
	assertGenerates( r, '"light.shadowNormalBias", __lightSource0, frame' );
	assertGenerates( r, '"light.shadowRadius", __lightSource1, frame' );
	assertGenerates( r, '"light.shadowIntensity", __lightSource2, frame' );
	assertGenerates( r, '"light.shadowBlurSamples", __lightSource3, frame' );
	assertGenerates( r, '"light.shadowCameraNear", __lightSource4, frame' );
	assertGenerates( r, '"light.shadowCameraFar", __lightSource5, frame' );

} );

test( 'cell: light.shadowMapSize → delegates to the canonical writer', () => {

	const r = generateForPlan( { groups: [ { slots: [ { byteOffset: 32, source: { kind: 'light.shadowMapSize', property: 'mapSize', lightIndex: 2 } } ] } ] } );
	assertGenerates( r, '_tslpWriteLightValue(view, byteOffset + 32, "light.shadowMapSize", __lightSource0, frame)' );

} );

test( 'cell: light.shadowMatrix → delegates to the canonical writer', () => {

	const r = generateForPlan( { groups: [ { slots: [ { byteOffset: 64, source: { kind: 'light.shadowMatrix', property: 'matrix', lightIndex: 3 } } ] } ] } );
	assertGenerates( r, '_tslpWriteLightValue(view, byteOffset + 64, "light.shadowMatrix", __lightSource0, frame)' );

} );
