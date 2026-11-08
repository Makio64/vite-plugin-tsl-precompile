/** Shared semantic AST guards for private Three rewrite owners. */
import { createHash } from 'node:crypto';
import { parse } from '@babel/parser';
import _traverse from '@babel/traverse';
import _generate from '@babel/generator';
import * as t from '@babel/types';
const traverse = _traverse.default || _traverse;
const generate = _generate.default || _generate;

export function compactAstFingerprint( ast ) {

	const source = generate( ast, { compact: true, comments: false } ).code;
	return createHash( 'sha256' ).update( source ).digest( 'hex' );

}

export function assertExactModuleShape( ast, label, expectedFingerprint ) {

	const actualFingerprint = compactAstFingerprint( ast );
	const fingerprints = Array.isArray( expectedFingerprint ) ? expectedFingerprint : [ expectedFingerprint ];
	if ( ! fingerprints.includes( actualFingerprint ) ) {

		throw new Error( `${ label }: complete r185 module AST changed (expected ${ expectedFingerprint }, got ${ actualFingerprint })` );

	}

}

export function parseFunctionBody( source ) {

	const parsed = parse( `function __tslp_stub__() {${ source }\n}`, {
		sourceType: 'module',
		plugins: [ 'importAttributes', 'topLevelAwait' ],
	} );
	return parsed.program.body[ 0 ].body;

}

/**
 * Remove a private class method once no member expression in the module still
 * names it, e.g. a compiler-fallback helper whose only callers were rewritten.
 * Returns whether the method was removed.
 */
export function removeUncalledClassMethod( ast, methodName ) {

	let method = null;
	let called = false;
	traverse( ast, {
		ClassMethod( path ) {

			if ( t.isIdentifier( path.node.key, { name: methodName } ) ) method = path;

		},
		MemberExpression( path ) {

			if ( t.isIdentifier( path.node.property, { name: methodName } ) ) called = true;

		},
	} );
	if ( ! method || called ) return false;
	method.remove();
	return true;

}

export function findClassMethod( ast, methodName ) {

	let found = null;
	traverse( ast, {
		ClassMethod( path ) {

			if ( found ) return;
			if ( ! t.isIdentifier( path.node.key, { name: methodName } ) ) return;
			found = path.node;

		},
	} );
	return found;

}
