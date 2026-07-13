/**
 * Babel transform: rewrite `.precompile('name')` call sites.
 *
 * Build-mode:  material.precompile('ocean-water')
 *              →  __applyPrecompiled(material, __art_ocean_water, 'sha256:...')
 *              with `import * as __art_ocean_water from 'virtual:tsl-precompile/ocean-water'`
 *              + `import { __applyPrecompiled } from '@tsl-precompile/runtime/apply'` hoisted.
 *
 * Dev mode: leave the call in place, but append a private stable source
 * identity so the capture server can reject duplicate artifact names.
 *
 * Scope:
 *   - Looks for CallExpression nodes whose callee is a MemberExpression
 *     named exactly `precompile` with a string-literal name and an optional
 *     explicit dev-capture context argument.
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

import { MARKER_METHOD_NAME, VIRTUAL_MODULE_PREFIX } from './_shared/constants.js';
import { canonicalModuleIdentity, markerSourceRevision } from './_shared/module-identity.js';

// ESM default-interop nits: Babel's generator/traverse ship CJS defaults.
const traverse = _traverse.default || _traverse;
const generate = _generate.default || _generate;

const APPLY_IMPORT_SPECIFIER = '@tsl-precompile/runtime/apply';
const APPLY_FN_NAME = '__applyPrecompiled';
const NODE_DEPENDENCY_IMPORT_SPECIFIER = '@tsl-precompile/runtime/slim-support/node-dependencies';
const ATTACH_NODE_DEPENDENCY_FN_NAME = 'attachLiveNodeDependency';
const PARSER_PLUGINS = [
	'jsx',
	'typescript',
	'decorators-legacy',
	'importAttributes',
	'deprecatedImportAssert',
	'topLevelAwait',
];

/**
 * Preserve inputs hidden inside three.js's builtin AO/shadow context closures.
 * The wrapper keeps the user's local binding name and renames only the imported
 * implementation, so every existing call site gains a non-serializable live
 * dependency edge without source-level API changes.
 */
export function instrumentLiveContextDependencies( source, { filename } ) {

	if ( ! source.includes( 'three/tsl' ) ) return { code: source, map: null, touched: false };
	if ( ! source.includes( 'builtinAOContext' ) && ! source.includes( 'builtinShadowContext' ) ) return { code: source, map: null, touched: false };
	const ast = parse( source, {
		sourceType: 'module',
		sourceFilename: filename,
		plugins: PARSER_PLUGINS,
		errorRecovery: false,
	} );
	const occupiedIdentifiers = collectBindingNames( ast );
	const wrappers = [];
	let attachName = null;

	for ( const statement of ast.program.body ) {

		if ( ! t.isImportDeclaration( statement ) || statement.source.value !== 'three/tsl' ) continue;
		for ( const specifier of statement.specifiers ) {

			if ( ! t.isImportSpecifier( specifier ) || ! t.isIdentifier( specifier.imported ) ) continue;
			const importedName = specifier.imported.name;
			if ( importedName !== 'builtinAOContext' && importedName !== 'builtinShadowContext' ) continue;

			if ( attachName === null ) attachName = allocateIdentifier( '__tslpAttachLiveNodeDependency', 'live-context-dependency', occupiedIdentifiers );
			const publicLocalName = specifier.local.name;
			const implementationName = allocateIdentifier( `__tslp_${ importedName }`, `live-context:${ publicLocalName }`, occupiedIdentifiers );
			specifier.local = t.identifier( implementationName );

			const argsName = allocateIdentifier( '__tslp_context_args', `live-context-args:${ publicLocalName }`, occupiedIdentifiers );
			const resultName = allocateIdentifier( '__tslp_context_node', `live-context-result:${ publicLocalName }`, occupiedIdentifiers );
			const args = t.identifier( argsName );
			const result = t.identifier( resultName );
			const metadataProperties = [ t.objectProperty( t.identifier( 'role' ), t.stringLiteral( importedName === 'builtinAOContext' ? 'ambient-occlusion' : 'shadow' ) ) ];
			if ( importedName === 'builtinShadowContext' ) {

				metadataProperties.push( t.objectProperty( t.identifier( 'light' ), t.memberExpression( args, t.numericLiteral( 1 ), true ) ) );

			}
			wrappers.push( t.variableDeclaration( 'const', [
				t.variableDeclarator(
					t.identifier( publicLocalName ),
					t.arrowFunctionExpression( [ t.restElement( args ) ], t.blockStatement( [
						t.variableDeclaration( 'const', [ t.variableDeclarator( result, t.callExpression( t.identifier( implementationName ), [ t.spreadElement( args ) ] ) ) ] ),
						t.expressionStatement( t.callExpression( t.identifier( attachName ), [
							result,
							t.memberExpression( args, t.numericLiteral( 0 ), true ),
							t.objectExpression( metadataProperties ),
						] ) ),
						t.returnStatement( result ),
					] ) ),
				),
			] ) );

		}

	}

	if ( wrappers.length === 0 ) return { code: source, map: null, touched: false };
	ast.program.body.unshift( t.importDeclaration( [
		t.importSpecifier( t.identifier( attachName ), t.identifier( ATTACH_NODE_DEPENDENCY_FN_NAME ) ),
	], t.stringLiteral( NODE_DEPENDENCY_IMPORT_SPECIFIER ) ) );
	let insertAt = 0;
	while ( insertAt < ast.program.body.length && t.isImportDeclaration( ast.program.body[ insertAt ] ) ) insertAt ++;
	ast.program.body.splice( insertAt, 0, ...wrappers );

	const output = generate( ast, { sourceMaps: true, sourceFileName: filename }, source );
	return { code: output.code, map: output.map, touched: true };

}
/**
 * Stamp dev-only marker calls with a stable call-site identity. The runtime
 * forwards it to the capture server so two different files cannot silently
 * overwrite the same artifact name. Production builds start from the original
 * source and use transformSource(), so this private third argument never
 * becomes author-facing API.
 */
