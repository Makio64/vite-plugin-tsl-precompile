import assert from 'node:assert/strict';
import test from 'node:test';

import { parse } from '@babel/parser';
import * as t from '@babel/types';

import {
	NODE_CORE_PRIMITIVES_VIRTUAL_ID,
	SLIM_REWRITE_RUNTIME_MODULE_RULES,
	getSlimRewriteRuntimeModuleRule,
	injectSlimRewriteRuntimeImports,
} from '../../src/three-rewrite-runtime.js';

test( 'three rewrite runtime registry has immutable, unique virtual owners', () => {

	assert.equal( Object.isFrozen( SLIM_REWRITE_RUNTIME_MODULE_RULES ), true );
	assert.equal( new Set( SLIM_REWRITE_RUNTIME_MODULE_RULES.map( ( rule ) => rule.id ) ).size, SLIM_REWRITE_RUNTIME_MODULE_RULES.length );
	assert.equal( new Set( SLIM_REWRITE_RUNTIME_MODULE_RULES.map( ( rule ) => rule.virtualId ) ).size, SLIM_REWRITE_RUNTIME_MODULE_RULES.length );

	for ( const rule of SLIM_REWRITE_RUNTIME_MODULE_RULES ) {

		assert.equal( Object.isFrozen( rule ), true, rule.id );
		assert.equal( getSlimRewriteRuntimeModuleRule( rule.virtualId ), rule, rule.id );

	}
	assert.equal( getSlimRewriteRuntimeModuleRule( 'virtual:tsl-precompile/unknown' ), null );
	assert.equal(
		getSlimRewriteRuntimeModuleRule( NODE_CORE_PRIMITIVES_VIRTUAL_ID )?.runtimeFile,
		'slim-replay-node-core-primitives.js',
	);

} );

test( 'three rewrite runtime injector groups only referenced helpers by owner', () => {

	const ast = parse( `
		import existing from './existing.js';
		const metadata = { loadAux: true };
		const artifact = loadAux( 'shape', hashNodeGraphSync( input ) );
		const material = new PrecompiledMaterial( artifact );
	`, { sourceType: 'module' } );

	injectSlimRewriteRuntimeImports( ast );

	const imports = ast.program.body.filter( ( node ) => t.isImportDeclaration( node ) );
	assert.deepEqual( imports.map( ( node ) => node.source.value ), [
		'./existing.js',
		'virtual:tsl-precompile/__slim-rewrite-runtime/precompiled-material',
		'virtual:tsl-precompile/__slim-rewrite-runtime/aux-loader',
		'virtual:tsl-precompile/__slim-rewrite-runtime/graph-hash',
	] );
	assert.equal( t.isImportDefaultSpecifier( imports[ 1 ].specifiers[ 0 ] ), true );
	assert.deepEqual(
		imports.slice( 2 ).map( ( node ) => node.specifiers.map( ( specifier ) => specifier.imported.name ) ),
		[ [ 'loadAux' ], [ 'hashNodeGraphSync' ] ],
	);

} );

test( 'three rewrite runtime injector leaves helper-free modules unchanged', () => {

	const ast = parse( `
		import existing from './existing.js';
		const metadata = { loadAux: true };
		const value = metadata.loadAux;
	`, { sourceType: 'module' } );
	const originalBody = ast.program.body.slice();

	injectSlimRewriteRuntimeImports( ast );

	assert.deepEqual( ast.program.body, originalBody );

} );
