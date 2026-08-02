import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
	hardSceneHarnessArgv,
	loadHardSceneManifest,
	selectHardSceneCase,
	validateHardSceneManifest,
} from '../hard-scene-plan.mjs';

const BATCH_ROOT = resolve( import.meta.dirname, '..' );
const SCRIPT = resolve( BATCH_ROOT, 'run-hard-scene.mjs' );

function run( ...args ) {

	return spawnSync( process.execPath, [ SCRIPT, ...args ], {
		cwd: BATCH_ROOT,
		encoding: 'utf8',
		env: { ...process.env, TSLP_THREE_REPO: '' },
	} );

}

test( 'hard-scene manifest is checked against the exact r185 catalogue', () => {

	const manifest = loadHardSceneManifest();
	assert.equal( manifest.schemaVersion, 1 );
	assert.equal( manifest.threeVersion, '0.185.1' );
	assert.equal( manifest.psnrThresholdDb, 30 );
	assert.equal( manifest.cases.length, 27 );
	assert.equal( new Set( manifest.cases.map( ( entry ) => entry.filename ) ).size, manifest.cases.length );
	for ( const filename of [
		'webgpu_pmrem_cubemap.html',
		'webgpu_reflection.html',
		'webgpu_postprocessing_ssr.html',
		'webgpu_postprocessing_ssr_denoise.html',
		'webgpu_postprocessing_sss.html',
		'webgpu_materials_sss.html',
		'webgpu_upscaling_taau.html',
		'webgpu_texturegather.html',
		'webgpu_shadowmap_progressive.html',
		'webgpu_shadowmap_vsm.html',
		'webgpu_lights_physical.html',
	] ) {

		assert.ok( manifest.cases.some( ( entry ) => entry.filename === filename ), filename );

	}

} );

test( 'hard-scene manifest fails closed on threshold and catalogue drift', () => {

	const manifest = loadHardSceneManifest();
	const catalogue = {
		threeVersion: manifest.threeVersion,
		cases: manifest.cases.map( ( entry ) => ( {
			source: { kind: 'three', route: entry.filename },
		} ) ),
	};
	assert.throws(
		() => validateHardSceneManifest( { ...manifest, psnrThresholdDb: 29 }, catalogue ),
		/30 dB/,
	);
	assert.throws(
		() => validateHardSceneManifest( {
			...manifest,
			cases: [ ...manifest.cases, manifest.cases[ 0 ] ],
		}, catalogue ),
		/duplicate/,
	);

} );

test( 'hard-scene plan is one machine-readable JSON object', () => {

	const allCases = run( '--plan' );
	assert.equal( allCases.status, 0 );
	assert.equal( allCases.stderr, '' );
	const allPlan = JSON.parse( allCases.stdout );
	assert.equal( allPlan.schemaVersion, 1 );
	assert.equal( allPlan.status, 'case-selection-required' );
	assert.deepEqual( allPlan.requiredInputs, [ 'case' ] );
	assert.equal( allPlan.gate.psnrThresholdDb, 30 );
	assert.equal( allPlan.outputPolicy.existingRootAllowed, false );

	const selected = run( '--plan', '--case=webgpu_pmrem_cubemap.html', '--three-repo=/missing-r185' );
	assert.equal( selected.status, 0 );
	const selectedPlan = JSON.parse( selected.stdout );
	assert.equal( selectedPlan.status, 'three-checkout-required' );
	assert.equal( selectedPlan.selectedCase.filename, 'webgpu_pmrem_cubemap.html' );
	assert.deepEqual( selectedPlan.requiredInputs, [ 'threeRepo' ] );

} );

test( 'hard-scene runner accepts only an exact checked case and a new output root', ( t ) => {

	const unknown = run( '--case=not-in-manifest.html' );
	assert.equal( unknown.status, 2 );
	assert.match( unknown.stderr, /unknown hard-scene case/ );

	const partial = run( '--case=webgpu_pmrem' );
	assert.equal( partial.status, 2 );
	assert.match( partial.stderr, /canonical HTML basename/ );

	const scratch = mkdtempSync( join( tmpdir(), 'tslp-hard-scene-cli-' ) );
	t.after( () => rmSync( scratch, { recursive: true, force: true } ) );
	const existing = join( scratch, 'existing' );
	const threeRepo = join( scratch, 'three-r185' );
	mkdirSync( existing );
	mkdirSync( join( threeRepo, 'examples' ), { recursive: true } );
	const shared = run(
		'--case=webgpu_pmrem_cubemap.html',
		`--three-repo=${ threeRepo }`,
		`--output-root=${ existing }`,
	);
	assert.equal( shared.status, 2 );
	assert.match( shared.stderr, /must not already exist/ );

	const duplicate = run( '--case=webgpu_pmrem_cubemap.html', '--case=webgpu_reflection.html' );
	assert.equal( duplicate.status, 2 );
	assert.match( duplicate.stderr, /--case may be provided only once/ );

} );

test( 'hard-scene child argv pins exact selection and the 30 dB gate', () => {

	const manifest = loadHardSceneManifest();
	const selectedCase = selectHardSceneCase( manifest, 'webgpu_postprocessing_ssr_denoise.html' );
	const argv = hardSceneHarnessArgv( {
		selectedCase,
		threeRepo: '/three-r185',
		outputRoot: '/isolated-output',
		psnrThresholdDb: 30,
	} );
	assert.ok( argv.includes( '--filter=webgpu_postprocessing_ssr_denoise.html' ) );
	assert.ok( argv.includes( '--limit=1' ) );
	assert.ok( argv.includes( '--psnr-threshold=30' ) );
	assert.ok( argv.includes( '--no-coverage' ) );
	assert.equal( argv.some( ( argument ) => argument === '--no-pixel-gate' ), false );
	assert.throws(
		() => hardSceneHarnessArgv( {
			selectedCase,
			threeRepo: '/three-r185',
			outputRoot: '/isolated-output',
			psnrThresholdDb: 29,
		} ),
		/cannot lower or override/,
	);

} );
