/**
 * Babel transform: rewrite `.precompile('name')` call sites.
 *
 * Build-mode:  material.precompile('ocean-water')
 *              →  __applyPrecompiled(material, __art_ocean_water, 'sha256:...')
 *              with `import * as __art_ocean_water from 'virtual:tsl-precompile/ocean-water'`
 *              + a mode-owned `__applyPrecompiled` import hoisted (`/apply`
 *                for slim replay, `/apply/full` for full Three).
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

import { createLiveUniformCallsiteIdentity } from '@tsl-precompile/contract/dynamic-bindings';
import { MARKER_METHOD_NAME, VIRTUAL_MODULE_PREFIX } from './_shared/constants.js';
import { canonicalModuleIdentity, markerSourceRevision } from './_shared/module-identity.js';

// ESM default-interop nits: Babel's generator/traverse ship CJS defaults.
const traverse = _traverse.default || _traverse;
const generate = _generate.default || _generate;

const APPLY_IMPORT_SPECIFIER = '@tsl-precompile/runtime/apply';
const APPLY_FN_NAME = '__applyPrecompiled';
const NODE_DEPENDENCY_IMPORT_SPECIFIER = '@tsl-precompile/runtime/slim-support/node-dependencies';
const ATTACH_NODE_DEPENDENCY_FN_NAME = 'attachLiveNodeDependency';
const LIVE_UNIFORM_REGISTRY_IMPORT_SPECIFIER = '@tsl-precompile/runtime/slim-support/live-uniform-registry';
const REGISTER_LIVE_UNIFORM_FN_NAME = 'registerLiveUniformNode';
const LIVE_UNIFORM_IMPORT_SOURCES = new Set( [ 'three/tsl', 'three/webgpu' ] );
const PARSER_PLUGINS = [
	'jsx',
	'typescript',
	'decorators-legacy',
	'importAttributes',
	'deprecatedImportAssert',
	'topLevelAwait',
];

/**
 * Stamp direct `uniform()` calls with a stable module/call-site identity and
 * a module-local occurrence. Anonymous UniformNodes can live only inside an
 * `Fn()` closure, so neither the material graph nor a JSON artifact retains
 * enough ownership evidence to reconnect two equal-valued instances. The
 * same transform runs in capture and build; whole-module revision validation
 * makes the call-site numbering part of the existing freshness contract.
 */
