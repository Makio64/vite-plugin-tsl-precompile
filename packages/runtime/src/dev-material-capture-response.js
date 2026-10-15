/** Validate the exact family accepted by a custom or plugin capture endpoint. */
import { ARTIFACT_TOOLCHAIN_VERSION } from '@tsl-precompile/contract/versions';
import { ARTIFACT_CONTENT_HASH_VERSION } from '@tsl-precompile/contract/artifact-content';
import { assertArtifactThreeEmitterIdentity } from '@tsl-precompile/contract/three-emitter-identity';
import { hashArtifactContentSync } from './graph-hash.js';

export async function acceptedCaptureResponse( response, fallback ) {

	let body = null;
	if ( response && typeof response.json === 'function' ) {

		try { body = await response.json(); } catch ( _ ) { /* custom endpoints may return an empty success body */ }

	}
	if ( ! body || typeof body !== 'object' || ( body.artifact === undefined && body.hash === undefined ) ) return fallback;
	if ( body.name !== undefined && body.name !== fallback.name ) {

		throw new Error( `[tsl-precompile] dev capture accepted the wrong artifact name ${ JSON.stringify( body.name ) } for ${ JSON.stringify( fallback.name ) }.` );

	}
	const artifact = body.artifact;
	const hash = typeof body.hash === 'string' ? body.hash.replace( /^sha256:/i, '' ).toLowerCase() : '';
	if ( ! artifact || typeof artifact !== 'object' || ! /^[a-f0-9]{64}$/.test( hash ) ) {

		throw new Error( `[tsl-precompile] dev capture returned an incomplete accepted artifact for ${ JSON.stringify( fallback.name ) }.` );

	}
	if ( artifact.artifactContentHashVersion !== ARTIFACT_CONTENT_HASH_VERSION ||
		artifact.sourceThreeVersion !== fallback.threeVersion ||
		artifact.sourceHashVersion !== ARTIFACT_TOOLCHAIN_VERSION ||
		artifact.sourceGraphHash !== fallback.artifact.sourceGraphHash ||
		artifact.sourceValidationMode !== fallback.artifact.sourceValidationMode ) {

		throw new Error( `[tsl-precompile] dev capture returned an incompatible accepted artifact for ${ JSON.stringify( fallback.name ) }.` );

	}
	assertArtifactThreeEmitterIdentity( artifact, fallback, `Accepted artifact ${ JSON.stringify( fallback.name ) }` );
	const computed = hashArtifactContentSync( artifact, {
		...fallback,
		shape: `material:${ fallback.name }`,
		threeVersion: fallback.threeVersion,
		pluginVersion: ARTIFACT_TOOLCHAIN_VERSION,
	} );
	if ( computed !== hash ) {

		throw new Error( `[tsl-precompile] dev capture returned an accepted artifact whose content does not match hash ${ hash }.` );

	}
	return { name: fallback.name, hash, artifact };

}
