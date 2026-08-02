/**
 * Shared state and errors for the compiler-free renderer-output adapters.
 */

import { ARTIFACT_TOOLCHAIN_VERSION } from '@tsl-precompile/contract/versions';
import { RUNTIME_SLIM_THREE_PACKAGE_VERSION } from './slim-source-policy.js';

export const DEFAULT_HASH_OPTIONS = Object.freeze( {
	// REVISION intentionally omits the npm patch component (r185 reports
	// "185" for three@0.185.1), so it cannot reproduce the capture hash
	// domain. Replay must use the exact package identity signed by the slim
	// build policy.
	threeVersion: RUNTIME_SLIM_THREE_PACKAGE_VERSION,
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
