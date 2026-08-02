/**
 * Development half of the conditional `@tsl-precompile/runtime/apply` entry.
 *
 * Production artifacts have already passed the Vite plugin's generation and
 * kind gates. Development keeps the broader shared-contract validator so
 * malformed hand-authored or dynamically supplied artifacts fail close to
 * their call site without retaining the schema registry in production.
 */

import { validateArtifact } from '@tsl-precompile/contract/kinds';

import { __applyPrecompiledWithValidation } from './apply-precompiled.js';

function validateArtifactInDevelopment( artifact, label ) {

	const result = validateArtifact( artifact, { label } );
	if ( result.ok ) return;
	const summary = result.errors.map( ( error ) => `  - ${ error.message }` ).join( '\n' );
	throw new Error( `[tsl-precompile] invalid artifact "${ label || '<unnamed>' }":\n${ summary }` );

}

export function __applyPrecompiled( material, artifactModule, expectedHash ) {

	return __applyPrecompiledWithValidation( material, artifactModule, expectedHash, validateArtifactInDevelopment );

}

export {
	__applyPrecompiledWithValidation,
	catalogueArtifactTextureRefs,
	collectLiveMaterialTextures,
	collectReflectorBaseNodes,
} from './apply-precompiled.js';
