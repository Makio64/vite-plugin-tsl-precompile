/**
 * Shared state and errors for the compiler-free renderer-output adapters.
 */

import { REVISION } from 'three/src/constants.js';
import { ARTIFACT_TOOLCHAIN_VERSION } from '@tsl-precompile/contract/versions';

export const DEFAULT_HASH_OPTIONS = Object.freeze( {
	threeVersion: threePackageVersionFromRevision( REVISION ),
	pluginVersion: ARTIFACT_TOOLCHAIN_VERSION,
} );

export function disposeReplacedMaterial( previousMaterial, replacement ) {

	if ( ! previousMaterial || previousMaterial === replacement || typeof previousMaterial.dispose !== 'function' ) return;
	previousMaterial.dispose();

}

export function replayOutputError( code, message, config ) {

	const error = new Error( `[tsl-precompile/slim] ${ message }` );
	error.name = 'ReplayOutputError';
	error.code = code;
	error.config = config;
	return error;

}

function threePackageVersionFromRevision( revision ) {

	const match = String( revision || '' ).match( /\d+/ );
	return match ? `0.${ match[ 0 ] }.0` : String( revision || 'unknown' );

}
