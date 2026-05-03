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

test( 'cell: light.shadowBias → reads _l.shadow.bias from indexed light', () => {

	const r = generateForPlan( { groups: [ { slots: [ { byteOffset: 16, source: { kind: 'light.shadowBias', property: 'bias', lightIndex: 0 } } ] } ] } );
	assertGenerates( r, '_l.shadow.bias' );
	assertGenerates( r, '_tslpFindLight(frame.scene, 0)' );
	assertGenerates( r, 'writeF32(view, byteOffset + 16,' );

} );

test( 'cell: light.shadowNormalBias / Radius / Intensity / BlurSamples → all writeF32', () => {

	const r = generateForPlan( { groups: [ { slots: [
		{ byteOffset: 0, source: { kind: 'light.shadowNormalBias', property: 'normalBias', lightIndex: 1 } },
		{ byteOffset: 4, source: { kind: 'light.shadowRadius', property: 'radius', lightIndex: 1 } },
		{ byteOffset: 8, source: { kind: 'light.shadowIntensity', property: 'intensity', lightIndex: 1 } },
		{ byteOffset: 12, source: { kind: 'light.shadowBlurSamples', property: 'blurSamples', lightIndex: 1 } },
	] } ] } );
	assertGenerates( r, '_l.shadow.normalBias' );
	assertGenerates( r, '_l.shadow.radius' );
	assertGenerates( r, '_l.shadow.intensity' );
	assertGenerates( r, '_l.shadow.blurSamples' );
	assertGenerates( r, '_tslpFindLight(frame.scene, 1)' );

} );

test( 'cell: light.shadowMapSize → writeVec2 from _l.shadow.mapSize', () => {

	const r = generateForPlan( { groups: [ { slots: [ { byteOffset: 32, source: { kind: 'light.shadowMapSize', property: 'mapSize', lightIndex: 2 } } ] } ] } );
	assertGenerates( r, '_l.shadow.mapSize' );
	assertGenerates( r, 'writeVec2(view, byteOffset + 32, _l.shadow.mapSize)' );

} );
