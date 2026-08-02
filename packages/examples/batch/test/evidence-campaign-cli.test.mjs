import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
	assertFreshCampaignOutputRoot,
	evidenceCohorts,
	runEvidenceCampaign,
} from '../run-evidence-campaign.mjs';

const BATCH_ROOT = resolve( dirname( fileURLToPath( import.meta.url ) ), '..' );
const SCRIPT = resolve( BATCH_ROOT, 'run-evidence-campaign.mjs' );

function run( ...args ) {

	return spawnSync( process.execPath, [ SCRIPT, ...args ], {
		cwd: BATCH_ROOT,
		encoding: 'utf8',
	} );

}

test( 'evidence campaign rejects unknown and duplicate options before browser work', () => {

	const unknown = run( '--filter=clearcoat' );
	assert.equal( unknown.status, 2 );
	assert.match( unknown.stderr, /unknown option.*--filter=clearcoat/ );

	const duplicate = run( '--three-repo=/first', '--three-repo=/second' );
	assert.equal( duplicate.status, 2 );
	assert.match( duplicate.stderr, /--three-repo may be provided only once/ );

} );

test( 'evidence campaign requires an explicit exact Three checkout', () => {

	const result = spawnSync( process.execPath, [ SCRIPT ], {
		cwd: BATCH_ROOT,
		encoding: 'utf8',
		env: { ...process.env, TSLP_THREE_REPO: '' },
	} );
	assert.equal( result.status, 2 );
	assert.match( result.stderr, /--three-repo=<clean-official-r185-checkout> is required/ );

} );

test( 'evidence campaign accepts only a new or empty aggregate root', ( t ) => {

	const scratch = mkdtempSync( join( tmpdir(), 'tslp-campaign-freshness-' ) );
	t.after( () => rmSync( scratch, { recursive: true, force: true } ) );
	const missing = join( scratch, 'missing' );
	const empty = join( scratch, 'empty' );
	const stale = join( scratch, 'stale' );
	mkdirSync( empty );
	mkdirSync( stale );
	writeFileSync( join( stale, 'evidence-manifest.json' ), '{}' );

	assert.doesNotThrow( () => assertFreshCampaignOutputRoot( missing ) );
	assert.doesNotThrow( () => assertFreshCampaignOutputRoot( empty ) );
	assert.throws(
		() => assertFreshCampaignOutputRoot( stale ),
		/output root must be new or empty/,
	);

} );

test( 'evidence campaign runs every cohort and the aggregate after stage failures', async () => {

	const calls = [];
	const logs = [];
	const errors = [];
	const failedLabels = new Map( [
		[ 'running exact 209-case upstream cohort', 7 ],
		[ 'running exact local cohort pmrem-debug', 9 ],
		[ 'validating the exact 254-case aggregate', 11 ],
	] );
	const status = await runEvidenceCampaign( {
		threeRepo: '/fixture/three',
		outputRoot: '/fixture/evidence',
		campaignId: 'campaign-test-254',
		runStage: async ( label, script, args ) => {

			calls.push( { label, script, args } );
			return failedLabels.get( label ) || 0;

		},
		logger: {
			log: ( message ) => logs.push( message ),
			error: ( message ) => errors.push( message ),
		},
	} );

	assert.equal( status, 7, 'the first failure status remains the campaign exit status' );
	assert.deepEqual(
		calls.map( ( call ) => call.label ),
		[
			'running exact 209-case upstream cohort',
			...evidenceCohorts.map( ( project ) => `running exact local cohort ${ project }` ),
			'validating the exact 254-case aggregate',
		],
	);
	assert.equal( calls.length, 8, 'one upstream, six local, and one aggregate stage run' );
	assert.match( logs.at( - 1 ), /finished with 3 failed stage\(s\)/ );
	assert.deepEqual( errors, [
		'[evidence-campaign] failed: running exact 209-case upstream cohort (exit 7)',
		'[evidence-campaign] failed: running exact local cohort pmrem-debug (exit 9)',
		'[evidence-campaign] failed: validating the exact 254-case aggregate (exit 11)',
	] );

	const successfulLocal = calls.find(
		( call ) => call.label === 'running exact local cohort shadow-debug'
	);
	assert.ok( successfulLocal.args.includes( '--output-root=/fixture/evidence/cohorts/shadow-debug' ) );
	assert.ok( successfulLocal.args.includes( '--report=shadow-debug-e2e-report.json' ) );

} );
