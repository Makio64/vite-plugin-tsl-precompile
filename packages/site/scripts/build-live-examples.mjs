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
const CATALOGUE_PATH = resolve( REPO_ROOT, 'packages/examples/batch/example-catalogue.json' );
const catalogue = JSON.parse( await readFile( CATALOGUE_PATH, 'utf8' ) );

function titleFromId( id ) {

	return id.split( '-' ).map( word => word[ 0 ].toUpperCase() + word.slice( 1 ) ).join( ' ' );

}

function catalogueRoutes( project ) {

	return catalogue.cases
		.filter( entry => entry.source?.kind === 'local' && entry.source.project === project )
		.map( entry => ( {
			id: `${ project }:${ entry.id }`,
			catalogueId: entry.id,
			title: `${ titleFromId( entry.id ) } · compiled TSL`,
			route: entry.source.route,
		} ) );

}

const projects = [
	{
		id: 'getting-started',
		root: resolve( REPO_ROOT, 'packages/examples/getting-started' ),
		routes: [ {
			id: 'getting-started',
			role: 'canary',
			title: 'Getting started · compiled TSL',
			route: 'index.html',
		} ],
	},
	{
		id: 'shadow-debug',
		root: resolve( REPO_ROOT, 'packages/examples/shadow-debug' ),
		routes: catalogueRoutes( 'shadow-debug' ),
	},
	{
		id: 'mrt-debug',
		root: resolve( REPO_ROOT, 'packages/examples/mrt-debug' ),
		routes: catalogueRoutes( 'mrt-debug' ),
	},
	{
		id: 'postprocessing-debug',
		root: resolve( REPO_ROOT, 'packages/examples/postprocessing-debug' ),
		expectedAuxNames: [
			'postprocessing-debug-passthrough',
			'postprocessing-debug-bloom',
			'postprocessing-debug-fxaa-color',
			'postprocessing-debug-fxaa',
			'postprocessing-debug-gtao',
			'postprocessing-debug-variants-plain',
			'postprocessing-debug-variants-bloom',
		],
		routes: catalogueRoutes( 'postprocessing-debug' ).map( route => ( {
			...route,
			expectsMotion: route.catalogueId === 'variants',
		} ) ),
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

async function buildProject( project ) {

	const outDir = resolve( LIVE_ROOT, project.id );
	const result = await build( {
		root: project.root,
		configFile: resolve( project.root, 'vite.config.js' ),
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

		throw new Error( `${ project.id }: forbidden compiler/runtime residue ${ JSON.stringify( residueCounts ) }` );

	}

	const output = await directoryFingerprint( outDir );
	const artifacts = await directoryFingerprint( resolve( project.root, 'artifacts' ) );
	const chunks = Object.values( bundle ).filter( ( item ) => item.type === 'chunk' );
	const renderedModules = new Set( chunks.flatMap( ( chunk ) => Object.keys( chunk.modules || {} ) ) );
	const compiledArtifactModules = [ ...renderedModules ].filter( id =>
		id.startsWith( '\0virtual:tsl-precompile/' ) && ! id.startsWith( '\0virtual:tsl-precompile/__' )
	);
	if ( compiledArtifactModules.length === 0 ) {

		throw new Error( `${ project.id }: production bundle contains no rendered compiled-material module` );

	}
	const renderedCode = chunks.map( chunk => chunk.code || '' ).join( '\n' );
	for ( const name of project.expectedAuxNames || [] ) {

		if ( ! renderedCode.includes( name ) ) throw new Error( `${ project.id }: production bundle does not contain required aux capture ${ name }` );

	}
	for ( const route of project.routes ) {

		const htmlPath = route.route.split( '?' )[ 0 ];
		const html = await readFile( resolve( outDir, htmlPath ), 'utf8' );
		if ( /(?:src|href)=["']\/assets\//.test( html ) ) throw new Error( `${ project.id}:${ htmlPath }: root-relative asset URL breaks the Pages base path` );
		if ( ! /(?:src|href)=["']\.\/assets\//.test( html ) ) throw new Error( `${ project.id}:${ htmlPath }: no relative compiled asset found` );

	}

	const metadata = {
		buildId: project.id,
		runtimeMode: 'pure-slim',
		threeVersion: await packageVersion( resolve( REPO_ROOT, 'node_modules/three/package.json' ) ).catch( async () => {

			const packageJson = JSON.parse( await readFile( resolve( project.root, 'package.json' ), 'utf8' ) );
			return String( packageJson.dependencies?.three || '' ).replace( /^[^\d]*/, '' );

		} ),
		pluginVersion: await packageVersion( resolve( REPO_ROOT, 'packages/plugin/package.json' ) ),
		artifactSha256: artifacts.sha256,
		bundleSha256: output.sha256,
		bundleBytes: output.bytes,
		renderedModuleCount: renderedModules.size,
		compiledArtifactModuleCount: compiledArtifactModules.length,
		forbiddenModuleCounts: residueCounts,
		buildVerified: true,
	};
	const records = project.routes.map( route => ( {
		id: route.id,
		role: route.role || 'example',
		expectsMotion: route.expectsMotion === true || route.role === 'canary',
		catalogueId: route.catalogueId || null,
		title: route.title,
		playUrl: route.route === 'index.html'
			? `live/${ project.id }/`
			: `live/${ project.id }/${ route.route }`,
		...metadata,
	} ) );

	return { output, records };

}

await rm( LIVE_ROOT, { recursive: true, force: true } );
await rm( MANIFEST_PATH, { force: true } );

const records = [];
const outputs = [];
for ( const project of projects ) {

	const built = await buildProject( project );
	records.push( ...built.records );
	outputs.push( built.output );

}

const manifest = {
	schemaVersion: 2,
	manifestSha256: null,
	examples: records,
};
manifest.manifestSha256 = sha256( JSON.stringify( manifest.examples ) );
await writeFile( MANIFEST_PATH, JSON.stringify( manifest, null, '\t' ) + '\n' );

const totalBytes = outputs.reduce( ( total, output ) => total + output.bytes, 0 );
console.log( `[site-live] built ${ records.length } compiler-free route(s) from ${ projects.length } project(s), ${ totalBytes } bytes` );
