/**
 * Shared state and errors for the compiler-free renderer-output adapters.
 */

import { createRuntimeSlimHashOptions } from './slim-source-policy.js';

export const DEFAULT_HASH_OPTIONS = /*@__PURE__*/ createRuntimeSlimHashOptions();

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
