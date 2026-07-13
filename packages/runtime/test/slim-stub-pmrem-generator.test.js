import test from 'node:test';
import assert from 'node:assert/strict';

import PMREMGenerator from '../src/slim-stub-pmrem-generator.js';

test( 'slim PMREM shell stays constructible for full-renderer adapters', () => {

	const renderer = {};
	const generator = new PMREMGenerator( renderer );

	assert.equal( generator._renderer, renderer );
	assert.doesNotThrow( () => generator.dispose() );

} );

test( 'slim PMREM shell fails before entering a runtime compiler path', async () => {

	const generator = new PMREMGenerator( {} );
	const expected = /PMREMGenerator is excluded because it creates NodeMaterials at runtime/;

	assert.throws( () => generator.fromScene( {} ), expected );
	assert.throws( () => generator.fromEquirectangular( {} ), expected );
	assert.throws( () => generator.fromCubemap( {} ), expected );
	await assert.rejects( generator.compileCubemapShader(), expected );

} );
