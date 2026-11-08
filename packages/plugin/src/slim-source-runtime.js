import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { SLIM_THREE_RUNTIME_ENTRIES } from '@tsl-precompile/contract/slim-three-policy';

const RUNTIME_PACKAGE = '@tsl-precompile/runtime';

/** Resolve public and private source imports through one physical runtime owner. */
export function detectSlimSourceRuntime( root ) {

	const attempted = [];
	for ( const requireFrom of [ createRequire( resolve( root, 'package.json' ) ), createRequire( import.meta.url ) ] ) {

		try {

			const entry = realpathSync( requireFrom.resolve( SLIM_THREE_RUNTIME_ENTRIES.SOURCE ) );
			let packageRoot = dirname( entry );
			while ( true ) {

				const packageFile = join( packageRoot, 'package.json' );
				if ( existsSync( packageFile ) ) {

					const pkg = JSON.parse( readFileSync( packageFile, 'utf8' ) );
					if ( pkg.name === RUNTIME_PACKAGE ) return { entry, sourceDir: dirname( entry ), packageRoot, exports: pkg.exports };

				}
				const parent = dirname( packageRoot );
				if ( parent === packageRoot ) throw new Error( `Cannot find ${ RUNTIME_PACKAGE } package owner of ${ entry }` );
				packageRoot = parent;

			}

		} catch ( error ) {

			attempted.push( error.message );

		}

	}
	throw new Error( `[tsl-precompile] slim source build could not resolve ${ JSON.stringify( SLIM_THREE_RUNTIME_ENTRIES.SOURCE ) } from ${ root }. Install a matching @tsl-precompile/runtime release before enabling \`slim: 'source'\`. Resolver details: ${ attempted.join( ' | ' ) }` );

}

function exportTarget( value, conditions ) {

	if ( typeof value === 'string' ) return value;
	if ( value === null ) return null;
	if ( Array.isArray( value ) ) {

		for ( const candidate of value ) {

			const target = exportTarget( candidate, conditions );
			if ( target ) return target;

		}
		return undefined;

	}
	if ( ! value || typeof value !== 'object' ) return undefined;
	// Conditional exports follow package declaration order, including default.
	for ( const [ condition, candidate ] of Object.entries( value ) ) {

		if ( condition === 'default' || conditions.has( condition ) ) {

			const target = exportTarget( candidate, conditions );
			if ( target !== undefined ) return target;

		}

	}
	return undefined;

}

export function createSlimSourceRuntimeAliases( runtime, configuredConditions = [ 'module', 'browser', 'production' ] ) {

	const conditions = new Set( [ 'import', ...configuredConditions.map( condition => condition === 'development|production' ? 'production' : condition ) ] );
	const aliases = [];
	for ( const [ subpath, declaration ] of Object.entries( runtime.exports || {} ) ) {

		if ( subpath !== '.' && ( ! subpath.startsWith( './' ) || subpath.includes( '*' ) ) ) continue;
		const target = exportTarget( declaration, conditions );
		if ( ! target || ! target.startsWith( './' ) ) continue;
		const file = resolve( runtime.packageRoot, target );
		const specifier = RUNTIME_PACKAGE + ( subpath === '.' ? '' : subpath.slice( 1 ) );
		aliases.push( {
			find: new RegExp( '^' + specifier.replace( /[.*+?^${}()|[\]\\]/g, '\\$&' ) + '$' ),
			replacement: existsSync( file ) ? realpathSync( file ) : file,
		} );

	}
	return aliases;

}
