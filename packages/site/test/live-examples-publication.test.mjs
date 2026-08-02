import assert from 'node:assert/strict';
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { prepareOutputRoot } from '../../examples/batch/output-path-safety.mjs';
import { publishLiveExamplesAtomically } from '../scripts/live-examples-publication.mjs';

function createPublishedFixture( t ) {

	const scratch = mkdtempSync( join( tmpdir(), 'tslp-live-publication-' ) );
	t.after( () => rmSync( scratch, { recursive: true, force: true } ) );
	const publicRoot = prepareOutputRoot( join( scratch, 'public' ), {
		label: 'Test site public root',
	} );
	const liveRoot = join( publicRoot, 'live' );
	mkdirSync( liveRoot );
	writeFileSync( join( liveRoot, 'old.txt' ), 'old-live-output' );
	writeFileSync( join( publicRoot, 'live-examples.json' ), '{"generation":"old"}\n' );
	return { publicRoot, liveRoot };

}

function writeStagedPublication( liveRoot, manifestPath ) {

	writeFileSync( join( liveRoot, 'new.txt' ), 'new-live-output' );
	writeFileSync( manifestPath, '{"generation":"new"}\n' );

}

function assertNoTransactionResidue( publicRoot ) {

	assert.deepEqual(
		readdirSync( publicRoot ).filter( name => name.startsWith( '.live-' ) ),
		[],
	);

}

test( 'live publication leaves the previous output untouched when a staged build fails', async ( t ) => {

	const { publicRoot, liveRoot } = createPublishedFixture( t );
	await assert.rejects(
		publishLiveExamplesAtomically( publicRoot, async ( { liveRoot: stagedLiveRoot, manifestPath } ) => {

			writeStagedPublication( stagedLiveRoot, manifestPath );
			assert.equal( readFileSync( join( liveRoot, 'old.txt' ), 'utf8' ), 'old-live-output' );
			assert.equal( readFileSync( join( publicRoot, 'live-examples.json' ), 'utf8' ), '{"generation":"old"}\n' );
			throw new Error( 'simulated later project build failure' );

		} ),
		/simulated later project build failure/,
	);
	assert.equal( readFileSync( join( liveRoot, 'old.txt' ), 'utf8' ), 'old-live-output' );
	assert.equal( readFileSync( join( publicRoot, 'live-examples.json' ), 'utf8' ), '{"generation":"old"}\n' );
	assertNoTransactionResidue( publicRoot );

} );

test( 'live publication swaps the directory and manifest only after staging succeeds', async ( t ) => {

	const { publicRoot, liveRoot } = createPublishedFixture( t );
	const result = await publishLiveExamplesAtomically(
		publicRoot,
		async ( { liveRoot: stagedLiveRoot, manifestPath } ) => {

			writeStagedPublication( stagedLiveRoot, manifestPath );
			assert.equal( readFileSync( join( liveRoot, 'old.txt' ), 'utf8' ), 'old-live-output' );
			return 'built';

		},
	);
	assert.equal( result, 'built' );
	assert.equal( readFileSync( join( liveRoot, 'new.txt' ), 'utf8' ), 'new-live-output' );
	assert.equal( readFileSync( join( publicRoot, 'live-examples.json' ), 'utf8' ), '{"generation":"new"}\n' );
	assertNoTransactionResidue( publicRoot );

} );

test( 'live publication restores the previous pair when the final manifest swap fails', async ( t ) => {

	const { publicRoot, liveRoot } = createPublishedFixture( t );
	let renameCalls = 0;
	await assert.rejects(
		publishLiveExamplesAtomically(
			publicRoot,
			async ( { liveRoot: stagedLiveRoot, manifestPath } ) => {

				writeStagedPublication( stagedLiveRoot, manifestPath );

			},
			{
				rename( source, destination ) {

					renameCalls ++;
					if ( renameCalls === 4 ) throw new Error( 'simulated manifest swap failure' );
					renameSync( source, destination );

				},
			},
		),
		/simulated manifest swap failure/,
	);
	assert.equal( readFileSync( join( liveRoot, 'old.txt' ), 'utf8' ), 'old-live-output' );
	assert.equal( readFileSync( join( publicRoot, 'live-examples.json' ), 'utf8' ), '{"generation":"old"}\n' );
	assertNoTransactionResidue( publicRoot );

} );
