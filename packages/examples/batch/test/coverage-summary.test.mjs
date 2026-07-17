import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const SELF = dirname( fileURLToPath( import.meta.url ) );
const BATCH_ROOT = resolve( SELF, '..' );
const SUMMARY_SCRIPT = resolve( BATCH_ROOT, 'run-coverage-summary.mjs' );
const CATALOGUE = JSON.parse( readFileSync( resolve( BATCH_ROOT, 'example-catalogue.json' ), 'utf8' ) );

test( 'coverage summary ignores evidence outside the tracked catalogue', ( t ) => {

	const root = mkdtempSync( join( tmpdir(), 'tslp-coverage-summary-' ) );
	t.after( () => rmSync( root, { recursive: true, force: true } ) );
	mkdirSync( join( root, 'shots' ) );
	writeFileSync( join( root, 'e2e-report.json' ), JSON.stringify( {
		details: [
			{ name: 'bloom.html', pixelGate: { psnr: 'inf' } },
			{ name: 'webgpu_compute_orphan.html', pixelGate: { psnr: 42 } },
		],
	} ) );

	const result = spawnSync( process.execPath, [ SUMMARY_SCRIPT, `--output-root=${ root }` ], {
		cwd: BATCH_ROOT,
		encoding: 'utf8',
	} );
	assert.equal( result.status, 0, result.stderr || result.stdout );
	assert.match( result.stderr, /ignored 1 untracked evidence entry: webgpu_compute_orphan\.html/ );

	const markdown = readFileSync( join( root, 'coverage-summary.md' ), 'utf8' );
	const names = [ ...markdown.matchAll( /^\| ([^ |]+\.html) \|/gm ) ].map( ( match ) => match[ 1 ] );
	const expected = CATALOGUE.cases.map( ( entry ) => `${ entry.id }.html` ).sort();
	assert.deepEqual( names.sort(), expected );
	assert.doesNotMatch( markdown, /webgpu_compute_orphan\.html/ );
	assert.match( markdown, /\| bloom\.html \| ✗ \| ✗ \| inf \| ✅ matches \| e2e-report\.json only \|/ );

} );
