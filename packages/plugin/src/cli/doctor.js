#!/usr/bin/env node

import { fileURLToPath } from 'node:url';

import {
	compactDoctorResult,
	DOCTOR_HELP,
	inspectTslPrecompileProject,
	parseDoctorArgs,
	printDoctorResult,
} from './doctor-support.js';

const rawArgs = process.argv.slice( 2 );
const requestedJson = rawArgs.includes( '--json' );
const doctorCli = fileURLToPath( import.meta.url );

try {

	const options = parseDoctorArgs( rawArgs );
	if ( options.help ) {

		if ( options.json ) console.log( JSON.stringify( {
			schemaVersion: 1,
			ok: true,
			status: 'help',
			command: 'tsl-precompile-doctor',
			help: DOCTOR_HELP.trim(),
			nextActions: [],
		}, null, 2 ) );
		else console.log( DOCTOR_HELP );

	} else {

		const result = await inspectTslPrecompileProject( options );
		const outputResult = options.compact ? compactDoctorResult( result ) : result;
		if ( options.json ) console.log( JSON.stringify( outputResult, null, 2 ) );
		else printDoctorResult( result );
		process.exitCode = result.ok ? 0 : 1;

	}

} catch ( error ) {

	const message = error?.message || String( error );
	const remediation = 'Run tsl-precompile-doctor --help and correct the arguments.';
	if ( requestedJson ) {

		console.log( JSON.stringify( {
			schemaVersion: 1,
			ok: false,
			status: 'failed',
			command: 'tsl-precompile-doctor',
			readiness: 'invalid-invocation',
			summary: { pass: 0, warn: 0, fail: 1 },
			checks: [ {
				id: 'invocation',
				code: 'invocation',
				status: 'fail',
				severity: 'error',
				summary: message,
				message,
				evidence: { argv: rawArgs },
				remediation,
				nextAction: remediation,
			} ],
			nextActions: [ {
				kind: 'command',
				code: 'show-help',
				check: 'invocation',
				priority: 'fail',
				reason: remediation,
				action: remediation,
				cwd: process.cwd(),
				argv: [ process.execPath, doctorCli, '--help' ],
				commands: [ [ process.execPath, doctorCli, '--help' ] ],
			} ],
		}, null, 2 ) );

	} else {

		console.error( `[tsl-precompile] doctor failed: ${ message }` );
		console.error( 'Use -h or --help for usage.' );

	}
	process.exitCode = 1;

}
