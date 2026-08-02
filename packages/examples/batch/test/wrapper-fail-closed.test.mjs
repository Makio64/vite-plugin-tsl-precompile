import assert from 'node:assert/strict';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { formatSlimBundleStamp } from '@tsl-precompile/contract/slim-bundle-provenance-node';
import {
	createSlimPixelGateRunRoot,
	runSlimPixelGateChild,
} from '../slim-pixel-gate-child.mjs';

const SELF = dirname( fileURLToPath( import.meta.url ) );
const BATCH_ROOT = resolve( SELF, '..' );
const RUN_SLIM = join( BATCH_ROOT, 'run-slim.mjs' );
const RUN_WITH_COVERAGE = join( BATCH_ROOT, 'run-e2e-with-coverage.mjs' );
const PIXEL_EXAMPLES = [
	'webgpu_sandbox.html',
	'webgpu_materials_basic.html',
	'webgpu_clearcoat.html',
	'webgpu_camera.html',
	'webgpu_compute_reduce.html',
];

function fixture( t, label ) {

	const root = mkdtempSync( join( tmpdir(), label ) );
	t.after( () => rmSync( root, { recursive: true, force: true } ) );
	return root;

}

function writeSlimBundle( root ) {

	const stamp = formatSlimBundleStamp( {
		sourceFingerprint: 'a'.repeat( 64 ),
		versions: {
			three: '0.185.1',
			policy: 'slim-three-policy@12',
			artifactToolchain: '0.1.0',
			buildToolchain: 'tslp-slim-rollup@1',
		},
	} );
	const path = join( root, 'three.webgpu.slim.js' );
	writeFileSync( path, `${ stamp }\nexport {};\n` );
	return path;

}

function writeThreeFixture( root, examples = PIXEL_EXAMPLES ) {

	const threeRoot = join( root, 'three' );
	mkdirSync( join( threeRoot, 'examples' ), { recursive: true } );
	mkdirSync( join( threeRoot, 'src' ), { recursive: true } );
	writeFileSync( join( threeRoot, 'package.json' ), JSON.stringify( { version: '0.185.1' } ) );
	writeFileSync( join( threeRoot, 'src/constants.js' ), "export const REVISION = '185';\n" );
	for ( const name of examples ) writeFileSync( join( threeRoot, 'examples', name ), '<!doctype html>' );
	return threeRoot;

}

for ( const outcome of [
	{
		name: 'nonzero status',
		result: { status: 2, signal: null, stdout: '', stderr: 'canonical-root rejection' },
		message: /exited with status 2; canonical-root rejection/,
	},
	{
		name: 'terminating signal',
		result: { status: null, signal: 'SIGTERM', stdout: '', stderr: 'terminated' },
		message: /terminated by SIGTERM; terminated/,
	},
	{
		name: 'spawn error',
		result: { status: null, signal: null, error: new Error( 'spawn EACCES' ), stdout: '', stderr: '' },
		message: /failed to start: spawn EACCES/,
	},
] ) {

	test( `slim child ${ outcome.name } is rejected before a seeded stale report is read`, ( t ) => {

		const root = fixture( t, 'tslp-slim-child-failure-' );
		const reportPath = join( root, 'e2e-report.json' );
		const staleBytes = Buffer.from( JSON.stringify( {
			status: 'completed',
			total: 1,
			pass: 1,
			fail: 0,
			details: [ { name: 'webgpu_clearcoat.html', replayBrightFrac: 1 } ],
		} ) );
		writeFileSync( reportPath, staleBytes );
		let spawnCalls = 0;
		let reportReads = 0;

		assert.throws(
			() => runSlimPixelGateChild( {
				args: [ 'run-e2e.mjs' ],
				reportPath,
				spawn: () => {

					spawnCalls ++;
					return outcome.result;

				},
				readReport: ( ...args ) => {

					reportReads ++;
					return readFileSync( ...args );

				},
			} ),
			outcome.message,
		);
		assert.equal( spawnCalls, 1 );
		assert.equal( reportReads, 0 );
		assert.deepEqual( readFileSync( reportPath ), staleBytes );

	} );

}

