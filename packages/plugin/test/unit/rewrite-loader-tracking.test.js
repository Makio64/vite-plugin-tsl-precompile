/**
 * Exact r184 Loader rewrite tests for tree-shaken live-texture tracking.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from '@babel/parser';

import { getSlimRewriteRuntimeModuleRule, rewriteThreeSource } from '../../src/three-rewrite.js';
import { THREE_SRC } from '../_three-src.js';

const LOADER_PATH = resolve( THREE_SRC, 'loaders/Loader.js' );
const RUNTIME_ID = 'virtual:tsl-precompile/__slim-rewrite-runtime/texture-registry';

function rewrite( source = readFileSync( LOADER_PATH, 'utf8' ) ) {

	return rewriteThreeSource( source, LOADER_PATH, { threeVersion: '0.184.0', pluginVersion: '0.0.0' } );

}

test( 'rewrite/Loader: lazily patches the exact concrete constructor without replacing Loader identity', () => {

	const result = rewrite();
	assert.ok( result && result.code );
	assert.equal( result.warning, null );
	const ast = parse( result.code, { sourceType: 'module' } );
	const runtimeImport = ast.program.body.find( ( node ) => node.type === 'ImportDeclaration' && node.source.value === RUNTIME_ID );
	assert.ok( runtimeImport, 'the private texture-registry helper is imported' );
	assert.deepEqual( runtimeImport.specifiers.map( ( specifier ) => specifier.imported.name ), [ 'installTextureLoaderTracking' ] );

	const loaderClasses = ast.program.body.filter( ( node ) => node.type === 'ClassDeclaration' && node.id.name === 'Loader' );
	assert.equal( loaderClasses.length, 1, 'the stock Loader class remains the exported constructor' );
	const constructors = loaderClasses[ 0 ].body.body.filter( ( member ) => member.type === 'ClassMethod' && member.kind === 'constructor' );
	assert.equal( constructors.length, 1 );
	const statement = constructors[ 0 ].body.body.at( -1 );
	assert.equal( statement.type, 'ExpressionStatement' );
	assert.equal( statement.expression.callee.name, 'installTextureLoaderTracking' );
	assert.equal( statement.expression.arguments.length, 1 );
	assert.equal( statement.expression.arguments[ 0 ].object.type, 'ThisExpression' );
	assert.equal( statement.expression.arguments[ 0 ].property.name, 'constructor' );

	const loaderExport = ast.program.body.find( ( node ) =>
		node.type === 'ExportNamedDeclaration'
		&& node.specifiers.some( ( specifier ) => specifier.local.name === 'Loader' && specifier.exported.name === 'Loader' )
	);
	assert.ok( loaderExport, 'the original Loader binding remains the public export' );
	assert.equal( getSlimRewriteRuntimeModuleRule( RUNTIME_ID )?.runtimeFile, 'hydrate/live-texture-registry.js' );

} );

test( 'rewrite/Loader: comment and formatting drift preserves the semantic rewrite', () => {

	const source = `// downstream formatting is irrelevant\n\n${ readFileSync( LOADER_PATH, 'utf8' ).replaceAll( '\t', '  ' ) }`;
	assert.equal( rewrite( source ).warning, null );

} );

for ( const [ label, mutate ] of [
	[ 'constructor behavior', ( source ) => source.replace( "this.crossOrigin = 'anonymous';", "this.crossOrigin = 'use-credentials';" ) ],
	[ 'export surface', ( source ) => `${ source }\nexport const unexpectedLoaderState = true;\n` ],
] ) {

	test( `rewrite/Loader: fails closed on ${ label } drift`, () => {

		const result = rewrite( mutate( readFileSync( LOADER_PATH, 'utf8' ) ) );
		assert.ok( result );
		assert.equal( result.code, null );
		assert.match( result.warning, /Loader: complete r184 module AST changed/ );

	} );

}
