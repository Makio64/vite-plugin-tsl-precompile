import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { parse } from '@babel/parser';
import { getOuterBindingIdentifiers } from '@babel/types';
import { resolveSlimPrebuiltInstallation } from './slim-prebuilt-provenance.js';

export const PREBUILT_RUNTIME_ROOT_ID = 'virtual:tsl-precompile-runtime-root';
export const PREBUILT_RUNTIME_FALLBACK_ID = PREBUILT_RUNTIME_ROOT_ID + '/source';

/**
 * Root imports must use the same stateful helpers as generated prebuilt imports.
 * Derive their intersection from the installed ESM exports, not a second API list.
 * Non-shared root exports remain available through the ordinary implementation.
 */
export async function createPrebuiltRuntimeRoot( root ) {

	const installation = await resolveSlimPrebuiltInstallation( root );
	const entry = join( installation.runtimePackageRoot, 'src/index.js' );
	const [ rootExports, bundledExports ] = await Promise.all( [
		collectExports( entry ),
		collectExports( installation.bundleFile ),
	] );
	const shared = [], fallback = [], remaining = [];
	for ( const [ name, source ] of rootExports ) {

		if ( bundledExports.has( name ) ) shared.push( JSON.stringify( name ) );
		else {

			remaining.push( JSON.stringify( name ) );
			fallback.push( source.namespace
				? `export * as ${ JSON.stringify( name ) } from ${ JSON.stringify( source.file ) };`
				: `export { ${ JSON.stringify( source.name ) } as ${ JSON.stringify( name ) } } from ${ JSON.stringify( source.file ) };` );

		}

	}
	return {
		root: {
			code: [
				shared.length ? `export { ${ shared.join( ', ' ) } } from ${ JSON.stringify( installation.bundleFile ) };` : '',
				remaining.length ? `export { ${ remaining.join( ', ' ) } } from ${ JSON.stringify( PREBUILT_RUNTIME_FALLBACK_ID ) };` : '',
			].join( '\n' ),
			moduleSideEffects: false,
		},
		// A separate export-only facade also lets dynamic root imports skip
		// unused source providers. Used providers retain their initialization.
		fallback: { code: fallback.join( '\n' ), moduleSideEffects: false },
	};

}

const SINGLE_TRAILING_EXPORT_RE = /\bexport\s*\{[^{}]*\}\s*;?\s*$/;

function parseExportModule( source ) {

	const match = SINGLE_TRAILING_EXPORT_RE.exec( source );
	if ( match && ! /\bexport\s*(?:[*{]|default\b|const\b|let\b|var\b|function\b|class\b|async\b)/.test( source.slice( 0, match.index ) ) ) {

		try {

			return parse( match[ 0 ], { sourceType: 'module', allowUndeclaredExports: true } );

		} catch ( _ ) {}

	}
	return parse( source, { sourceType: 'module' } );

}

async function collectExports( entry, active = new Set() ) {

	if ( active.has( entry ) ) throw new Error( `[tsl-precompile] cyclic star exports in runtime entry ${ entry }` );
	active.add( entry );
	const names = new Map();
	const source = await readFile( entry, 'utf8' );
	const ast = parseExportModule( source );
	const starExports = new Map();
	for ( const statement of ast.program.body ) {

		if ( statement.type === 'ExportAllDeclaration' && ! starExports.has( statement.source.value ) ) {

			const target = createRequire( entry ).resolve( statement.source.value );
			starExports.set( statement.source.value, collectExports( target, new Set( active ) ) );

		}

	}
	for ( const statement of ast.program.body ) {

		if ( statement.type === 'ExportNamedDeclaration' ) {

			for ( const name of Object.keys( getOuterBindingIdentifiers( statement.declaration ) ) ) names.set( name, { file: entry, name } );
			for ( const specifier of statement.specifiers ) {

				const name = specifier.exported.name ?? specifier.exported.value;
				names.set( name, statement.source ? {
					file: createRequire( entry ).resolve( statement.source.value ),
					name: specifier.local?.name ?? specifier.local?.value,
					namespace: specifier.type === 'ExportNamespaceSpecifier',
				} : { file: entry, name } );

			}

		} else if ( statement.type === 'ExportDefaultDeclaration' ) {

			names.set( 'default', { file: entry, name: 'default' } );

		} else if ( statement.type === 'ExportAllDeclaration' ) {

			const inherited = await starExports.get( statement.source.value );
			for ( const [ name, source ] of inherited ) if ( name !== 'default' && ! names.has( name ) ) names.set( name, source );

		}

	}
	active.delete( entry );
	return names;

}