test( 'slim wrapper exits on child rejection while leaving a passing stale report untouched', ( t ) => {

	const root = fixture( t, 'tslp-slim-wrapper-' );
	const threeRoot = writeThreeFixture( root );
	const slimBundle = writeSlimBundle( root );
	const outputParent = join( root, 'diagnostics' );
	mkdirSync( outputParent );
	const stalePath = join( outputParent, 'e2e-report.json' );
	const staleBytes = Buffer.from( JSON.stringify( {
		status: 'completed',
		total: PIXEL_EXAMPLES.length,
		pass: PIXEL_EXAMPLES.length,
		fail: 0,
		outputRoot: outputParent,
		details: PIXEL_EXAMPLES.map( ( name ) => ( { name, status: 'pass', replayBrightFrac: 1 } ) ),
	} ) );
	writeFileSync( stalePath, staleBytes );

	const callsPath = join( root, 'spawn-calls.txt' );
	const preloadPath = join( root, 'reject-run-e2e.cjs' );
	writeFileSync( preloadPath, `
const childProcess = require('node:child_process');
const fs = require('node:fs');
const { syncBuiltinESMExports } = require('node:module');
childProcess.spawnSync = (_executable, args) => {
	fs.appendFileSync(process.env.TSLP_TEST_SPAWN_CALLS, JSON.stringify(args) + '\\n');
	return {
		status: 2,
		signal: null,
		stdout: '',
		stderr: '[batch-e2e] invalid evidence destination: canonical-root rejection\\n',
	};
};
syncBuiltinESMExports();
` );

	const child = spawnSync( process.execPath, [
		'--require',
		preloadPath,
		RUN_SLIM,
		'--pixel-gate',
		`--three-repo=${ threeRoot }`,
		`--slim-bundle=${ slimBundle }`,
		`--output-root=${ outputParent }`,
	], {
		cwd: BATCH_ROOT,
		encoding: 'utf8',
		env: {
			...process.env,
			TSLP_TEST_SPAWN_CALLS: callsPath,
		},
	} );

	assert.equal( child.status, 1, `${ child.stdout }\n${ child.stderr }` );
	assert.match( `${ child.stdout }\n${ child.stderr }`, /exited with status 2; .*canonical-root rejection/ );
	assert.match( `${ child.stdout }\n${ child.stderr }`, /refusing to read or reuse any report/ );
	assert.doesNotMatch( `${ child.stdout }\n${ child.stderr }`, /PASS: every curated example/ );
	const childCalls = readFileSync( callsPath, 'utf8' ).trim().split( '\n' ).map( ( line ) => JSON.parse( line ) );
	assert.equal( childCalls.length, 1, 'the first failed child must stop the wrapper' );
	const outputArg = childCalls[ 0 ].find( ( argument ) => argument.startsWith( '--output-root=' ) );
	const inputArg = childCalls[ 0 ].find( ( argument ) => argument.startsWith( '--input-root=' ) );
	assert.ok( outputArg, 'the child must receive an explicit output root' );
	assert.ok( inputArg, 'the child must receive an explicit input root' );
	const childOutput = outputArg.slice( '--output-root='.length );
	assert.equal( inputArg.slice( '--input-root='.length ), childOutput );
	assert.notEqual( childOutput, outputParent );
	assert.match( childOutput, /tslp-slim-pixel-gate-[^/]+\/01-webgpu_sandbox$/ );
	assert.deepEqual( readFileSync( stalePath ), staleBytes );

} );

test( 'pixel-gate run roots are always fresh and reject the canonical results directory', ( t ) => {

	const root = fixture( t, 'tslp-slim-output-root-' );
	const baseRoot = join( root, 'diagnostics' );
	const canonicalRoot = join( root, 'canonical' );
	const first = createSlimPixelGateRunRoot( { baseRoot, canonicalRoot } );
	const second = createSlimPixelGateRunRoot( { baseRoot, canonicalRoot } );
	assert.notEqual( first, second );
	assert.equal( existsSync( first ), true );
	assert.equal( existsSync( second ), true );
	assert.throws(
		() => createSlimPixelGateRunRoot( { baseRoot: canonicalRoot, canonicalRoot } ),
		/inside the canonical results root/,
	);

} );

test( 'coverage wrapper does not reprocess seeded evidence after E2E preflight failure', ( t ) => {

	const root = fixture( t, 'tslp-coverage-wrapper-' );
	const threeRoot = writeThreeFixture( root, [ 'webgpu_clearcoat.html' ] );
	const slimBundle = writeSlimBundle( root );
	const outputRoot = join( root, 'old-evidence' );
	mkdirSync( outputRoot );
	const seeded = new Map( [
		[ 'evidence-manifest.json', Buffer.from( '{"old":"manifest"}\n' ) ],
		[ 'e2e-report.json', Buffer.from( '{"old":"report"}\n' ) ],
		[ 'coverage-summary.md', Buffer.from( 'old coverage summary\n' ) ],
	] );
	for ( const [ name, bytes ] of seeded ) writeFileSync( join( outputRoot, name ), bytes );

	const child = spawnSync( process.execPath, [
		RUN_WITH_COVERAGE,
		`--three-repo=${ threeRoot }`,
		`--slim-bundle=${ slimBundle }`,
		`--output-root=${ outputRoot }`,
		'--filter=definitely-not-an-example',
	], {
		cwd: BATCH_ROOT,
		encoding: 'utf8',
	} );
	const output = `${ child.stdout }\n${ child.stderr }`;

	assert.equal( child.status, 2, output );
	assert.match( output, /selection resolved to zero candidates/ );
	assert.match( output, /refusing to read old evidence or refresh coverage/ );
	assert.doesNotMatch( output, /refreshing coverage summary/ );
	for ( const [ name, bytes ] of seeded ) {

		assert.deepEqual( readFileSync( join( outputRoot, name ) ), bytes, `${ name } must remain byte-identical` );

	}

} );
