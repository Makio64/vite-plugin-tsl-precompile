#!/usr/bin/env node
/**
 * Artifact integrity CLI — `pnpm verify`.
 *
 * This is intentionally narrower than a full re-extract staleness audit:
 * it validates committed artifact files and manifests so CI can catch
 * corrupt JSON, missing manifest references, and unknown unsupported kinds.
 *
 * Shape fingerprints (`fingerprintArtifactShape`) are computed for every
 * checked artifact so CI logs can spot empty/malformed plans early. Full
 * browser-capture vs Node re-extract convergence remains §P2.10 follow-up;
 * see `packages/plugin/test/unit/extractor-convergence.test.js` for the
 * Node-path stability guard that landed first.
 */

import { access, readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

import { fingerprintArtifactShape } from '@tsl-precompile/contract/artifact-shape';
import { isArtifactCollection, validateArtifact } from '@tsl-precompile/contract/kinds';
import { ARTIFACT_TOOLCHAIN_VERSION } from '@tsl-precompile/contract/versions';
import { ARTIFACT_CONTENT_HASH_VERSION } from '@tsl-precompile/contract/artifact-content';
import { computeArtifactContentHash } from '../hash.js';

const args = process.argv.slice( 2 );
const dirs = args.length > 0 ? args : [ 'artifacts' ];
const issues = [];
let checked = 0;
let emptyShapes = 0;

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

console.log( `[tsl-precompile] verify ok (${ checked } artifact file${ checked === 1 ? '' : 's' } checked${ emptyShapes > 0 ? `, ${ emptyShapes } empty shape fingerprint(s)` : '' }).` );

async function readManifest( dir ) {

	const path = join( dir, 'manifest.json' );
	if ( ! existsSync( path ) ) return null;
	try {

		return JSON.parse( await readFile( path, 'utf8' ) );

	} catch ( err ) {

		issues.push( `${ path }: invalid JSON (${ err.message })` );
		return null;

	}

}

async function validateManifest( dir, manifest ) {

	for ( const [ name, entry ] of Object.entries( manifest ) ) {

		if ( name === '__aux' ) continue;
		if ( ! entry || typeof entry.file !== 'string' ) {

			issues.push( `${ join( dir, 'manifest.json' ) }: manifest entry "${ name }" is missing file` );
			continue;

		}
		await assertExists( join( dir, entry.file ), `manifest entry "${ name }"` );

	}

	const aux = manifest.__aux;
	if ( aux && typeof aux === 'object' ) {

		for ( const [ key, entry ] of Object.entries( aux ) ) {

			if ( ! entry || typeof entry.file !== 'string' ) {

				issues.push( `${ join( dir, 'manifest.json' ) }: aux entry "${ key }" is missing file` );
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

		issues.push( `${ path }: invalid JSON (${ err.message })` );
		return;

	}

	const allowEmptyCollection = file.endsWith( '.user.json' ) || file.endsWith( '.aux.json' );
	const isCollection = isArtifactCollection( parsed, { allowEmpty: allowEmptyCollection } );
	if ( isCollection ) {

		const validation = validateArtifact( parsed, { label: path, allowEmptyCollection } );
		for ( const error of validation.errors ) issues.push( `${ path }: ${ error.message }` );
		const shape = fingerprintArtifactShape( parsed );
		if ( shape.length === 0 && ! allowEmptyCollection ) emptyShapes ++;
		return;

	}

	const isUser = typeof parsed.__name === 'string' && parsed.__name.length > 0;
	const isAux = typeof parsed.__materialShape === 'string' && typeof parsed.__configHash === 'string';
	if ( ! isUser && ! isAux ) issues.push( `${ path }: expected __name or __materialShape/__configHash metadata` );
	if ( typeof parsed.__hash !== 'string' || parsed.__hash.length === 0 ) issues.push( `${ path }: missing __hash` );
	if ( ! parsed.artifact || typeof parsed.artifact !== 'object' ) issues.push( `${ path }: missing artifact object` );
	else {

		const validation = validateArtifact( parsed, { label: path } );
		for ( const error of validation.errors ) issues.push( `${ path }: ${ error.message }` );
		validateSourceHashMetadata( parsed.artifact, path );
		validateArtifactContentHash( parsed, path );
		const shape = fingerprintArtifactShape( parsed );
		if ( shape.length === 0 ) emptyShapes ++;

	}

	const unsupported = Array.isArray( parsed.__unsupportedKinds ) ? parsed.__unsupportedKinds : [];
	for ( const item of unsupported ) {

		if ( item && item.severity === 'unknown' ) {

			issues.push( `${ path }: unsupported kind "${ item.kind || '<unknown>' }" has severity "unknown"` );

		}

	}

}

function validateArtifactContentHash( envelope, path ) {

	const artifact = envelope && envelope.artifact;
	if ( ! artifact || artifact.artifactContentHashVersion === undefined ) return;
	if ( artifact.artifactContentHashVersion !== ARTIFACT_CONTENT_HASH_VERSION ) {

		issues.push( `${ path }: artifactContentHashVersion must be ${ ARTIFACT_CONTENT_HASH_VERSION }` );
		return;

	}
	if ( typeof envelope.__name !== 'string' || typeof envelope.__hash !== 'string' ||
		typeof artifact.sourceThreeVersion !== 'string' || typeof artifact.sourceHashVersion !== 'string' ) return;
	const computed = computeArtifactContentHash( artifact, {
		shape: `material:${ envelope.__name }`,
		threeVersion: artifact.sourceThreeVersion,
		pluginVersion: artifact.sourceHashVersion,
	} );
	if ( computed !== envelope.__hash ) issues.push( `${ path }: stored __hash does not match artifact runtime content` );

}

function validateSourceHashMetadata( artifact, path ) {

	const fields = [ 'sourceGraphHash', 'sourceHashVersion', 'sourceThreeVersion', 'renderContextSignature' ];
	if ( ! fields.some( ( key ) => artifact[ key ] !== undefined ) ) return; // Legacy artifact.
	if ( typeof artifact.sourceGraphHash !== 'string' || ! /^[a-f0-9]{64}$/i.test( artifact.sourceGraphHash ) ) {

		issues.push( `${ path }: sourceGraphHash must be a 64-character SHA-256 hex string` );

	}
	if ( artifact.sourceHashVersion !== ARTIFACT_TOOLCHAIN_VERSION ) {

		issues.push( `${ path }: sourceHashVersion must be ${ ARTIFACT_TOOLCHAIN_VERSION }` );

	}
	if ( typeof artifact.sourceThreeVersion !== 'string' || artifact.sourceThreeVersion.length === 0 ) {

		issues.push( `${ path }: sourceThreeVersion must be a non-empty exact Three package version` );

	}
	if ( artifact.renderContextSignature !== undefined && typeof artifact.renderContextSignature !== 'string' ) {

		issues.push( `${ path }: renderContextSignature must be a canonical string when present` );

	}

}

async function assertExists( path, label ) {

	try {

		await access( path );

	} catch ( _ ) {

		issues.push( `${ label } references missing file ${ path }` );

	}

}
