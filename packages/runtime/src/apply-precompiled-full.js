/**
 * Full-Three production apply path.
 *
 * The Vite plugin injects this entry when `slim` is disabled. It keeps the
 * original live NodeMaterial so stock Three's NodeManager can compile it,
 * while still running the exact artifact hash/source-freshness gates and
 * registering the generated artifact for diagnostics and tooling.
 */

import { preparePrecompiledArtifact } from './apply-precompiled-common.js';
import { registerArtifact } from './artifact-loader.js';

export function __applyPrecompiled( material, artifactModule, expectedHash ) {

	const artifact = preparePrecompiledArtifact( material, artifactModule, expectedHash );
	const name = artifactModule.name || artifact.__name;
	if ( artifactModule.__hash && ! artifact.__hash ) {

		Object.defineProperty( artifact, '__hash', { value: artifactModule.__hash, enumerable: false, configurable: true } );

	}
	// Do not retain the generated module namespace here. Its updater/light
	// exports are replay-only; letting that namespace escape into the registry
	// would keep their `three/src/**` closure beside stock `three/webgpu`.
	registerArtifact( name, {
		__hash: expectedHash,
		name,
		__sourceValidationMode: artifactModule.__sourceValidationMode ?? null,
		__unsupportedKinds: Array.isArray( artifactModule.__unsupportedKinds )
			? artifactModule.__unsupportedKinds
			: [],
		artifact,
	} );
	return material;

}
