#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createRecapturePlan } from './recapture-plan.js';
import {
	assertRecaptureAuxiliaryObligations,
	readRecaptureArtifactInventories,
	recaptureVerificationArgs,
} from './recapture-all-support.js';

const HERE = dirname( fileURLToPath( import.meta.url ) );
const REPO = resolve( HERE, '../../../..' );
const VERIFY_SCRIPT = resolve( HERE, 'verify.js' );
const plan = createRecapturePlan( REPO );
let failed = false;

try {

	const inventories = readRecaptureArtifactInventories( REPO, plan );
	assertRecaptureAuxiliaryObligations( inventories, plan );

} catch ( error ) {

	failed = true;
	console.error( `[tsl-precompile] support-plan verification failed: ${ error.message || String( error ) }` );

}

for ( const example of plan ) {

	const result = spawnSync(
		process.execPath,
		[ VERIFY_SCRIPT, ...recaptureVerificationArgs( example ) ],
		{ cwd: REPO, stdio: 'inherit' },
	);
	if ( result.error ) {

		failed = true;
		console.error( `[tsl-precompile] could not verify ${ example.name }: ${ result.error.message }` );

	} else if ( result.status !== 0 ) {

		failed = true;

	}

}

if ( failed ) process.exitCode = 1;
else console.log( `[tsl-precompile] support plan verified (${ plan.length } example projects).` );
