import { ARTIFACT_CONTENT_HASH_VERSION } from '@tsl-precompile/contract/artifact-content';
import { computeArtifactContentHash } from './hash.js';
import { assertArtifactThreeEmitterIdentity } from '@tsl-precompile/contract/three-emitter-identity';

/**
 * Fail closed when a signed artifact envelope does not match its runtime
 * payload. Callers may explicitly inspect legacy data with `required: false`,
 * but production material and auxiliary loading require a signature.
 */
export function assertArtifactContentIntegrity( artifact, storedHash, opts ) {

	const {
		label,
		shape,
		threeVersion,
		pluginVersion,
		required = true,
	} = opts;
	if ( ! artifact || typeof artifact !== 'object' || Array.isArray( artifact ) ) {

		throw new Error( `${ label } is missing its artifact payload.` );

	}
	if ( artifact.artifactContentHashVersion === undefined && ! required ) return false;
	assertArtifactThreeEmitterIdentity( artifact, opts, label );
	if ( artifact.artifactContentHashVersion !== ARTIFACT_CONTENT_HASH_VERSION ) {

		throw new Error( `${ label } uses unsupported content-hash version ${ artifact.artifactContentHashVersion || '<missing>' }. Recapture it.` );

	}
	if ( typeof storedHash !== 'string' || storedHash.length === 0 ) {

		throw new Error( `${ label } is missing its stored content hash. Recapture it.` );

	}
	const computed = computeArtifactContentHash( artifact, {
		...opts,
		shape,
		threeVersion,
		pluginVersion,
	} );
	if ( storedHash !== computed ) {

		throw new Error( `${ label } content does not match its stored __hash. The artifact file is corrupt or was edited; recapture it.` );

	}
	return true;

}
