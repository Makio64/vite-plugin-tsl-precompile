/**
 * Auto-mark transform.
 *
 * When the plugin is configured with `autoMark: true`, rewrite every
 * `new *NodeMaterial(...)` call site to chain `.precompile('auto-<id>')`.
 * This lets the batch harness drive unmodified three.js examples through
 * the precompile path without editing each example's source.
 *
 * Behaviour is deliberately scoped:
 *
 *   - Only `NewExpression` nodes whose callee is an Identifier ending in
 *     `NodeMaterial` are rewritten. Computed callees (`new obj.Thing()`),
 *     template-string invocations, etc. are ignored.
 *   - Names include a stable root-relative source-path identity plus a
 *     per-file counter, so equal basenames in different folders cannot
 *     overwrite one another.
 *   - Already-chained `.precompile(...)` calls (the author or a prior
 *     transform pass already did it) are left alone.
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

/**
 * @param {string} source
 * @param {Object} opts
 * @param {string} opts.filename
 * @param {string} [opts.root=process.cwd()] - Project root used for stable path identity.
 * @param {string} [opts.namePrefix='auto'] - Per-file prefix for the generated artifact names.
 * @return {{ code: string, map: ?Object, injectedNames: string[] }}
 */
export function autoMarkSource( source, opts ) {

	const { filename, namePrefix = 'auto', root = process.cwd() } = opts;

	// Cheap early-out: skip files with no NodeMaterial constructors.
	if ( ! /NodeMaterial\b/.test( source ) ) {

		return { code: source, map: null, injectedNames: [] };

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
			if ( t.isMemberExpression( parent ) && t.isIdentifier( parent.property, { name: 'precompile' } ) ) {

				return;

			}

			const name = `${ prefix }-${ slug }-${ pathIdentity }-${ counter ++ }`;
			injectedNames.push( name );

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

		return { code: source, map: null, injectedNames: [] };

	}

	const output = generate( ast, { sourceMaps: true, sourceFileName: filename }, source );
	return { code: output.code, map: output.map, injectedNames };

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
