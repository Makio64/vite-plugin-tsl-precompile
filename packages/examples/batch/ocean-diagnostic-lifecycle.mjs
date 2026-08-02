import { mkdtempSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
	prepareOutputRoot,
	removeOutputPath,
} from './output-path-safety.mjs';

export function createOceanDiagnosticOutput( repositoryRoot, prefix, label ) {

	const temporaryRoot = prepareOutputRoot( mkdtempSync( join( tmpdir(), prefix ) ), {
		repositoryRoot,
		label: `${ label } temporary root`,
	} );
	try {

		const artifactsDir = prepareOutputRoot( resolve( temporaryRoot, 'artifacts' ), {
			repositoryRoot,
			label: `${ label } artifacts`,
		} );
		return { temporaryRoot, artifactsDir };

	} catch ( error ) {

		rmdirSync( temporaryRoot );
		throw error;

	}

}

export function cleanupOceanDiagnosticOutput( output, label ) {

	if ( ! output ) return;
	removeOutputPath( output.temporaryRoot, output.artifactsDir, {
		recursive: true,
		label: `${ label } artifacts`,
	} );
	// The prepared root contains only the artifacts child. A non-recursive
	// removal intentionally refuses to hide any unexpected output.
	rmdirSync( output.temporaryRoot );

}

function childExited( child ) {

	return ! child || child.exitCode !== null || child.signalCode !== null;

}

function waitForChildExit( child, timeoutMs ) {

	if ( childExited( child ) ) return Promise.resolve( true );
	return new Promise( ( resolveWait ) => {

		const onExit = () => {

			clearTimeout( timer );
			resolveWait( true );

		};
		const timer = setTimeout( () => {

			child.removeListener( 'exit', onExit );
			resolveWait( childExited( child ) );

		}, timeoutMs );
		child.once( 'exit', onExit );

	} );

}

export async function stopOwnedChild( child, label = 'child process' ) {

	if ( childExited( child ) ) return;
	child.kill( 'SIGTERM' );
	if ( await waitForChildExit( child, 3000 ) ) return;
	child.kill( 'SIGKILL' );
	if ( ! await waitForChildExit( child, 3000 ) ) {

		throw new Error( `${ label } did not exit after SIGTERM and SIGKILL.` );

	}

}
