/**
 * Auto-mark transform.
 *
 * By default (or when configured with `autoMark: true`), rewrite every
 * `new *NodeMaterial(...)` call site to chain `.precompile('auto-<id>')`.
 * This lets applications and the batch harness drive unmodified three.js
 * source through the precompile path without per-material edits.
 *
 * Behaviour is deliberately scoped:
 *
 *   - Only `NewExpression` nodes whose callee is an Identifier ending in
 *     `NodeMaterial` are rewritten. Computed callees (`new obj.Thing()`),
 *     template-string invocations, etc. are ignored.
 *   - Names include a stable root-relative source-path identity plus a
 *     per-file counter, so equal basenames in different folders cannot
 *     overwrite one another.
 *   - Already-chained `.precompile(...)` calls and stable local bindings that
 *     are explicitly marked later in the module are left alone.
 *
 * @module AutoMark
 */

import { parse } from '@babel/parser';
import _traverse from '@babel/traverse';
import _generate from '@babel/generator';
import * as t from '@babel/types';
import { createHash } from 'node:crypto';

import { canonicalModuleIdentity } from './_shared/module-identity.js';

const traverse = _traverse.default || _traverse;
const generate = _generate.default || _generate;
export const AUTO_MARKER_IMPORT = '@tsl-precompile/runtime/auto-marker';

function hasMarkerBootstrapImport( ast ) {

	return ast.program.body.some( ( statement ) =>
		t.isImportDeclaration( statement ) && statement.source.value === AUTO_MARKER_IMPORT
	);

}

function prependMarkerBootstrapImport( ast ) {

	if ( hasMarkerBootstrapImport( ast ) ) return false;
	ast.program.body.unshift( t.importDeclaration( [], t.stringLiteral( AUTO_MARKER_IMPORT ) ) );
	return true;

}

function memberPropertyName( member ) {

	if ( ! t.isMemberExpression( member ) ) return null;
	if ( member.computed ) return t.isStringLiteral( member.property ) ? member.property.value : null;
	return t.isIdentifier( member.property ) ? member.property.name : null;

}

function bindingHasExplicitPrecompileCall( newExpressionPath ) {

	const declarator = newExpressionPath.parentPath;
	if ( ! declarator?.isVariableDeclarator() || declarator.node.init !== newExpressionPath.node ) return false;
	const id = declarator.get( 'id' );
	if ( ! id.isIdentifier() ) return false;

	const binding = declarator.scope.getBinding( id.node.name );
	if ( ! binding || binding.identifier !== id.node || ! binding.constant ) return false;

	return binding.referencePaths.some( ( reference ) => {

		const member = reference.parentPath;
		if ( ! member?.isMemberExpression() || member.node.object !== reference.node ) return false;
		if ( memberPropertyName( member.node ) !== 'precompile' ) return false;
		const call = member.parentPath;
		return call?.isCallExpression() === true && call.node.callee === member.node;

	} );

}

/**
 * @param {string} source
 * @param {Object} opts
 * @param {string} opts.filename
 * @param {string} [opts.root=process.cwd()] - Project root used for stable path identity.
 * @param {string} [opts.namePrefix='auto'] - Per-file prefix for the generated artifact names.
 * @return {{
 *   code: string,
 *   map: ?Object,
 *   injectedNames: string[],
 *   injectedMarkers: Array<{ name: string, line: number, column: number }>
 * }}
 */
