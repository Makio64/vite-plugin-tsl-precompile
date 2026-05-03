import { test } from 'node:test';
import { generateForPlan, assertGenerates } from './_helpers.js';

test( 'cell: material.color → writeColor', () => {

	const r = generateForPlan( { groups: [ { slots: [ { byteOffset: 0, source: { kind: 'material.color', property: 'color' } } ] } ] } );
	assertGenerates( r, 'writeColor(view, byteOffset + 0, material.color)' );

} );

test( 'cell: material.emissive + material.opacity', () => {

	const r = generateForPlan( { groups: [ { slots: [
		{ byteOffset: 0, source: { kind: 'material.emissive', property: 'emissive' } },
		{ byteOffset: 16, source: { kind: 'material.opacity', property: 'opacity' } },
	] } ] } );
	assertGenerates( r, 'writeColor(view, byteOffset + 0, material.emissive)' );
	assertGenerates( r, 'writeF32(view, byteOffset + 16, material.opacity)' );

} );

test( 'cell: material.metalness + material.roughness', () => {

	const r = generateForPlan( { groups: [ { slots: [
		{ byteOffset: 0, source: { kind: 'material.metalness', property: 'metalness' } },
		{ byteOffset: 4, source: { kind: 'material.roughness', property: 'roughness' } },
	] } ] } );
	assertGenerates( r, 'writeF32(view, byteOffset + 0, material.metalness)' );
	assertGenerates( r, 'writeF32(view, byteOffset + 4, material.roughness)' );

} );

test( 'cell: clearcoat / sheen physical-material kinds', () => {

	const r = generateForPlan( { groups: [ { slots: [
		{ byteOffset: 0, source: { kind: 'material.clearcoat', property: 'clearcoat' } },
		{ byteOffset: 16, source: { kind: 'material.sheen', property: 'sheen' } },
		{ byteOffset: 32, source: { kind: 'material.sheenColor', property: 'sheenColor' } },
	] } ] } );
	assertGenerates( r, 'writeF32(view, byteOffset + 0, material.clearcoat)' );
	assertGenerates( r, 'writeF32(view, byteOffset + 16, material.sheen)' );
	assertGenerates( r, 'writeColor(view, byteOffset + 32, material.sheenColor)' );

} );
