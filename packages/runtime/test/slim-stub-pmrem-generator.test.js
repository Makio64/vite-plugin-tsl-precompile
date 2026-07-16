import test from 'node:test';
import assert from 'node:assert/strict';

import PMREMGenerator from '../src/slim-stub-pmrem-generator.js';

test( 'slim PMREM shell stays constructible for full-renderer adapters', () => {

	const renderer = {};
	const generator = new PMREMGenerator( renderer );

	assert.equal( generator._renderer, renderer );
	assert.doesNotThrow( () => generator.dispose() );

} );

test( 'slim PMREM shell rejects generation but accepts compile-only hints', async () => {

	const generator = new PMREMGenerator( {} );
	const expected = /PMREMGenerator is excluded because it creates NodeMaterials at runtime/;

	assert.throws( () => generator.fromScene( {} ), expected );
	assert.throws( () => generator.fromEquirectangular( {} ), expected );
	assert.throws( () => generator.fromCubemap( {} ), expected );
	await assert.doesNotReject( generator.compileCubemapShader() );
	await assert.doesNotReject( generator.compileEquirectangularShader() );

} );