export function instrumentLiveUniformIdentities( source, { filename, root = process.cwd() } ) {

	if ( ! source.includes( 'uniform' ) ) return { code: source, map: null, touched: false };
	if ( ! [ ...LIVE_UNIFORM_IMPORT_SOURCES ].some( ( specifier ) => source.includes( specifier ) ) ) return { code: source, map: null, touched: false };
	const ast = parse( source, {
		sourceType: 'module',
		sourceFilename: filename,
		plugins: PARSER_PLUGINS,
		errorRecovery: false,
	} );
	const calls = [];
	traverse( ast, {
		CallExpression( path ) {

			let bindingName = null;
			let expectedImport = null;
			if ( t.isIdentifier( path.node.callee ) ) {

				bindingName = path.node.callee.name;
				expectedImport = 'uniform';

			} else if ( t.isMemberExpression( path.node.callee ) && t.isIdentifier( path.node.callee.object ) ) {

				const property = path.node.callee.computed
					? t.isStringLiteral( path.node.callee.property ) ? path.node.callee.property.value : null
					: t.isIdentifier( path.node.callee.property ) ? path.node.callee.property.name : null;
				if ( property !== 'uniform' ) return;
				bindingName = path.node.callee.object.name;
				expectedImport = 'namespace';

			} else return;
			const binding = path.scope.getBinding( bindingName );
			if ( ! binding || ! binding.path ) return;
			const declaration = binding.path.parentPath;
			if ( ! declaration || ! declaration.isImportDeclaration() || ! LIVE_UNIFORM_IMPORT_SOURCES.has( declaration.node.source.value ) ) return;
			if ( expectedImport === 'uniform' ) {

				if ( ! binding.path.isImportSpecifier() || ! t.isIdentifier( binding.path.node.imported, { name: 'uniform' } ) ) return;

			} else {

				const namespaceImport = binding.path.isImportNamespaceSpecifier();
				const tslNamespaceImport = binding.path.isImportSpecifier()
					&& t.isIdentifier( binding.path.node.imported, { name: 'TSL' } );
				if ( ! namespaceImport && ! tslNamespaceImport ) return;

			}
			calls.push( path );

		},
	} );
	if ( calls.length === 0 ) return { code: source, map: null, touched: false };

	const occupiedIdentifiers = collectBindingNames( ast );
	const registerName = allocateIdentifier( '__tslpRegisterLiveUniformNode', 'live-uniform-register', occupiedIdentifiers );
	const { moduleIdentity } = canonicalModuleIdentity( filename, root );
	const replacements = calls.map( ( path, callIndex ) => ( {
		path,
		callIndex,
		counterName: allocateIdentifier( `__tslpUniformOccurrence${ callIndex }`, `live-uniform-counter:${ callIndex }`, occupiedIdentifiers ),
		callsiteIdentity: createLiveUniformCallsiteIdentity( moduleIdentity, callIndex ),
	} ) );

	// Replace inner calls first so a nested `uniform(uniform(...))` retains
	// both identities when the outer expression is cloned into its wrapper.
	replacements.sort( ( a, b ) => ( b.path.node.start || 0 ) - ( a.path.node.start || 0 ) );
	for ( const replacement of replacements ) {

		const originalCall = t.cloneNode( replacement.path.node, true );
		replacement.path.replaceWith( t.callExpression( t.identifier( registerName ), [
			originalCall,
			t.stringLiteral( replacement.callsiteIdentity ),
			t.updateExpression( '++', t.identifier( replacement.counterName ), false ),
		] ) );

	}

	ast.program.body.unshift( t.importDeclaration( [
		t.importSpecifier( t.identifier( registerName ), t.identifier( REGISTER_LIVE_UNIFORM_FN_NAME ) ),
	], t.stringLiteral( LIVE_UNIFORM_REGISTRY_IMPORT_SPECIFIER ) ) );
	let insertAt = 0;
	while ( insertAt < ast.program.body.length && t.isImportDeclaration( ast.program.body[ insertAt ] ) ) insertAt ++;
	const counters = replacements
		.sort( ( a, b ) => a.callIndex - b.callIndex )
		.map( ( replacement ) => t.variableDeclaration( 'let', [
			t.variableDeclarator( t.identifier( replacement.counterName ), t.numericLiteral( 0 ) ),
		] ) );
	ast.program.body.splice( insertAt, 0, ...counters );

	const output = generate( ast, { sourceMaps: true, sourceFileName: filename }, source );
	return { code: output.code, map: output.map, touched: true };

}

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
export function annotateDevMarkerSources( source, {
	filename,
	root = process.cwd(),
	sourceRevision: providedSourceRevision = null,
} ) {

	if ( ! source.includes( '.' + MARKER_METHOD_NAME ) ) return { code: source, map: null, touched: false, sourceOwners: [] };
	const ast = parse( source, {
		sourceType: 'module',
		sourceFilename: filename,
		plugins: PARSER_PLUGINS,
		errorRecovery: false,
	} );
	const { moduleIdentity } = canonicalModuleIdentity( filename, root );
	const sourceRevision = providedSourceRevision || markerSourceRevision( source );
	const callIndexesByName = new Map();
	const sourceOwners = [];
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
			sourceOwners.push( {
				identity: `${ moduleIdentity }:precompile:${ callIndex }`,
				revision: sourceRevision,
			} );
			touched = true;

		},
	} );
	if ( ! touched ) return { code: source, map: null, touched: false, sourceOwners: [] };
	const output = generate( ast, { sourceMaps: true, sourceFileName: filename }, source );
	return { code: output.code, map: output.map, touched: true, sourceOwners };

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
 * @param {(name: string, marker: { autoMarked: boolean, sourceIdentity: string }) => boolean} [opts.shouldFallbackMissingArtifact]
 *     Full-Three compatibility escape hatch. When true for a missing name,
 *     replace only that marker with its live material expression and report
 *     a warning while continuing to transform captured siblings.
 * @param {string} [opts.applyImportSpecifier='@tsl-precompile/runtime/apply']
 *     Build-mode-owned apply entry. Full builds select `/apply/full` so stock
 *     Three retains the live NodeMaterial; slim builds select replay apply.
 * @returns {{ code: string, map: ?Object, touchedNames: string[], missingArtifacts: Array<{ name: string, message: string }> }}
 */
