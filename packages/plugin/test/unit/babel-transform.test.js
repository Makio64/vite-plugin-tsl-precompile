import { test } from 'node:test';
import assert from 'node:assert/strict';

import { transformSource } from '../../src/babel-transform.js';

function resolveArtifactStub( table ) {

	return ( name ) => table[ name ] ? { hash: table[ name ] } : null;

}

test( 'babel — simple .precompile call is rewritten', () => {

	const src = `import {X} from 'three';\nconst m = new X();\nm.precompile('hero');\n`;
	const { code, touchedNames } = transformSource( src, {
		filename: 'test.js',
		resolveArtifact: resolveArtifactStub( { hero: 'sha256:abc' } ),
	} );
	assert.deepEqual( touchedNames, [ 'hero' ] );
	assert.match( code, /__applyPrecompiled\(m, __tsl_art_hero, "sha256:abc"\)/ );
	assert.match( code, /import \* as __tsl_art_hero from "virtual:tsl-precompile\/hero"/ );
	assert.match( code, /import \{ __applyPrecompiled \} from "@tsl-precompile\/runtime\/apply"/ );

} );

test( 'babel — no-op when file has no marker', () => {

	const src = `const x = 1;\nfoo();\n`;
	const { code, touchedNames } = transformSource( src, {
		filename: 'test.js',
		resolveArtifact: () => null,
	} );
	assert.equal( code, src );
	assert.deepEqual( touchedNames, [] );

} );

test( 'babel — unknown-name call produces a clear build error', () => {

	const src = `const m = foo();\nm.precompile('missing');\n`;
	assert.throws( () => transformSource( src, {
		filename: 'foo.js',
		resolveArtifact: () => null,
	} ), /no captured artifact/ );

} );

test( 'babel — non-literal name throws', () => {

	const src = `const m = foo();\nconst n = 'hero';\nm.precompile(n);\n`;
	assert.throws( () => transformSource( src, {
		filename: 'foo.js',
		resolveArtifact: () => ( { hash: 'x' } ),
	} ), /string literal/ );

} );

test( 'babel — chained precompile returns material', () => {

	const src = `const m = foo().precompile('hero');\n`;
	const { code } = transformSource( src, {
		filename: 'test.js',
		resolveArtifact: resolveArtifactStub( { hero: 'sha256:abc' } ),
	} );
	assert.match( code, /__applyPrecompiled\(foo\(\), __tsl_art_hero, "sha256:abc"\)/ );

} );

test( 'babel — multiple calls share one import', () => {

	const src = `m1.precompile('a');\nm2.precompile('a');\nm3.precompile('b');\n`;
	const { code, touchedNames } = transformSource( src, {
		filename: 'x.js',
		resolveArtifact: resolveArtifactStub( { a: 'h-a', b: 'h-b' } ),
	} );
	assert.deepEqual( touchedNames, [ 'a', 'a', 'b' ] );
	const importMatches = code.match( /import \* as __tsl_art_a from/g ) || [];
	assert.equal( importMatches.length, 1 );

} );
