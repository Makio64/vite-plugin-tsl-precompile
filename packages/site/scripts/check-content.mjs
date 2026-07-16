import { readFile, readdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const siteDir = resolve( fileURLToPath( new URL( '..', import.meta.url ) ) );
const pages = [ 'index.html', 'how-it-works.html', 'examples.html', 'benchmark.html' ];
const failures = [];

function fail( message ) {

	failures.push( message );

}

function sha256( value ) {

	return createHash( 'sha256' ).update( value ).digest( 'hex' );

}

const bannedClaims = [
	{ pattern: /\bno shader compile\b/i, label: '"no shader compile" overclaim' },
	{ pattern: /\bfirst render is instant\b/i, label: '"first render is instant" overclaim' },
	{ pattern: /\bprecompiled first frame\s*(?:≈|~=|is about|costs about)\s*steady/i, label: 'warm-frame proxy presented as precompiled evidence' },
	{ pattern: /ROADMAP\.md/, label: 'removed ROADMAP.md link' },
];

for ( const page of pages ) {

	const source = await readFile( resolve( siteDir, page ), 'utf8' );
	if ( source.includes( 'href="/"' ) ) fail( `${ page }: root-relative home link breaks the GitHub Pages base path` );
	if ( ! source.includes( 'og:image' ) ) fail( `${ page }: missing social preview metadata` );
	for ( const { pattern, label } of bannedClaims ) {

		if ( pattern.test( source ) ) fail( `${ page }: ${ label }` );

	}

}

const index = await readFile( resolve( siteDir, 'index.html' ), 'utf8' );
for ( const required of [
	'pnpm add -D vite-plugin-tsl-precompile',
	'pnpm add @tsl-precompile/runtime',
	'setupPrecompile',
	'await</span> setup.ready',
] ) {

	if ( ! index.includes( required ) ) fail( `index.html: working quickstart is missing ${ JSON.stringify( required ) }` );

}

const evidence = JSON.parse( await readFile( resolve( siteDir, 'public/examples.json' ), 'utf8' ) );
const cataloguePath = resolve( siteDir, '../examples/batch/example-catalogue.json' );
const coveragePath = resolve( siteDir, '../examples/batch/results/coverage-summary.md' );
const reportPath = resolve( siteDir, '../examples/batch/results/report.json' );
const generatorPath = resolve( siteDir, 'scripts/build-examples-data.mjs' );
const [ catalogueRaw, coverageRaw, reportRaw, generatorRaw ] = await Promise.all( [
	readFile( cataloguePath, 'utf8' ),
	readFile( coveragePath, 'utf8' ),
	readFile( reportPath, 'utf8' ),
	readFile( generatorPath, 'utf8' ),
] );
const catalogue = JSON.parse( catalogueRaw );
const expectedProvenance = {
	coverageSha256: sha256( coverageRaw ),
	reportSha256: sha256( reportRaw ),
	catalogueSha256: sha256( catalogueRaw ),
	generatorSha256: sha256( generatorRaw ),
};
for ( const [ key, expected ] of Object.entries( expectedProvenance ) ) {

	if ( evidence.provenance?.[ key ] !== expected ) fail( `public/examples.json: stale ${ key }; run pnpm --filter @tsl-precompile/site data` );

}
const evidenceIds = new Set( evidence.examples.map( ( entry ) => entry.basename ) );
const catalogueIds = new Set( catalogue.cases.map( ( entry ) => entry.id ) );
for ( const id of catalogueIds ) if ( ! evidenceIds.has( id ) ) fail( `public/examples.json: missing catalogue route ${ id }` );
for ( const id of evidenceIds ) if ( ! catalogueIds.has( id ) ) fail( `public/examples.json: unknown route ${ id }` );
for ( const entry of evidence.examples ) {

	if ( ! entry.source || ! [ 'three', 'local' ].includes( entry.source.kind ) ) fail( `public/examples.json: ${ entry.basename } has no canonical source` );
	if ( entry.source && entry.source.kind === 'local' && entry.threejsUrl != null ) fail( `public/examples.json: ${ entry.basename } points a local case at threejs.org` );

}
for ( const key of [ 'materialsBaked', 'artifactsCaptured', 'smokePassRate', 'runtimeNodeBuilderCalls' ] ) {

	const match = index.match( new RegExp( `data-stat="${ key }"[^>]*>([^<]+)<` ) );
	if ( ! match ) {

		fail( `index.html: missing generated evidence target for ${ key }` );
		continue;

	}
	const fallback = Number( match[ 1 ].replaceAll( ',', '' ) );
	if ( fallback !== evidence.totals[ key ] ) {

		fail( `index.html: fallback ${ key }=${ fallback } differs from public/examples.json (${ evidence.totals[ key ] })` );

	}

}

const mainSource = await readFile( resolve( siteDir, 'src/main.js' ), 'utf8' );
if ( /shader-bg|three\/webgpu|from ['"]three/.test( mainSource ) ) {

	fail( 'src/main.js: the overview must not load Three.js for decoration' );

}

const ogPath = resolve( siteDir, 'public/og.png' );
try {

	const og = await stat( ogPath );
	if ( og.size < 50_000 ) fail( 'public/og.png: social preview looks unexpectedly small' );

} catch {

	fail( 'public/og.png: missing social preview asset' );

}

const distDir = resolve( siteDir, 'dist' );
const distFiles = await readdir( distDir );
for ( const page of pages ) {

	if ( ! distFiles.includes( page ) ) {

		fail( `dist/${ page }: missing from multi-page build` );
		continue;

	}
	const built = await readFile( resolve( distDir, page ), 'utf8' );
	if ( built.includes( 'href="/"' ) ) fail( `dist/${ page }: root-relative home link survived the build` );

}

let liveManifest;
try {

	liveManifest = JSON.parse( await readFile( resolve( distDir, 'live-examples.json' ), 'utf8' ) );

} catch {

	fail( 'dist/live-examples.json: missing compiled-route manifest' );

}
const canary = liveManifest?.examples?.find( entry => entry.role === 'canary' );
if ( ! canary ) {

	fail( 'dist/live-examples.json: missing compiler-free canary' );

} else {

	if ( canary.runtimeMode !== 'pure-slim' || canary.buildVerified !== true ) fail( 'dist/live-examples.json: canary is not a verified pure-slim build' );

}

const expectedManifestHash = sha256( JSON.stringify( liveManifest?.examples || [] ) );
if ( liveManifest?.manifestSha256 !== expectedManifestHash ) fail( 'dist/live-examples.json: manifest fingerprint does not match its records' );
if ( liveManifest?.schemaVersion !== 2 ) fail( 'dist/live-examples.json: expected schemaVersion 2' );
const seenLiveCatalogueIds = new Set();
for ( const entry of liveManifest?.examples || [] ) {

	const forbidden = Object.values( entry.forbiddenModuleCounts || {} ).reduce( ( total, count ) => total + Number( count || 0 ), 0 );
	if ( entry.runtimeMode !== 'pure-slim' || entry.buildVerified !== true ) fail( `dist/live-examples.json: ${ entry.id } is not a verified pure-slim build` );
	if ( forbidden !== 0 ) fail( `dist/live-examples.json: ${ entry.id } retained ${ forbidden } forbidden module(s)` );
	if ( ! /^[a-f0-9]{64}$/.test( entry.bundleSha256 || '' ) ) fail( `dist/live-examples.json: ${ entry.id } has no bundle fingerprint` );
	if ( entry.catalogueId ) {

		if ( ! catalogueIds.has( entry.catalogueId ) ) fail( `dist/live-examples.json: ${ entry.id } targets unknown catalogue route ${ entry.catalogueId }` );
		if ( seenLiveCatalogueIds.has( entry.catalogueId ) ) fail( `dist/live-examples.json: duplicate compiled route for ${ entry.catalogueId }` );
		seenLiveCatalogueIds.add( entry.catalogueId );

	}
	const routePath = entry.playUrl.split( '?' )[ 0 ];
	const htmlPath = routePath.endsWith( '/' ) ? `${ routePath }index.html` : routePath;
	try {

		const liveHtml = await readFile( resolve( distDir, htmlPath ), 'utf8' );
		if ( /(?:src|href)=["']\/assets\//.test( liveHtml ) ) fail( `${ entry.playUrl }: root-relative asset URL breaks the Pages base path` );
		if ( ! /(?:src|href)=["']\.\/assets\//.test( liveHtml ) ) fail( `${ entry.playUrl }: no relative compiled asset found` );

	} catch {

		fail( `${ entry.playUrl }: missing compiled route` );

	}

}

if ( failures.length > 0 ) {

	console.error( `[site-check] ${ failures.length } issue(s):\n- ${ failures.join( '\n- ' ) }` );
	process.exitCode = 1;

} else {

	console.log( `[site-check] ${ pages.length } pages, canonical evidence, and ${ liveManifest.examples.length } compiler-free live routes verified.` );

}
