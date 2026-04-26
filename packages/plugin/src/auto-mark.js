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
 *   - Names are generated from a per-file counter so the same example
 *     run twice produces stable artifact names.
 *   - Already-chained `.precompile(...)` calls (the author or a prior
 *     transform pass already did it) are left alone.
 *
 * @module AutoMark
 */

import { parse } from '@babel/parser';
import _traverse from '@babel/traverse';
import _generate from '@babel/generator';
import * as t from '@babel/types';

const traverse = _traverse.default || _traverse;
const generate = _generate.default || _generate;

/**
 * @param {string} source
 * @param {Object} opts
 * @param {string} opts.filename
 * @param {string} [opts.namePrefix='auto'] - Per-file prefix for the generated artifact names.
 * @return {{ code: string, map: ?Object, injectedNames: string[] }}
 */
export function autoMarkSource( source, opts ) {

	const { filename, namePrefix = 'auto' } = opts;

	// Cheap early-out: skip files with no NodeMaterial constructors.
	if ( ! /NodeMaterial\b/.test( source ) ) {

		return { code: source, map: null, injectedNames: [] };

	}

	const ast = parse( source, {
		sourceType: 'module',
		sourceFilename: filename,
		plugins: [ 'jsx', 'typescript', 'importAttributes', 'topLevelAwait' ],
		errorRecovery: true,
	} );

	const slug = slugifyFilename( filename );
	const injectedNames = [];
	let counter = 0;

	traverse( ast, {
		NewExpression( path ) {

			const callee = path.node.callee;
			if ( ! t.isIdentifier( callee ) ) return;
			if ( ! /NodeMaterial$/.test( callee.name ) ) return;

			// If the parent is a MemberExpression with property === 'precompile',
			// the author already marked this construction; skip.
			const parent = path.parent;
			if ( t.isMemberExpression( parent ) && t.isIdentifier( parent.property, { name: 'precompile' } ) ) {

				return;

			}

			const name = `${ namePrefix }-${ slug }-${ counter ++ }`;
			injectedNames.push( name );

			// Wrap the NewExpression in .precompile('name'). The wrapped
			// expression replaces the original NewExpression in the parent.
			path.replaceWith( t.callExpression(
				t.memberExpression(
					path.node,
					t.identifier( 'precompile' ),
				),
				[ t.stringLiteral( name ) ],
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
	return base.replace( /\.[^.]+$/, '' ).replace( /[^a-zA-Z0-9_]/g, '_' ).slice( 0, 40 );

}