export function autoMarkSource( source, opts ) {

	const { filename, namePrefix = 'auto', root = process.cwd() } = opts;

	// Cheap early-out: skip files with no NodeMaterial constructors.
	if ( ! /NodeMaterial\b/.test( source ) ) {

		return { code: source, map: null, injectedNames: [], injectedMarkers: [] };

	}

	const ast = parse( source, {
		sourceType: 'module',
		sourceFilename: filename,
		plugins: [ 'jsx', 'typescript', 'decorators-legacy', 'importAttributes', 'deprecatedImportAssert', 'topLevelAwait' ],
		errorRecovery: true,
	} );

	const { moduleIdentity, relativeFile } = canonicalModuleIdentity( filename, root );
	const slug = slugifyFilename( relativeFile );
	const pathIdentity = createHash( 'sha256' ).update( moduleIdentity ).digest( 'hex' ).slice( 0, 12 );
	const prefix = slugifySegment( namePrefix, 32 ) || 'auto';
	const injectedNames = [];
	const injectedMarkers = [];
	let counter = 0;

	traverse( ast, {
		NewExpression( path ) {

			const callee = path.node.callee;
			let calleeName = '';
			if ( t.isIdentifier( callee ) ) {

				calleeName = callee.name;

			} else if ( t.isMemberExpression( callee ) && ! callee.computed && t.isIdentifier( callee.property ) ) {

				calleeName = callee.property.name;

			}
			if ( ! calleeName || ! /NodeMaterial$/.test( calleeName ) ) return;

			// If the parent is a MemberExpression with property === 'precompile',
			// the author already marked this construction; skip.
			const parent = path.parent;
			if (
				( t.isMemberExpression( parent ) && memberPropertyName( parent ) === 'precompile' )
				|| bindingHasExplicitPrecompileCall( path )
			) {

				return;

			}

			const name = `${ prefix }-${ slug }-${ pathIdentity }-${ counter ++ }`;
			injectedNames.push( name );
			injectedMarkers.push( {
				name,
				line: path.node.loc?.start.line || 1,
				column: ( path.node.loc?.start.column || 0 ) + 1,
			} );

			// Wrap the NewExpression in .precompile('name', { __tslpAutoMark:
			// true }). The private hint lets the runtime fall back only for an
			// auto-marked helper material that never appears in a real render;
			// ordinary author markers remain strict about real render context.
			path.replaceWith( t.callExpression(
				t.memberExpression(
					path.node,
					t.identifier( 'precompile' ),
				),
				[
					t.stringLiteral( name ),
					t.objectExpression( [ t.objectProperty( t.identifier( '__tslpAutoMark' ), t.booleanLiteral( true ) ) ] ),
				],
			) );

			// Prevent re-visiting the new CallExpression's child (the
			// NewExpression we just wrapped) — otherwise Babel would recurse
			// and double-wrap.
			path.skip();

		},
	} );

	if ( injectedNames.length === 0 ) {

		return { code: source, map: null, injectedNames: [], injectedMarkers: [] };

	}

	// Imported scene/material modules execute before the importing bootstrap
	// module's setupPrecompile() call. Install the dev marker as a side effect
	// in every module that received an automatic marker so eager constructors
	// cannot race setup. The runtime export resolves to an empty, tree-shakeable
	// module in production builds, where the marker calls are rewritten away.
	prependMarkerBootstrapImport( ast );

	const output = generate( ast, { sourceMaps: true, sourceFileName: filename }, source );
	return { code: output.code, map: output.map, injectedNames, injectedMarkers };

}

/**
 * Ensure authored marker modules also install Material.precompile before any
 * eager top-level constructor/call executes. This runs independently of the
 * automatic-constructor option, so `autoMark: false` remains safe.
 */
export function injectMarkerBootstrapSource( source, opts = {} ) {

	if ( ! /\.precompile\s*\(/.test( source ) ) {

		return { code: source, map: null, touched: false };

	}
	const filename = opts.filename || 'unknown.js';
	const ast = parse( source, {
		sourceType: 'module',
		sourceFilename: filename,
		plugins: [ 'jsx', 'typescript', 'decorators-legacy', 'importAttributes', 'deprecatedImportAssert', 'topLevelAwait' ],
		errorRecovery: true,
	} );
	let ownsMarker = false;
	traverse( ast, {
		CallExpression( path ) {

			const callee = path.node.callee;
			if ( ! t.isMemberExpression( callee ) || memberPropertyName( callee ) !== 'precompile' ) return;
			ownsMarker = true;
			path.stop();

		},
	} );
	if ( ! ownsMarker || ! prependMarkerBootstrapImport( ast ) ) return { code: source, map: null, touched: false };
	const output = generate( ast, { sourceMaps: true, sourceFileName: filename }, source );
	return { code: output.code, map: output.map, touched: true };

}

function slugifyFilename( filename ) {

	// Keep it short: take the basename minus extension, strip non-word chars.
	const base = String( filename ).split( /[\\/]/ ).pop() || 'anon';
	return slugifySegment( base.replace( /\.[^.]+$/, '' ), 40 ) || 'anon';

}

function slugifySegment( value, maxLength ) {

	return String( value )
		.replace( /[^a-zA-Z0-9_-]/g, '_' )
		.replace( /_+/g, '_' )
		.replace( /^[_-]+|[_-]+$/g, '' )
		.slice( 0, maxLength );

}