export function annotateDevMarkerSources( source, { filename, root = process.cwd() } ) {

	if ( ! source.includes( '.' + MARKER_METHOD_NAME ) ) return { code: source, map: null, touched: false };
	const ast = parse( source, {
		sourceType: 'module',
		sourceFilename: filename,
		plugins: PARSER_PLUGINS,
		errorRecovery: false,
	} );
	const { moduleIdentity } = canonicalModuleIdentity( filename, root );
	const sourceRevision = markerSourceRevision( source );
	const callIndexesByName = new Map();
	let touched = false;

	traverse( ast, {
		CallExpression( path ) {

			const callee = path.node.callee;
			if ( ! t.isMemberExpression( callee ) || callee.computed || ! t.isIdentifier( callee.property, { name: MARKER_METHOD_NAME } ) ) return;
			if ( path.node.arguments.length < 1 || path.node.arguments.length > 2 ) return;
			// Line/column coordinates are deliberately excluded: inserting an
			// unrelated line above a marker must not turn the next capture into a
			// false name collision. Artifact names are manifest keys, so an ordinal
			// among calls using the same literal name is enough to distinguish two
			// competing call sites in one file while remaining stable as code moves.
			const nameArg = path.node.arguments[ 0 ];
			const nameKey = t.isStringLiteral( nameArg ) ? `literal:${ nameArg.value }` : 'dynamic';
			const callIndex = callIndexesByName.get( nameKey ) || 0;
			callIndexesByName.set( nameKey, callIndex + 1 );
			// Keep the private arguments positional. Without an author context,
			// insert null so the source identity remains the third argument.
			if ( path.node.arguments.length === 1 ) path.node.arguments.push( t.nullLiteral() );
			path.node.arguments.push(
				t.stringLiteral( `${ moduleIdentity }:precompile:${ callIndex }` ),
				t.stringLiteral( sourceRevision ),
			);
			touched = true;

		},
	} );
	if ( ! touched ) return { code: source, map: null, touched: false };
	const output = generate( ast, { sourceMaps: true, sourceFileName: filename }, source );
	return { code: output.code, map: output.map, touched: true };

}

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

	const { filename, resolveArtifact, root = process.cwd() } = opts;

	// Cheap early-out: skip files that don't mention the marker name.
	if ( ! source.includes( '.' + MARKER_METHOD_NAME ) ) {

		return { code: source, map: null, touchedNames: [] };

	}

	const ast = parse( source, {
		sourceType: 'module',
		sourceFilename: filename,
		plugins: PARSER_PLUGINS,
		errorRecovery: false,
	} );

	const touchedNames = [];
	const neededImports = new Map(); // raw artifact name → { identifier, specifier }
	const occupiedIdentifiers = collectBindingNames( ast );
	const applyFnName = allocateIdentifier( APPLY_FN_NAME, 'runtime-apply', occupiedIdentifiers );
	const { moduleIdentity } = canonicalModuleIdentity( filename, root );
	const sourceRevision = markerSourceRevision( source );
	const callIndexesByName = new Map();

	traverse( ast, {
		CallExpression( path ) {

			const callee = path.node.callee;
			if ( ! t.isMemberExpression( callee ) ) return;
			if ( callee.computed ) return;
			if ( ! t.isIdentifier( callee.property, { name: MARKER_METHOD_NAME } ) ) return;

			const args = path.node.arguments;
			if ( args.length < 1 || args.length > 2 ) {

				throwBuildError( filename, path, `.precompile(name, context?) takes one or two arguments, got ${ args.length }.` );

			}

			const nameArg = args[ 0 ];
			if ( ! t.isStringLiteral( nameArg ) ) {

				throwBuildError( filename, path, '.precompile(name) requires a string literal. Dynamic names break the staleness hash and the build-time rewrite.' );

			}

			const name = nameArg.value;
			const nameKey = `literal:${ name }`;
			const callIndex = callIndexesByName.get( nameKey ) || 0;
			callIndexesByName.set( nameKey, callIndex + 1 );
			const sourceIdentity = `${ moduleIdentity }:precompile:${ callIndex }`;
			const artifact = resolveArtifact( name );
			if ( ! artifact ) {

				throwBuildError( filename, path, `.precompile(${ JSON.stringify( name ) }): no captured artifact found. Run dev mode once to capture it, then rebuild.` );

			}
			if ( Array.isArray( artifact.sourceOwners ) && artifact.sourceOwners.length > 0 ) {

				const owner = artifact.sourceOwners.find( ( candidate ) => candidate && candidate.identity === sourceIdentity );
				if ( ! owner ) {

					throwBuildError( filename, path, `.precompile(${ JSON.stringify( name ) }) was not captured from this call site (${ sourceIdentity }). Run dev mode once, or use a unique project-global artifact name.` );

				}
				if ( owner.revision !== sourceRevision ) {

					throwBuildError( filename, path, `.precompile(${ JSON.stringify( name ) }) source changed since capture. Run dev mode once to refresh the artifact before building.` );

				}

			}

			const materialExpr = callee.object;
			const specifier = VIRTUAL_MODULE_PREFIX + name;
			let artifactImport = neededImports.get( name );

			if ( ! artifactImport ) {

				const artifactIdentName = allocateIdentifier( `__tsl_art_${ sanitizeIdent( name ) }`, `artifact:${ name }`, occupiedIdentifiers );
				artifactImport = { identifier: artifactIdentName, specifier };
				neededImports.set( name, artifactImport );

			}

			// Replace the CallExpression with __applyPrecompiled(materialExpr, __tsl_art_<name>, '<hash>').
			const createApplyCall = ( materialValue ) => t.callExpression(
				t.identifier( applyFnName ),
				[ materialValue, t.identifier( artifactImport.identifier ), t.stringLiteral( artifact.hash ) ],
			);

			if ( args.length === 2 ) {

				const contextArg = args[ 1 ];
				if ( t.isSpreadElement( contextArg ) || t.isArgumentPlaceholder( contextArg ) ) {

					throwBuildError( filename, path, '.precompile(name, context) requires a normal expression for context, not a spread argument.' );

				}
				// Production hydration does not consume capture context, but the original
				// member call evaluates its receiver before its arguments. A tiny arrow
				// wrapper preserves that order and evaluates a side-effectful receiver
				// exactly once.
				const materialParam = t.identifier( '__tslp_material' );
				const contextParam = t.identifier( '__tslp_context' );
				path.replaceWith( t.callExpression(
					t.arrowFunctionExpression( [ materialParam, contextParam ], createApplyCall( materialParam ) ),
					[ materialExpr, contextArg ],
				) );

			} else {

				path.replaceWith( createApplyCall( materialExpr ) );

			}

			touchedNames.push( name );

		},
	} );

	if ( touchedNames.length === 0 ) {

		return { code: source, map: null, touchedNames: [] };

	}

	// Hoist required imports to the top.
	const importNodes = [];
	importNodes.push( t.importDeclaration(
		[ t.importSpecifier( t.identifier( applyFnName ), t.identifier( APPLY_FN_NAME ) ) ],
		t.stringLiteral( APPLY_IMPORT_SPECIFIER ),
	) );
	for ( const { identifier, specifier } of neededImports.values() ) {

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

function collectBindingNames( ast ) {

	const names = new Set();
	const seenScopes = new Set();
	traverse( ast, {
		enter( path ) {

			if ( ! path.scope || seenScopes.has( path.scope ) || ! path.scope.bindings ) return;
			seenScopes.add( path.scope );
			for ( const name of Object.keys( path.scope.bindings ) ) names.add( name );

		},
	} );
	return names;

}

function allocateIdentifier( preferred, stableKey, occupied ) {

	if ( ! occupied.has( preferred ) ) {

		occupied.add( preferred );
		return preferred;

	}

	// The raw artifact name participates in the suffix, while the Set makes
	// the result strictly collision-free even if two suffixes ever coincide.
	const suffix = stableIdentifierSuffix( stableKey );
	let candidate = `${ preferred }_${ suffix }`;
	let counter = 2;
	while ( occupied.has( candidate ) ) candidate = `${ preferred }_${ suffix }_${ counter ++ }`;
	occupied.add( candidate );
	return candidate;

}

function stableIdentifierSuffix( value ) {

	// 64-bit FNV-1a is deterministic across Node versions and requires no
	// crypto/runtime dependency in this hot transform module.
	let hash = 0xcbf29ce484222325n;
	for ( const byte of Buffer.from( value, 'utf8' ) ) {

		hash ^= BigInt( byte );
		hash = BigInt.asUintN( 64, hash * 0x100000001b3n );

	}
	return hash.toString( 16 ).padStart( 16, '0' );

}

function throwBuildError( filename, path, message ) {

	const loc = path.node.loc;
	const locStr = loc ? `${ loc.start.line }:${ loc.start.column }` : '';
	const err = new Error( `[tsl-precompile] ${ filename }:${ locStr } ${ message }` );
	err.frame = path.buildCodeFrameError ? path.buildCodeFrameError( message ).message : message;
	throw err;

}
