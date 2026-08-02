import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';

import { createRecapturePlan } from '../../src/cli/recapture-plan.js';

const REPO = resolve( import.meta.dirname, '../../../..' );

test( 'every artifact directory checked by root verify is covered by recapture-all', () => {

	const packageJson = JSON.parse( readFileSync( resolve( REPO, 'package.json' ), 'utf8' ) );
	const verifiedExamples = [ ...packageJson.scripts.verify.matchAll( /packages\/examples\/([^/\s]+)\/artifacts/g ) ]
		.map( ( match ) => basename( match[ 1 ] ) );
	const plan = createRecapturePlan( REPO );
	const recapturable = new Set( plan.map( ( example ) => example.name ) );

	assert.ok( verifiedExamples.length > 0, 'root verify script must enumerate artifact directories' );
	assert.deepEqual(
		verifiedExamples.filter( ( example ) => ! recapturable.has( example ) ),
		[],
		'every verified artifact directory needs a supported transactional recapture route',
	);
	assert.deepEqual(
		plan.find( ( example ) => example.name === 'wow-showcase' )?.paths,
		[
			'/race.html',
			'/tool.html',
			'/women.html',
			'/robots.html',
			'/abyss.html',
			'/orbit.html',
			'/pulse.html',
			'/climate.html',
			'/fashion.html',
			'/architecture.html',
		],
	);
	assert.equal( plan.find( ( example ) => example.name === 'wow-showcase' )?.timeout, 45000 );

} );
