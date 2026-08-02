import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const RUNTIME_ROOT = fileURLToPath( new URL( '..', import.meta.url ) );
const PACKAGE_JSON = JSON.parse( readFileSync( resolve( RUNTIME_ROOT, 'package.json' ), 'utf8' ) );

function declarationValueExports( checker, program, declarationPath ) {

	const source = program.getSourceFile( declarationPath );
	assert.ok( source, `TypeScript did not load ${ declarationPath }` );
	const moduleSymbol = checker.getSymbolAtLocation( source );
	assert.ok( moduleSymbol, `TypeScript did not resolve the module symbol for ${ declarationPath }` );
	return checker.getExportsOfModule( moduleSymbol )
		.filter( ( symbol ) => {

			const target = symbol.flags & ts.SymbolFlags.Alias
				? checker.getAliasedSymbol( symbol )
				: symbol;
			return Boolean( target.flags & ts.SymbolFlags.Value );

		} )
		.map( ( symbol ) => symbol.name )
		.sort();

}

function collectRuntimeTargets( value, conditions = [] ) {

	if ( typeof value === 'string' ) return [ { conditions, target: value } ];
	if ( ! value || typeof value !== 'object' ) return [];
	return Object.entries( value ).flatMap( ( [ condition, child ] ) => (
		condition === 'types'
			? []
			: collectRuntimeTargets( child, [ ...conditions, condition ] )
	) );

}

function importableRuntimePath( subpath, runtimePath ) {

	if ( subpath !== './slim/source' ) return runtimePath;
	assert.equal( runtimePath, 'src/slim-source-entry.js' );

	// The source entry intentionally imports a Vite-only virtual policy module,
	// so Node cannot evaluate it directly. Keep this exception exact: the entry
	// may only forward the public values from slim-source-common.js.
	const sourcePath = resolve( RUNTIME_ROOT, runtimePath );
	const sourceFile = ts.createSourceFile(
		sourcePath,
		readFileSync( sourcePath, 'utf8' ),
		ts.ScriptTarget.ESNext,
		true,
		ts.ScriptKind.JS,
	);
	const exportDeclarations = sourceFile.statements.filter( ts.isExportDeclaration );
	assert.equal( exportDeclarations.length, 1, `${ runtimePath } must have one value-export declaration` );
	const exportDeclaration = exportDeclarations[ 0 ];
	assert.equal( exportDeclaration.isTypeOnly, false );
	assert.equal( exportDeclaration.exportClause, undefined );
	assert.equal( exportDeclaration.moduleSpecifier?.text, './slim-source-common.js' );
	assert.equal(
		sourceFile.statements.some( ( statement ) => ts.isExportAssignment( statement ) ),
		false,
		`${ runtimePath } must not add a separate export assignment`,
	);
	assert.equal(
		sourceFile.statements.some( ( statement ) => (
			ts.canHaveModifiers( statement )
			&& ts.getModifiers( statement )?.some( ( modifier ) => modifier.kind === ts.SyntaxKind.ExportKeyword )
		) ),
		false,
		`${ runtimePath } must not add directly exported declarations`,
	);
	return 'src/slim-source-common.js';

}

function typedPublicEntries() {

	const typedSubpaths = [];
	const entries = new Map();
	for ( const [ subpath, exported ] of Object.entries( PACKAGE_JSON.exports ) ) {

		if ( ! exported || typeof exported !== 'object' || typeof exported.types !== 'string' ) continue;
		typedSubpaths.push( subpath );
		const declarationPath = resolve( RUNTIME_ROOT, exported.types.slice( 2 ) );
		const runtimeTargets = collectRuntimeTargets( exported );
		assert.ok( runtimeTargets.length > 0, `${ subpath } has declarations but no JavaScript target` );
		for ( const { conditions, target } of runtimeTargets ) {

			assert.equal( target.startsWith( './' ), true, `${ subpath } target must be package-relative: ${ target }` );
			const runtimePath = target.slice( 2 );
			const key = `${ subpath }\0${ runtimePath }`;
			const existing = entries.get( key );
			if ( existing ) {

				existing.conditions.push( conditions.join( '.' ) );
				continue;

			}
			entries.set( key, {
				subpath,
				conditions: [ conditions.join( '.' ) ],
				runtimePath,
				importPath: importableRuntimePath( subpath, runtimePath ),
				declarationPath,
			} );

		}

	}
	assert.deepEqual(
		[ ...new Set( [ ...entries.values() ].map( ( entry ) => entry.subpath ) ) ].sort(),
		typedSubpaths.sort(),
		'every typed package export must have a parity entry',
	);
	return [ ...entries.values() ];

}

test( 'every typed public subpath declaration exactly matches every JavaScript target', async () => {

	const entries = typedPublicEntries();
	const program = ts.createProgram( {
		rootNames: [ ...new Set( entries.map( ( entry ) => entry.declarationPath ) ) ],
		options: {
			module: ts.ModuleKind.NodeNext,
			moduleResolution: ts.ModuleResolutionKind.NodeNext,
			target: ts.ScriptTarget.ES2022,
			strict: true,
			skipLibCheck: false,
			types: [],
		},
	} );
	const diagnostics = ts.getPreEmitDiagnostics( program );
	assert.deepEqual(
		diagnostics.map( ( diagnostic ) => ts.flattenDiagnosticMessageText( diagnostic.messageText, '\n' ) ),
		[],
		'public declaration graph must compile without diagnostics',
	);
	const checker = program.getTypeChecker();
	for ( const entry of entries ) {

		const runtime = await import( new URL( `../${ entry.importPath }`, import.meta.url ) );
		assert.deepEqual(
			declarationValueExports( checker, program, entry.declarationPath ),
			Object.keys( runtime ).sort(),
			`${ entry.subpath } declarations must describe ${ entry.runtimePath } under ${ entry.conditions.join( ', ' ) }`,
		);

	}

} );

test( 'runtime root excludes test-only registry reset helpers', async () => {

	const runtime = await import( '../src/index.js' );
	assert.equal( '__resetAuxRegistryForTests' in runtime, false );
	assert.doesNotMatch(
		readFileSync( resolve( RUNTIME_ROOT, 'types/index.d.ts' ), 'utf8' ),
		/\b__resetAuxRegistryForTests\b/,
	);

} );
