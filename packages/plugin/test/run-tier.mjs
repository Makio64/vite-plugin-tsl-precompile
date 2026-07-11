#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const testDir = dirname( fileURLToPath( import.meta.url ) );

const generationTests = new Set( [
	'aux-capture.test.js',
	'aux-roundtrip.test.js',
	'classify-material-shape.test.js',
	'compile-tsl-framebuffer-warmup.test.js',
	'compute-artifact.test.js',
	'extract-uniform-plan.test.js',
	'extractor-convergence.test.js',
	'ltc-capture.test.js',
	'live-render-harvest.test.js',
] );

const generationImportMarkers = [
	'/src/vendor/compileTSL.js',
	'/src/aux-capture.js',
	'/src/node-harness.js',
];

function listTests( directory ) {

	return readdirSync( directory )
		.filter( ( name ) => name.endsWith( '.test.js' ) )
		.sort()
		.map( ( name ) => ( { name, path: join( directory, name ) } ) );

}

const unitTests = listTests( join( testDir, 'unit' ) );
const coverageTests = listTests( join( testDir, 'coverage' ) );

// Keep a newly-added extractor test from silently entering the quick tier.
// The explicit set also contains lower-level generation tests whose imports
// do not reveal that they exercise the pipeline.
const unclassifiedGenerationTests = unitTests.filter( ( test ) => {

	if ( generationTests.has( test.name ) || test.name.startsWith( 'rewrite-' ) ) return false;
	const source = readFileSync( test.path, 'utf8' );
	return generationImportMarkers.some( ( marker ) => source.includes( marker ) );

} );
if ( unclassifiedGenerationTests.length > 0 ) {

	throw new Error( `Generation-heavy tests must be listed in generationTests: ${ unclassifiedGenerationTests.map( ( test ) => test.name ).join( ', ' ) }` );

}

const groups = {
	generation: unitTests.filter( ( test ) => generationTests.has( test.name ) ),
	rewrite: unitTests.filter( ( test ) => test.name.startsWith( 'rewrite-' ) ),
	slim: unitTests.filter( ( test ) => test.name.startsWith( 'slim-' ) ),
};

const fullOnlyNames = new Set( Object.values( groups ).flat().map( ( test ) => test.name ) );
const quickTests = unitTests.filter( ( test ) => ! fullOnlyNames.has( test.name ) );

const tiers = {
	quick: quickTests,
	unit: unitTests,
	full: [ ...unitTests, ...coverageTests ],
	generation: groups.generation,
	rewrite: groups.rewrite,
	coverage: coverageTests,
};

const tier = process.argv[ 2 ] ?? 'quick';
const tests = tiers[ tier ];

if ( tests === undefined ) {

	console.error( `Unknown test tier "${ tier }". Expected one of: ${ Object.keys( tiers ).join( ', ' ) }.` );
	process.exit( 2 );

}

// Full/extractor tiers intentionally stay serial: they load the three.js compiler
// and large generated fixtures. The quick tier is capped at two workers so local
// runs do not fan out one process per test file.
const defaultConcurrency = [ 'quick', 'unit' ].includes( tier ) ? 2 : 1;
const concurrency = Number.parseInt( process.env.TSLP_TEST_CONCURRENCY ?? `${ defaultConcurrency }`, 10 );

if ( ! Number.isSafeInteger( concurrency ) || concurrency < 1 ) {

	console.error( 'TSLP_TEST_CONCURRENCY must be a positive integer.' );
	process.exit( 2 );

}

console.log( `[plugin:test] ${ tier }: ${ tests.length } files, concurrency=${ concurrency }` );

if ( tier === 'quick' ) {

	console.log( '[plugin:test] Full extractor, rewrite, slim, and coverage checks: pnpm test:full' );

}

const result = spawnSync(
	process.execPath,
	[
		'--test',
		`--test-concurrency=${ concurrency }`,
		...( tier === 'quick' ? [ '--test-reporter=dot' ] : [] ),
		...tests.map( ( test ) => test.path ),
	],
	{ stdio: 'inherit' },
);

if ( result.error ) throw result.error;

process.exit( result.status ?? 1 );
