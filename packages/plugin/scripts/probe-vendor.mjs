#!/usr/bin/env node
// Diagnose the installed Three surface against actual vendor imports and the
// shared rewrite policy. Latest CI remains an early warning, not a support claim.
import { readFile, readdir } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse } from '@babel/parser';
import { SLIM_THREE_PACKAGE_VERSION, SLIM_THREE_REWRITE_TARGETS, THREE_RELEASE_PROFILES } from '@tsl-precompile/contract/slim-three-policy';
import { readSlimThreeReleaseProfile } from '@tsl-precompile/contract/slim-bundle-provenance-node';
import { rewriteThreeSource } from '../src/three-rewrite.js';

export async function probeVendorImports( sources, load = ( specifier ) => import( specifier ) ) {

	const failures = [];
	const modules = new Map();
	for ( const { file, code } of sources ) {

		const ast = parse( code, { sourceType: 'module' } );
		for ( const statement of ast.program.body ) {

			const specifier = statement.source?.value;
			if ( specifier !== 'three' && ! specifier?.startsWith( 'three/' ) ) continue;
			const location = `${ file }:${ statement.loc.start.line }`;
			if ( ! modules.has( specifier ) ) modules.set( specifier, Promise.resolve().then( () => load( specifier ) ).then( ( exports ) => ( { exports } ), ( error ) => ( { error } ) ) );
			const result = await modules.get( specifier );
			if ( result.error ) {

				failures.push( { stage: 'import', location, specifier, message: result.error.message } );
				continue;

			}
			for ( const binding of statement.specifiers || [] ) {

				const name = binding.type === 'ImportDefaultSpecifier' ? 'default' : ( binding.imported || binding.local )?.name;
				if ( binding.type === 'ImportNamespaceSpecifier' || binding.type === 'ExportNamespaceSpecifier' ) continue;
				if ( name && result.exports[ name ] === undefined ) failures.push( {
					stage: 'export', location, specifier, message: `missing export ${ name }; update this vendor import and its use, then check VENDORING.md`,
				} );

			}

		}

	}
	return failures;

}

export async function probeThreeRewrites( threeVersion, {
	threeRevision,
	threeCommit,
	targets = SLIM_THREE_REWRITE_TARGETS,
	loadSource = async ( target ) => {

		const url = import.meta.resolve( `three/src/${ target.sourcePath }` );
		return { code: await readFile( fileURLToPath( url ), 'utf8' ), id: fileURLToPath( url ) };

	},
	rewrite = rewriteThreeSource,
} = {} ) {

	const failures = [];
	const foundFamilies = new Set();
	for ( const target of targets ) {

		try {

			const { code, id } = await loadSource( target );
			foundFamilies.add( target.rewriteFamily );
			const result = rewrite( code, id, { threeVersion, ...( threeRevision ? { threeRevision } : {} ), ...( threeCommit ? { threeCommit } : {} ) } );
			if ( ! result || result.warning || ! result.code ) throw new Error( result?.warning || 'policy target produced no rewritten source' );

		} catch ( error ) {

			failures.push( { stage: 'rewrite', location: target.sourcePath, family: target.rewriteFamily, message: error.message, ...( error.code === 'ENOENT' ? { missing: true } : {} ) } );

		}

	}
	// The policy retains historical filenames (Nodes → NodeManager). A missing
	// alias is healthy only if another target in that same family was loaded.
	return failures.filter( ( failure ) => ! failure.missing || ! foundFamilies.has( failure.family ) );

}

/** Redirect vendor imports without replacing the workspace's Three installation. */
export async function withThreeSourceRoot( threeRoot, run ) {

	const parentURL = pathToFileURL( resolve( threeRoot, 'package.json' ) ).href;
	const hook = registerHooks( {
		resolve( specifier, context, nextResolve ) {

			return nextResolve( specifier, specifier === 'three' || specifier.startsWith( 'three/' )
				? { ...context, parentURL }
				: context );

		},
	} );
	try {

		return await run();

	} finally {

		hook.deregister();

	}

}

async function main() {

	const directory = new URL( '../src/vendor/', import.meta.url );
	const names = ( await readdir( directory ) ).filter( ( name ) => name.endsWith( '.js' ) ).sort();
	const sources = await Promise.all( names.map( async ( name ) => ( {
		file: `src/vendor/${ name }`, code: await readFile( new URL( name, directory ), 'utf8' ),
	} ) ) );
	const args = process.argv.slice( 2 );
	const argument = ( prefix ) => args.find( ( value ) => value.startsWith( prefix ) )?.slice( prefix.length );
	const threeRoot = resolve( argument( '--three-root=' ) || process.env.TSLP_THREE_SOURCE_ROOT || dirname( dirname( fileURLToPath( import.meta.resolve( 'three' ) ) ) ) );
	const requestedProfile = argument( '--profile=' );
	const { version } = JSON.parse( await readFile( resolve( threeRoot, 'package.json' ), 'utf8' ) );
	let profile = null;
	const failures = [];
	try {

		profile = await readSlimThreeReleaseProfile( threeRoot, { sourceCommit: process.env.TSLP_THREE_SOURCE_COMMIT || undefined } );
		if ( requestedProfile && THREE_RELEASE_PROFILES[ requestedProfile ]?.id !== profile.id ) {

			throw new Error( `Requested ${ requestedProfile } probe, but candidate identifies as ${ profile.id }.` );

		}

	} catch ( error ) {

		failures.push( { stage: 'release', location: threeRoot, message: error.message } );

	}
	await withThreeSourceRoot( threeRoot, async () => {

		failures.push( ...await probeVendorImports( sources ), ...await probeThreeRewrites( version, {
			threeRevision: profile?.revision,
			threeCommit: profile?.gitCommit,
			loadSource: async ( target ) => ( {
				code: await readFile( resolve( threeRoot, 'src', target.sourcePath ), 'utf8' ),
				id: `/node_modules/three/src/${ target.sourcePath }`,
			} ),
		} ) );
		for ( const name of names ) {

			try { await import( new URL( name, directory ).href ); }
			catch ( error ) { failures.push( { stage: 'initialization', location: `src/vendor/${ name }`, message: error.message } ); }

		}

	} );
	const report = { installed: version, supported: SLIM_THREE_PACKAGE_VERSION, sourceRoot: threeRoot, profile, vendorModules: names.length, rewriteTargets: SLIM_THREE_REWRITE_TARGETS.length, failures };
	if ( process.argv.includes( '--json' ) ) {

		console.log( JSON.stringify( report, null, 2 ) );

	} else {

		console.log( `[vendor-probe] Three ${ version } (supported ${ SLIM_THREE_PACKAGE_VERSION }): ${ names.length } vendor modules, ${ report.rewriteTargets } rewrite targets, ${ failures.length } failures` );
		for ( const failure of failures ) {

			console.error( `  ${ failure.stage }: ${ failure.location }${ failure.specifier ? ` → ${ failure.specifier }` : '' }${ failure.family ? ` (${ failure.family })` : '' }: ${ failure.message }` );

		}

	}
	if ( failures.length ) process.exitCode = 1;

}

if ( process.argv[ 1 ] && import.meta.url === pathToFileURL( process.argv[ 1 ] ).href ) await main();
