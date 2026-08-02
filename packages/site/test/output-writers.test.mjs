import assert from 'node:assert/strict';
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const REPOSITORY_ROOT = resolve( import.meta.dirname, '../../..' );
const BUILD_AGENT_ASSETS = resolve( REPOSITORY_ROOT, 'packages/site/scripts/build-agent-assets.mjs' );
const BUILD_EXAMPLES_DATA = resolve( REPOSITORY_ROOT, 'packages/site/scripts/build-examples-data.mjs' );
const BUILD_LIVE_EXAMPLES = resolve( REPOSITORY_ROOT, 'packages/site/scripts/build-live-examples.mjs' );
const CHECK_CONTENT = resolve( REPOSITORY_ROOT, 'packages/site/scripts/check-content.mjs' );

function runAgentAssetBuild( publicRoot ) {

	return spawnSync(
		process.execPath,
		[ BUILD_AGENT_ASSETS, `--public-root=${ publicRoot }` ],
		{
			cwd: REPOSITORY_ROOT,
			encoding: 'utf8',
		},
	);

}

function runLiveExamplesBuild( publicRoot ) {

	return spawnSync(
		process.execPath,
		[ BUILD_LIVE_EXAMPLES, `--public-root=${ publicRoot }` ],
		{
			cwd: REPOSITORY_ROOT,
			encoding: 'utf8',
		},
	);

}

test( 'site evidence consumers fingerprint the recursive stock harness closure', () => {

	for ( const file of [ BUILD_EXAMPLES_DATA, CHECK_CONTENT ] ) {

		const source = readFileSync( file, 'utf8' );
		assert.match( source, /resolveStockHarnessSourceFiles/ );
		assert.doesNotMatch( source, /STOCK_HARNESS_SOURCE_PATHS/ );

	}

} );

test( 'agent asset publisher preserves outside files behind a generated-directory symlink', ( t ) => {

	const scratch = mkdtempSync( join( tmpdir(), 'tslp-site-writer-' ) );
	t.after( () => rmSync( scratch, { recursive: true, force: true } ) );
	const publicRoot = join( scratch, 'public' );
	const outside = join( scratch, 'outside' );
	mkdirSync( publicRoot );
	mkdirSync( outside );
	const victim = join( outside, 'victim.txt' );
	writeFileSync( victim, 'preserve-outside' );
	symlinkSync( outside, join( publicRoot, 'agent' ), 'dir' );

	const result = runAgentAssetBuild( publicRoot );
	assert.notEqual( result.status, 0, result.stdout );
	assert.match( `${ result.stdout }\n${ result.stderr }`, /symbolic link/ );
	assert.equal( readFileSync( victim, 'utf8' ), 'preserve-outside' );

} );

test( 'live example publisher refuses to remove a symlinked live directory', ( t ) => {

	const scratch = mkdtempSync( join( tmpdir(), 'tslp-site-live-link-' ) );
	t.after( () => rmSync( scratch, { recursive: true, force: true } ) );
	const publicRoot = join( scratch, 'public' );
	const outside = join( scratch, 'outside' );
	mkdirSync( publicRoot );
	mkdirSync( outside );
	const victim = join( outside, 'victim.txt' );
	writeFileSync( victim, 'preserve-outside' );
	symlinkSync( outside, join( publicRoot, 'live' ), 'dir' );

	const result = runLiveExamplesBuild( publicRoot );
	assert.notEqual( result.status, 0, result.stdout );
	assert.match( `${ result.stdout }\n${ result.stderr }`, /symbolic link/ );
	assert.equal( readFileSync( victim, 'utf8' ), 'preserve-outside' );

} );

test( 'agent asset publisher rejects a symlink selected as the public root', ( t ) => {

	const scratch = mkdtempSync( join( tmpdir(), 'tslp-site-root-link-' ) );
	t.after( () => rmSync( scratch, { recursive: true, force: true } ) );
	const outside = join( scratch, 'outside' );
	const publicRoot = join( scratch, 'public' );
	mkdirSync( outside );
	const victim = join( outside, 'victim.txt' );
	writeFileSync( victim, 'preserve-outside' );
	symlinkSync( outside, publicRoot, 'dir' );

	const result = runAgentAssetBuild( publicRoot );
	assert.notEqual( result.status, 0, result.stdout );
	assert.match( `${ result.stdout }\n${ result.stderr }`, /must not be a symbolic link/ );
	assert.equal( readFileSync( victim, 'utf8' ), 'preserve-outside' );

} );
