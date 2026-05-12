#!/usr/bin/env node
/**
 * Artifact integrity CLI — `pnpm verify`.
 *
 * This is intentionally narrower than a full re-extract staleness audit:
 * it validates committed artifact files and manifests so CI can catch
 * corrupt JSON, missing manifest references, and unknown unsupported kinds.
 */

import { access, readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

import { isArtifactCollection, validateArtifact } from '@tsl-precompile/contract/kinds';

const args = process.argv.slice( 2 );
const dirs = args.length > 0 ? args : [ 'artifacts' ];
const issues = [];
let checked = 0;

for ( const dirArg of dirs ) {

	const dir = resolve( process.cwd(), dirArg );
	if ( ! existsSync( dir ) ) {

		console.log( `[tsl-precompile] verify: ${ dirArg } does not exist; skipping.` );
		continue;

	}

	const files = ( await readdir( dir ) ).filter( ( f ) => f.endsWith( '.json' ) );
	const manifest = await readManifest( dir );

	if ( manifest ) await validateManifest( dir, manifest );

	for ( const file of files ) {

		if ( file === 'manifest.json' ) continue;
		checked ++;
		await validateArtifactFile( dir, file );

	}

}

if ( issues.length > 0 ) {

	console.error( `[tsl-precompile] verify failed with ${ issues.length } issue(s):` );
	for ( const issue of issues ) console.error( `  - ${ issue }` );
	process.exit( 1 );

}

console.log( `[tsl-precompile] verify ok (${ checked } artifact file${ checked === 1 ? '' : 's' } checked).` );

async function readManifest( dir ) {

	const path = join( dir, 'manifest.json' );
	if ( ! existsSync( path ) ) return null;
	try {

		return JSON.parse( await readFile( path, 'utf8' ) );

	} catch ( err ) {

		issues.push( `${ path}: invalid JSON (${ err.message })` );
		return null;

	}

}

async function validateManifest( dir, manifest ) {

	for ( const [ name, entry ] of Object.entries( manifest ) ) {

		if ( name === '__aux' ) continue;
		if ( ! entry || typeof entry.file !== 'string' ) {

			issues.push( `${ join( dir, 'manifest.json' )}: manifest entry "${ name }" is missing file` );
			continue;

		}
		await assertExists( join( dir, entry.file ), `manifest entry "${ name }"` );

	}

	const aux = manifest.__aux;
	if ( aux && typeof aux === 'object' ) {

		for ( const [ key, entry ] of Object.entries( aux ) ) {

			if ( ! entry || typeof entry.file !== 'string' ) {

				issues.push( `${ join( dir, 'manifest.json' )}: aux entry "${ key }" is missing file` );
				continue;

			}
			await assertExists( join( dir, entry.file ), `aux manifest entry "${ key }"` );

		}

	}

}

async function validateArtifactFile( dir, file ) {

	const path = join( dir, file );
	let parsed;
	try {

		parsed = JSON.parse( await readFile( path, 'utf8' ) );

	} catch ( err ) {

		issues.push( `${ path}: invalid JSON (${ err.message })` );
		return;

	}

	const allowEmptyCollection = file.endsWith( '.user.json' ) || file.endsWith( '.aux.json' );
	const isCollection = isArtifactCollection( parsed, { allowEmpty: allowEmptyCollection } );
	if ( isCollection ) {

		const validation = validateArtifact( parsed, { label: path, allowEmptyCollection } );
		for ( const error of validation.errors ) issues.push( `${ path}: ${ error.message }` );
		return;

	}

	const isUser = typeof parsed.__name === 'string' && parsed.__name.length > 0;
	const isAux = typeof parsed.__materialShape === 'string' && typeof parsed.__configHash === 'string';
	if ( ! isUser && ! isAux ) issues.push( `${ path}: expected __name or __materialShape/__configHash metadata` );
	if ( typeof parsed.__hash !== 'string' || parsed.__hash.length === 0 ) issues.push( `${ path}: missing __hash` );
	if ( ! parsed.artifact || typeof parsed.artifact !== 'object' ) issues.push( `${ path}: missing artifact object` );
	else {

		const validation = validateArtifact( parsed, { label: path } );
		for ( const error of validation.errors ) issues.push( `${ path}: ${ error.message }` );

	}

	const unsupported = Array.isArray( parsed.__unsupportedKinds ) ? parsed.__unsupportedKinds : [];
	for ( const item of unsupported ) {

		if ( item && item.severity === 'unknown' ) {

			issues.push( `${ path}: unsupported kind "${ item.kind || '<unknown>' }" has severity "unknown"` );

		}

	}

}

async function assertExists( path, label ) {

	try {

		await access( path );

	} catch ( _ ) {

		issues.push( `${ label} references missing file ${ path }` );

	}

}
