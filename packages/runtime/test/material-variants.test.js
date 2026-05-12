import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MaterialVariantSet, applyMaterialVariant, createMaterialVariants } from '../src/material-variants.js';

test( 'material variants: selects and applies named materials', () => {

	const warm = { name: 'warm' };
	const cool = { name: 'cool' };
	const mesh = { material: warm };
	const variants = createMaterialVariants( { warm, cool }, 'warm' );

	assert.ok( variants instanceof MaterialVariantSet );
	assert.deepEqual( variants.names(), [ 'warm', 'cool' ] );
	assert.equal( variants.current, warm );

	assert.equal( variants.select( 'cool', mesh ), cool );
	assert.equal( variants.currentName, 'cool' );
	assert.equal( mesh.material, cool );
	assert.equal( cool.needsUpdate, true );

} );

test( 'material variants: applies to arrays of targets and cycles', () => {

	const a = { name: 'a' };
	const b = { name: 'b' };
	const one = { material: a };
	const two = { material: a };
	const variants = createMaterialVariants( new Map( [ [ 'a', a ], [ 'b', b ] ] ) );

	variants.cycle( [ one, two ] );
	assert.equal( variants.currentName, 'b' );
	assert.equal( one.material, b );
	assert.equal( two.material, b );

} );

test( 'material variants: rejects invalid inputs loudly', () => {

	assert.throws( () => createMaterialVariants( {} ), /at least one variant/ );
	assert.throws( () => createMaterialVariants( { bad: null } ), /must be a material object/ );
	assert.throws( () => applyMaterialVariant( {}, { name: 'mat' } ), /material property/ );

} );
