#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'vite';
import { findRenderedSlimSourceResidue } from '../../plugin/src/slim-source.js';

const SITE_ROOT = resolve( dirname( fileURLToPath( import.meta.url ) ), '..' );
const REPO_ROOT = resolve( SITE_ROOT, '../..' );
const PUBLIC_ROOT = resolve( SITE_ROOT, 'public' );
const LIVE_ROOT = resolve( PUBLIC_ROOT, 'live' );
const MANIFEST_PATH = resolve( PUBLIC_ROOT, 'live-examples.json' );

const examples = [
	{
		id: 'getting-started',
		role: 'canary',
		title: 'Getting started · compiled TSL',
		root: resolve( REPO_ROOT, 'packages/examples/getting-started' ),
		playUrl: 'live/getting-started/',
	},
];

function sha256( value ) {

	return createHash( 'sha256' ).update( value ).digest( 'hex' );

}

async function filesUnder( root, current = root ) {

	const entries = await readdir( current, { withFileTypes: true } );
	const files = [];
	for ( const entry of entries ) {

		const path = resolve( current, entry.name );
		if ( entry.isDirectory() ) files.push( ...await filesUnder( root, path ) );
		else if ( entry.isFile() ) files.push( relative( root, path ).replaceAll( '\\', '/' ) );

	}
	return files.sort();

}

function rollupBundle( result ) {

	const outputs = Array.isArray( result ) ? result : [ result ];
	const bundle = {};
	for ( const output of outputs ) {

		for ( const item of output?.output || [] ) bundle[ item.fileName ] = item;

	}
	return bundle;

}

async function directoryFingerprint( root ) {

	const files = await filesUnder( root );
	const hash = createHash( 'sha256' );
	let bytes = 0;
	for ( const file of files ) {

		const content = await readFile( resolve( root, file ) );
		bytes += content.byteLength;
		hash.update( file ).update( '\0' ).update( content ).update( '\0' );

	}
	return { sha256: hash.digest( 'hex' ), bytes, files };

}

async function packageVersion( path ) {

	return JSON.parse( await readFile( path, 'utf8' ) ).version;

}

async function buildExample( example ) {

	const outDir = resolve( LIVE_ROOT, example.id );
	const result = await build( {
		root: example.root,
		configFile: resolve( example.root, 'vite.config.js' ),
		base: './',
		build: {
			outDir,
			emptyOutDir: true,
			target: 'esnext',
		},
	} );
	const bundle = rollupBundle( result );
	const residue = findRenderedSlimSourceResidue( bundle );
	const residueCounts = Object.fromEntries( Object.entries( residue ).map( ( [ key, value ] ) => [ key, value.length ] ) );
	if ( Object.values( residueCounts ).some( Boolean ) ) {

		throw new Error( `${ example.id }: forbidden compiler/runtime residue ${ JSON.stringify( residueCounts ) }` );

	}

	const output = await directoryFingerprint( outDir );
	const artifacts = await directoryFingerprint( resolve( example.root, 'artifacts' ) );
	const chunks = Object.values( bundle ).filter( ( item ) => item.type === 'chunk' );
	const renderedModules = new Set( chunks.flatMap( ( chunk ) => Object.keys( chunk.modules || {} ) ) );
	const html = await readFile( resolve( outDir, 'index.html' ), 'utf8' );
	if ( /(?:src|href)=["']\/assets\//.test( html ) ) throw new Error( `${ example.id }: root-relative asset URL breaks the Pages base path` );

	return {
		id: example.id,
		role: example.role,
		title: example.title,
		playUrl: example.playUrl,
		runtimeMode: 'pure-slim',
		threeVersion: await packageVersion( resolve( REPO_ROOT, 'node_modules/three/package.json' ) ).catch( async () => {

			const packageJson = JSON.parse( await readFile( resolve( example.root, 'package.json' ), 'utf8' ) );
			return String( packageJson.dependencies?.three || '' ).replace( /^[^\d]*/, '' );

		} ),
		pluginVersion: await packageVersion( resolve( REPO_ROOT, 'packages/plugin/package.json' ) ),
		artifactSha256: artifacts.sha256,
		bundleSha256: output.sha256,
		bundleBytes: output.bytes,
		renderedModuleCount: renderedModules.size,
		forbiddenModuleCounts: residueCounts,
		buildVerified: true,
	};

}

await rm( LIVE_ROOT, { recursive: true, force: true } );
await rm( MANIFEST_PATH, { force: true } );

const records = [];
for ( const example of examples ) records.push( await buildExample( example ) );

const manifest = {
	schemaVersion: 1,
	manifestSha256: null,
	examples: records,
};
manifest.manifestSha256 = sha256( JSON.stringify( manifest.examples ) );
await writeFile( MANIFEST_PATH, JSON.stringify( manifest, null, '\t' ) + '\n' );

const totalBytes = records.reduce( ( total, entry ) => total + entry.bundleBytes, 0 );
console.log( `[site-live] built ${ records.length } compiler-free route(s), ${ totalBytes } bytes` );
