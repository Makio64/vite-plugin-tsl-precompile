/**
 * Recommended development entry for one-call precompile setup.
 *
 * The package owns the broad Three namespace import so applications can keep
 * their scene imports named and tree-shakeable. The conditional `./setup`
 * export replaces this module with `setup-production.js` during Vite builds.
 */

import * as THREE from 'three/webgpu';

import { setupPrecompile as setupPrecompileWithThree } from './setup.js';

export function setupPrecompile( opts = {} ) {

	if ( ! opts || typeof opts !== 'object' ) return setupPrecompileWithThree( opts );

	return setupPrecompileWithThree( {
		...opts,
		three: opts.three ?? THREE,
	} );

}