export function transformSource( source, opts ) {

	const {
		filename,
		resolveArtifact,
		root = process.cwd(),
		applyImportSpecifier = APPLY_IMPORT_SPECIFIER,
		shouldFallbackMissingArtifact = null,
		sourceRevision: providedSourceRevision = null,
		sourceProvenance = null,
	} = opts;

	// Cheap early-out: skip files that don't mention the marker name.
	if ( ! source.includes( '.' + MARKER_METHOD_NAME ) ) {

		return { code: source, map: null, touchedNames: [], missingArtifacts: [] };

	}

	const ast = parse( source, {
		sourceType: 'module',
		sourceFilename: filename,
		plugins: PARSER_PLUGINS,
		errorRecovery: false,
	} );

	const touchedNames = [];
	const missingArtifacts = [];
	const neededImports = new Map(); // raw artifact name → { identifier, specifier }
	const occupiedIdentifiers = collectBindingNames( ast );
	const applyFnName = allocateIdentifier( APPLY_FN_NAME, 'runtime-apply', occupiedIdentifiers );
	const { moduleIdentity } = canonicalModuleIdentity( filename, root );
	const sourceRevision = providedSourceRevision || markerSourceRevision( source );
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
			const materialExpr = callee.object;
			const contextArg = args.length === 2 ? args[ 1 ] : null;
			if ( t.isSpreadElement( contextArg ) || t.isArgumentPlaceholder( contextArg ) ) {

				throwBuildError( filename, path, '.precompile(name, context) requires a normal expression for context, not a spread argument.' );

			}
			const artifact = resolveArtifact( name );
			if ( ! artifact ) {

				const fallback = typeof shouldFallbackMissingArtifact === 'function'
					&& shouldFallbackMissingArtifact( name, {
						autoMarked: isAutoMarkedCaptureContext( contextArg ),
						sourceIdentity,
					} ) === true;
				if ( fallback ) {

					const message = `.precompile(${ JSON.stringify( name ) }): no captured artifact found; keeping the live NodeMaterial in full-Three compatibility mode. Capture this render path before enabling slim mode.`;
					missingArtifacts.push( {
						name,
						message: formatBuildDiagnostic( filename, path, message ),
					} );
					replaceMarkerWithMaterial( path, materialExpr, contextArg );
					return;

				}
				throwBuildError( filename, path, `.precompile(${ JSON.stringify( name ) }): no captured artifact found. Run dev mode once to capture it, then rebuild.` );

			}
			if (
				( artifact.sourceValidationMode === 'callsite' || sourceProvenance !== null )
				&& ( ! Array.isArray( artifact.sourceOwners ) || artifact.sourceOwners.length === 0 )
			) {

				throwBuildError( filename, path, `.precompile(${ JSON.stringify( name ) }) requires call-site dependency validation but has no captured source owner. Run dev mode once to recapture it with the current plugin.` );

			}
			if ( Array.isArray( artifact.sourceOwners ) && artifact.sourceOwners.length > 0 ) {

				const owner = artifact.sourceOwners.find( ( candidate ) => candidate && candidate.identity === sourceIdentity );
				if ( ! owner ) {

					throwBuildError( filename, path, `.precompile(${ JSON.stringify( name ) }) was not captured from this call site (${ sourceIdentity }). Run dev mode once, or use a unique project-global artifact name.` );

				}
				if (
					sourceProvenance !== null
					&& JSON.stringify( owner.provenance ) !== JSON.stringify( sourceProvenance )
				) {

					throwBuildError( filename, path, `.precompile(${ JSON.stringify( name ) }) project-local dependency closure differs from capture. Run dev mode once to refresh the artifact before building.` );

				}
				if ( owner.revision !== sourceRevision ) {

					throwBuildError( filename, path, `.precompile(${ JSON.stringify( name ) }) source changed since capture. Run dev mode once to refresh the artifact before building.` );

				}

			}

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

	if ( touchedNames.length === 0 && missingArtifacts.length === 0 ) {

		return { code: source, map: null, touchedNames: [], missingArtifacts: [] };

	}

	// Hoist required imports to the top.
	const importNodes = [];
	if ( touchedNames.length > 0 ) {

		importNodes.push( t.importDeclaration(
			[ t.importSpecifier( t.identifier( applyFnName ), t.identifier( APPLY_FN_NAME ) ) ],
			t.stringLiteral( applyImportSpecifier ),
		) );

	}
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
		missingArtifacts,
	};

}

function isAutoMarkedCaptureContext( contextArg ) {

	if ( ! t.isObjectExpression( contextArg ) ) return false;
	return contextArg.properties.some( ( property ) => {

		if ( ! t.isObjectProperty( property ) || property.computed ) return false;
		const key = t.isIdentifier( property.key )
			? property.key.name
			: t.isStringLiteral( property.key ) ? property.key.value : null;
		return key === '__tslpAutoMark' && t.isBooleanLiteral( property.value, { value: true } );

	} );

}

function replaceMarkerWithMaterial( path, materialExpr, contextArg ) {

	if ( contextArg ) {

		// Preserve the member call's receiver-before-argument evaluation order
		// and evaluate both expressions exactly once, while returning the live
		// material to retain `.precompile()` chain semantics.
		const materialParam = t.identifier( '__tslp_material' );
		const contextParam = t.identifier( '__tslp_context' );
		path.replaceWith( t.callExpression(
			t.arrowFunctionExpression( [ materialParam, contextParam ], materialParam ),
			[ materialExpr, contextArg ],
		) );
		return;

	}

	path.replaceWith( materialExpr );

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

	const err = new Error( formatBuildDiagnostic( filename, path, message ) );
	err.frame = path.buildCodeFrameError ? path.buildCodeFrameError( message ).message : message;
	throw err;

}

function formatBuildDiagnostic( filename, path, message ) {

	const loc = path.node.loc;
	const locStr = loc ? `${ loc.start.line }:${ loc.start.column }` : '';
	return `[tsl-precompile] ${ filename }:${ locStr } ${ message }`;

}
