import { test } from 'node:test';
import assert from 'node:assert/strict';

import { annotateDevMarkerSources, instrumentLiveContextDependencies, instrumentLiveUniformIdentities, transformSource } from '../../src/babel-transform.js';
import { markerSourceRevision } from '../../src/_shared/module-identity.js';

function resolveArtifactStub( table ) {

	return ( name ) => table[ name ] ? { hash: table[ name ] } : null;

}

test( 'babel — live context imports retain closure-hidden AO and shadow dependencies', () => {

	const source = `
		import { builtinAOContext, builtinShadowContext as shadowContext, vec3 } from 'three/tsl';
		const ao = builtinAOContext( aoNode );
		const shadow = shadowContext( shadowNode, light );
	`;
	const result = instrumentLiveContextDependencies( source, { filename: '/project/src/effects.js' } );
	assert.equal( result.touched, true );
	assert.match( result.code, /attachLiveNodeDependency as __tslpAttachLiveNodeDependency/ );
	assert.match( result.code, /builtinAOContext as __tslp_builtinAOContext/ );
	assert.match( result.code, /builtinShadowContext as __tslp_builtinShadowContext/ );
	assert.match( result.code, /const builtinAOContext = \(\.\.\.__tslp_context_args\) =>/ );
	assert.match( result.code, /const shadowContext = \(\.\.\.__tslp_context_args/ );
	assert.match( result.code, /role: "ambient-occlusion"/ );
	assert.match( result.code, /role: "shadow",\s*light: __tslp_context_args/ );
	assert.match( result.code, /const ao = builtinAOContext\(aoNode\)/ );
	assert.match( result.code, /const shadow = shadowContext\(shadowNode, light\)/ );

} );

test( 'babel — live context dependency transform leaves namespace and unrelated imports unchanged', () => {

	const namespace = `import * as TSL from 'three/tsl';\nTSL.builtinAOContext( aoNode );\n`;
	const unrelated = `import { builtinAOContext } from './local-tsl.js';\nbuiltinAOContext( aoNode );\n`;
	assert.equal( instrumentLiveContextDependencies( namespace, { filename: 'namespace.js' } ).touched, false );
	assert.equal( instrumentLiveContextDependencies( unrelated, { filename: 'local.js' } ).touched, false );

} );

test( 'babel — direct TSL uniform calls receive stable call-site occurrence identities', () => {

	const source = `
		import { uniform, uniform as makeUniform, vec3 } from 'three/tsl';
		const shared = uniform( 1 );
		const makePair = () => [ makeUniform( 0 ), makeUniform( 0 ) ];
	`;
	const result = instrumentLiveUniformIdentities( source, {
		filename: '/project/src/reduce.js',
		root: '/project',
	} );
	assert.equal( result.touched, true );
	assert.match( result.code, /registerLiveUniformNode as __tslpRegisterLiveUniformNode/ );
	assert.match( result.code, /let __tslpUniformOccurrence0 = 0/ );
	assert.match( result.code, /"uniform-callsite@1#src\/reduce\.js#0"/ );
	assert.match( result.code, /"uniform-callsite@1#src\/reduce\.js#1"/ );
	assert.match( result.code, /"uniform-callsite@1#src\/reduce\.js#2"/ );
	assert.equal( ( result.code.match( /__tslpUniformOccurrence\d\+\+/g ) || [] ).length, 3 );

} );

test( 'babel — live uniform identity transform ignores local and namespace uniform functions', () => {

	const local = `import { uniform } from './nodes.js';\nuniform( 0 );\n`;
	assert.equal( instrumentLiveUniformIdentities( local, { filename: 'local.js' } ).touched, false );

} );

test( 'babel — TSL namespace uniform calls receive stable identities', () => {

	const source = `
		import * as TSL from 'three/tsl';
		import { TSL as WebGPUTSL } from 'three/webgpu';
		const first = TSL.uniform( 0 );
		const second = WebGPUTSL.uniform( 1 );
	`;
	const result = instrumentLiveUniformIdentities( source, { filename: '/project/src/namespaces.js', root: '/project' } );
	assert.equal( result.touched, true );
	assert.match( result.code, /__tslpRegisterLiveUniformNode\(TSL\.uniform\(0\)/ );
	assert.match( result.code, /__tslpRegisterLiveUniformNode\(WebGPUTSL\.uniform\(1\)/ );

} );

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

test( 'babel — raw names that sanitize alike receive distinct imports', () => {

	const src = `m1.precompile('a-b');\nm2.precompile('a_b');\n`;
	const { code, touchedNames } = transformSource( src, {
		filename: 'collision.js',
		resolveArtifact: resolveArtifactStub( { 'a-b': 'h-dash', a_b: 'h-underscore' } ),
	} );
	assert.deepEqual( touchedNames, [ 'a-b', 'a_b' ] );

	const dashImport = code.match( /import \* as ([A-Za-z0-9_$]+) from "virtual:tsl-precompile\/a-b"/ );
	const underscoreImport = code.match( /import \* as ([A-Za-z0-9_$]+) from "virtual:tsl-precompile\/a_b"/ );
	assert.ok( dashImport );
	assert.ok( underscoreImport );
	assert.notEqual( dashImport[ 1 ], underscoreImport[ 1 ] );
	assert.match( code, new RegExp( `__applyPrecompiled\\(m1, ${ dashImport[ 1 ] }, "h-dash"\\)` ) );
	assert.match( code, new RegExp( `__applyPrecompiled\\(m2, ${ underscoreImport[ 1 ] }, "h-underscore"\\)` ) );

} );

test( 'babel — generated helper and artifact imports avoid user bindings in nested scopes', () => {

	const src = `
		const __tsl_art_hero = 'user artifact binding';
		function build(__applyPrecompiled) {
			return material.precompile('hero');
		}
	`;
	const { code } = transformSource( src, {
		filename: 'binding-collision.js',
		resolveArtifact: resolveArtifactStub( { hero: 'sha256:abc' } ),
	} );

	const helperImport = code.match( /import \{ __applyPrecompiled as ([A-Za-z0-9_$]+) \} from "@tsl-precompile\/runtime\/apply"/ );
	const artifactImport = code.match( /import \* as ([A-Za-z0-9_$]+) from "virtual:tsl-precompile\/hero"/ );
	assert.ok( helperImport );
	assert.ok( artifactImport );
	assert.notEqual( helperImport[ 1 ], '__applyPrecompiled' );
	assert.notEqual( artifactImport[ 1 ], '__tsl_art_hero' );
	assert.match( code, new RegExp( `return ${ helperImport[ 1 ] }\\(material, ${ artifactImport[ 1 ] }, "sha256:abc"\\)` ) );

} );

test( 'babel — optional capture context preserves receiver/argument evaluation order', () => {

	const src = `getMaterial().precompile('hero', makeCaptureContext());\n`;
	const { code } = transformSource( src, {
		filename: 'context.js',
		resolveArtifact: resolveArtifactStub( { hero: 'sha256:abc' } ),
	} );
	assert.match( code, /\(__tslp_material, __tslp_context\) => __applyPrecompiled\(__tslp_material, __tsl_art_hero, "sha256:abc"\)/ );
	assert.match( code, /\)\(getMaterial\(\), makeCaptureContext\(\)\)/ );
	assert.equal( ( code.match( /getMaterial\(\)/g ) || [] ).length, 1 );
	assert.ok( code.indexOf( 'getMaterial()' ) < code.indexOf( 'makeCaptureContext()' ) );

} );

test( 'babel — more than one optional context argument throws', () => {

	const src = `material.precompile('hero', scene, camera);\n`;
	assert.throws( () => transformSource( src, {
		filename: 'context.js',
		resolveArtifact: resolveArtifactStub( { hero: 'sha256:abc' } ),
	} ), /takes one or two arguments/ );

} );

test( 'babel — dev markers receive stable distinct call-site identities', () => {

	const src = `first.precompile('shared');\nsecond.precompile('shared', { scene, camera, object });\n`;
	const first = annotateDevMarkerSources( src, { filename: '/project/src/materials.js', root: '/project' } );
	const second = annotateDevMarkerSources( src, { filename: '/project/src/materials.js', root: '/project' } );
	assert.equal( first.code, second.code );
	assert.match( first.code, /first\.precompile\(['"]shared['"], null, "src\/materials\.js:precompile:0", "[a-f0-9]{64}"\)/ );
	assert.match( first.code, /second\.precompile\(['"]shared['"], \{[\s\S]*?\}, "src\/materials\.js:precompile:1", "[a-f0-9]{64}"\)/ );
	let received = null;
	const material = { precompile: ( ...args ) => { received = args; } };
	const single = annotateDevMarkerSources( `material.precompile('single');\n`, {
		filename: '/project/src/materials.js', root: '/project',
	} );
	new Function( 'material', single.code )( material );
	assert.equal( received[ 1 ], null, 'one-argument author calls keep source identity out of the context position' );
	assert.equal( received[ 2 ], 'src/materials.js:precompile:0' );
	assert.match( received[ 3 ], /^[a-f0-9]{64}$/ );

} );

test( 'babel — dev marker identity does not change when unrelated lines move', () => {

	const before = annotateDevMarkerSources( `material.precompile('hero');\n`, {
		filename: '/project/src/materials.js', root: '/project',
	} );
	const after = annotateDevMarkerSources( `const unrelated = true;\n\nmaterial.precompile('hero');\n`, {
		filename: '/project/src/materials.js', root: '/project',
	} );
	assert.match( before.code, /"src\/materials\.js:precompile:0"/ );
	assert.match( after.code, /"src\/materials\.js:precompile:0"/ );

} );

test( 'babel — build rejects a changed captured call-site revision', () => {

	const source = `material.precompile('hero');\n`;
	const owner = {
		identity: 'src/materials.js:precompile:0',
		revision: markerSourceRevision( source ),
	};
	assert.doesNotThrow( () => transformSource( source, {
		filename: '/project/src/materials.js',
		root: '/project',
		resolveArtifact: () => ( { hash: 'sha256:abc', sourceOwners: [ owner ] } ),
	} ) );

	assert.throws( () => transformSource( `const changed = true;\n${ source }`, {
		filename: '/project/src/materials.js',
		root: '/project',
		resolveArtifact: () => ( { hash: 'sha256:abc', sourceOwners: [ owner ] } ),
	} ), /source changed since capture/ );

} );

test( 'babel — build rejects a name captured only from another call site', () => {

	const source = `material.precompile('hero');\n`;
	assert.throws( () => transformSource( source, {
		filename: '/project/src/materials.js',
		root: '/project',
		resolveArtifact: () => ( {
			hash: 'sha256:abc',
			sourceOwners: [ { identity: 'src/other.js:precompile:0', revision: markerSourceRevision( source ) } ],
		} ),
	} ), /was not captured from this call site/ );

} );

test( 'babel — framework script subrequests receive distinct stable identities', () => {

	const source = `material.precompile('hero');\n`;
	const first = annotateDevMarkerSources( source, {
		filename: '/project/src/Page.astro?astro&type=script&index=0&lang.ts', root: '/project',
	} );
	const firstAgain = annotateDevMarkerSources( source, {
		filename: '/project/src/Page.astro?lang.ts&index=0&type=script&astro', root: '/project',
	} );
	const second = annotateDevMarkerSources( source, {
		filename: '/project/src/Page.astro?astro&type=script&index=1&lang.ts', root: '/project',
	} );
	const identity = ( code ) => code.match( /"(src\/Page\.astro\?subresource=[a-f0-9]{64}:precompile:0)"/ )[ 1 ];
	assert.equal( identity( first.code ), identity( firstAgain.code ) );
	assert.notEqual( identity( first.code ), identity( second.code ) );

} );

test( 'babel — dev annotation accepts TypeScript decorators and deprecated import assertions', () => {

	const source = `
		import data from './material.json' assert { type: 'json' };
		@sealed
		class MaterialOwner {
			compile(material) { return material.precompile('decorated'); }
		}
	`;
	const result = annotateDevMarkerSources( source, { filename: '/project/src/decorated.ts', root: '/project' } );
	assert.equal( result.touched, true );
	assert.match( result.code, /src\/decorated\.ts:precompile:0/ );

} );
