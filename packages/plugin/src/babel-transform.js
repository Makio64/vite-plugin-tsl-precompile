/**
 * Babel transform: rewrite `.precompile('name')` call sites.
 *
 * Build-mode:  material.precompile('ocean-water')
 *              →  __applyPrecompiled(material, __art_ocean_water, 'sha256:...')
 *              with `import * as __art_ocean_water from 'virtual:tsl-precompile/ocean-water'`
 *              + `import { __applyPrecompiled } from '@tsl-precompile/runtime/apply'` hoisted.
 *
 * Dev-mode (not yet implemented here — Phase 2b):  leave the call alone so
 * the runtime marker in `@tsl-precompile/runtime/marker` fires and the
 * dev-capture server writes the artifact.
 *
 * Scope:
 *   - Looks for CallExpression nodes whose callee is a MemberExpression
 *     named exactly `precompile` with a single string-literal argument.
 *   - Computed member access (`material['precompile']('x')`) is intentionally
 *     NOT matched. Authors write `.precompile(...)` — the marker is literal
 *     syntax, not a dynamic property.
 *   - Non-literal arguments (`precompile(name)` where `name` is a variable)
 *     produce a build-time error. The whole staleness gate depends on the
 *     name being statically resolvable.
 *
 * @module BabelTransform
 */

import { parse } from '@babel/parser';
import _traverse from '@babel/traverse';
import _generate from '@babel/generator';
import * as t from '@babel/types';
import MagicString from 'magic-string';

import { MARKER_METHOD_NAME, VIRTUAL_MODULE_PREFIX } from './_shared/constants.js';

// ESM default-interop nits: Babel's generator/traverse ship CJS defaults.
const traverse = _traverse.default || _traverse;
const generate = _generate.default || _generate;

const APPLY_IMPORT_SPECIFIER = '@tsl-precompile/runtime/apply';
const APPLY_FN_NAME = '__applyPrecompiled';

/**
 * Transform a single source file.
 *
 * @param {string} source - User source (ES module).
 * @param {Object} opts
 * @param {string} opts.filename
 * @param {(name: string) => ?{ hash: string }} opts.resolveArtifact
 *     Looks up an artifact by name from the manifest. Returns null if no
 *     artifact has been captured yet — in which case the transform emits
 *     a clear build-time error at the call site.
 * @returns {{ code: string, map: ?Object, touchedNames: string[] }}
 */
export function transformSource( source, opts ) {

	const { filename, resolveArtifact } = opts;

	// Cheap early-out: skip files that don't mention the marker name.
	if ( ! source.includes( '.' + MARKER_METHOD_NAME ) ) {

		return { code: source, map: null, touchedNames: [] };

	}

	const ast = parse( source, {
		sourceType: 'module',
		sourceFilename: filename,
		plugins: [ 'jsx', 'typescript', 'importAttributes', 'topLevelAwait' ],
		errorRecovery: false,
	} );

	const touchedNames = [];
	const neededImports = [];   // [{ identifier, specifier }]

	traverse( ast, {
		CallExpression( path ) {

			const callee = path.node.callee;
			if ( ! t.isMemberExpression( callee ) ) return;
			if ( callee.computed ) return;
			if ( ! t.isIdentifier( callee.property, { name: MARKER_METHOD_NAME } ) ) return;

			const args = path.node.arguments;
			if ( args.length !== 1 ) {

				throwBuildError( filename, path, `.precompile(name) takes exactly one argument, got ${ args.length }.` );

			}

			const nameArg = args[ 0 ];
			if ( ! t.isStringLiteral( nameArg ) ) {

				throwBuildError( filename, path, '.precompile(name) requires a string literal. Dynamic names break the staleness hash and the build-time rewrite.' );

			}

			const name = nameArg.value;
			const artifact = resolveArtifact( name );
			if ( ! artifact ) {

				throwBuildError( filename, path, `.precompile(${ JSON.stringify( name ) }): no captured artifact found. Run dev mode once to capture it, then rebuild.` );

			}

			const materialExpr = callee.object;
			const artifactIdentName = `__tsl_art_${ sanitizeIdent( name ) }`;
			const specifier = VIRTUAL_MODULE_PREFIX + name;

			if ( ! neededImports.some( ( x ) => x.identifier === artifactIdentName ) ) {

				neededImports.push( { identifier: artifactIdentName, specifier } );

			}

			// Replace the CallExpression with __applyPrecompiled(materialExpr, __tsl_art_<name>, '<hash>').
			path.replaceWith( t.callExpression(
				t.identifier( APPLY_FN_NAME ),
				[
					materialExpr,
					t.identifier( artifactIdentName ),
					t.stringLiteral( artifact.hash ),
				],
			) );

			touchedNames.push( name );

		},
	} );

	if ( touchedNames.length === 0 ) {

		return { code: source, map: null, touchedNames: [] };

	}

	// Hoist required imports to the top.
	const importNodes = [];
	importNodes.push( t.importDeclaration(
		[ t.importSpecifier( t.identifier( APPLY_FN_NAME ), t.identifier( APPLY_FN_NAME ) ) ],
		t.stringLiteral( APPLY_IMPORT_SPECIFIER ),
	) );
	for ( const { identifier, specifier } of neededImports ) {

		importNodes.push( t.importDeclaration(
			[ t.importNamespaceSpecifier( t.identifier( identifier ) ) ],
			t.stringLiteral( specifier ),
		) );

	}
	ast.program.body.unshift( ...importNodes );

	const output = generate( ast, { sourceMaps: true, sourceFileName: filename }, source );

	return {
		code: output.code,
		map: output.map,
		touchedNames,
	};

}

function sanitizeIdent( name ) {

	return name.replace( /[^a-zA-Z0-9_]/g, '_' );

}

function throwBuildError( filename, path, message ) {

	const loc = path.node.loc;
	const locStr = loc ? `${ loc.start.line }:${ loc.start.column }` : '';
	const err = new Error( `[tsl-precompile] ${ filename }:${ locStr } ${ message }` );
	err.frame = path.buildCodeFrameError ? path.buildCodeFrameError( message ).message : message;
	throw err;

}
