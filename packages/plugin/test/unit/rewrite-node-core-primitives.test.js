/**
 * Exact r185 whole-module rewrite tests for the final retained Node helpers.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from '@babel/parser';

import { rewriteThreeSource } from '../../src/three-rewrite.js';
import { THREE_SRC } from '../_three-src.js';

const NODE_UTILS_PATH = resolve( THREE_SRC, 'nodes/core/NodeUtils.js' );
const NODE_CONSTANTS_PATH = resolve( THREE_SRC, 'nodes/core/constants.js' );
const RUNTIME_ID = 'virtual:tsl-precompile/__slim-rewrite-runtime/node-core-primitives';

function rewrite( path, source = readFileSync( path, 'utf8' ) ) {

	return rewriteThreeSource( source, path, { threeVersion: '0.185.1', pluginVersion: '0.0.0' } );

}

function directReExport( result ) {

	assert.ok( result && result.code );
	assert.equal( result.warning, null );
	const ast = parse( result.code, { sourceType: 'module' } );
	assert.equal( ast.program.body.length, 1, 'the rewritten module is only one re-export declaration' );
	const declaration = ast.program.body[ 0 ];
	assert.equal( declaration.type, 'ExportNamedDeclaration' );
	assert.equal( declaration.declaration, null );
	assert.equal( declaration.source.value, RUNTIME_ID );
	return declaration.specifiers.map( ( specifier ) => ( {
		local: specifier.local.name,
		exported: specifier.exported.name,
	} ) );

}

test( 'rewrite/NodeUtils: replaces the exact stock module with three pure named re-exports', () => {

	const result = rewrite( NODE_UTILS_PATH );
	assert.deepEqual( directReExport( result ), [
		{ local: 'hash', exported: 'hash' },
		{ local: 'hashArray', exported: 'hashArray' },
		{ local: 'hashString', exported: 'hashString' },
	] );
	assert.doesNotMatch( result.code, /(?:Color|Matrix[234]|Vector[234]|StackTrace|cyrb53|getValueType)/ );

} );

test( 'rewrite/nodes/core/constants: replaces the exact stock module with graph-free access/update constants', () => {

	const result = rewrite( NODE_CONSTANTS_PATH );
	assert.deepEqual( directReExport( result ), [
		{ local: 'NodeAccess', exported: 'NodeAccess' },
		{ local: 'NodeUpdateType', exported: 'NodeUpdateType' },
	] );
	assert.doesNotMatch( result.code, /(?:NodeShaderStage|NodeType|defaultShaderStages|vectorComponents)/ );

} );

test( 'rewrite/node-core primitives: comment and formatting drift preserve the same semantic AST', () => {

	for ( const path of [ NODE_UTILS_PATH, NODE_CONSTANTS_PATH ] ) {

		const source = `// downstream formatting is irrelevant\n\n${ readFileSync( path, 'utf8' ).replaceAll( '\t', '  ' ) }`;
		assert.equal( rewrite( path, source ).warning, null );

	}

} );

for ( const [ label, path, mutate ] of [
	[
		'NodeUtils hash arithmetic',
		NODE_UTILS_PATH,
		( source ) => source.replace( '0xdeadbeef ^ seed', '0xdeadbeee ^ seed' ),
	],
	[
		'NodeUtils export surface',
		NODE_UTILS_PATH,
		( source ) => `${ source }\nexport const unexpectedNodeHelper = true;\n`,
	],
	[
		'NodeAccess value',
		NODE_CONSTANTS_PATH,
		( source ) => source.replace( "READ_ONLY: 'readOnly'", "READ_ONLY: 'read'" ),
	],
	[
		'node constants export surface',
		NODE_CONSTANTS_PATH,
		( source ) => `${ source }\nexport const unexpectedNodeConstant = true;\n`,
	],
] ) {

	test( `rewrite/node-core primitives: fails closed on ${ label } drift`, () => {

		const result = rewrite( path, mutate( readFileSync( path, 'utf8' ) ) );
		assert.ok( result );
		assert.equal( result.code, null );
		assert.match( result.warning, /complete r185 module AST changed/ );

	} );

}
