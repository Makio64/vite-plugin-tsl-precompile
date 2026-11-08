import { ARTIFACT_CONTENT_HASH_VERSION } from '@tsl-precompile/contract/artifact-content';
import { stableJsonStringify } from '@tsl-precompile/contract/stable-json';
import { computeArtifactContentHash } from './hash.js';
import { artifactEmitterHashFields } from './dev-capture-release.js';

/** Compare signed recaptures whose private cache keys or session UUIDs differ. */
export function signedCaptureContentMatches( stored, incoming, contentShape ) {

	if ( typeof contentShape !== 'string' || contentShape.length === 0 ) return false;
	const storedArtifact = stored?.artifact, incomingArtifact = incoming?.artifact;
	if ( ! storedArtifact || ! incomingArtifact ||
		storedArtifact.artifactContentHashVersion !== ARTIFACT_CONTENT_HASH_VERSION ||
		incomingArtifact.artifactContentHashVersion !== ARTIFACT_CONTENT_HASH_VERSION ) return false;
	// Content identity proves payload equivalence; the separate envelope check
	// ensures new source owners still update the durable capture.
	const storedEnvelope = { ...stored }, incomingEnvelope = { ...incoming };
	delete storedEnvelope.artifact;
	delete incomingEnvelope.artifact;
	if ( stableJsonStringify( storedEnvelope, 'stored capture envelope' ) !== stableJsonStringify( incomingEnvelope, 'incoming capture envelope' ) ) return false;
	const threeVersion = storedArtifact.sourceThreeVersion, toolchainVersion = storedArtifact.sourceHashVersion;
	if ( typeof threeVersion !== 'string' || typeof toolchainVersion !== 'string' ||
		incomingArtifact.sourceThreeVersion !== threeVersion || incomingArtifact.sourceHashVersion !== toolchainVersion ) return false;
	return computeArtifactContentHash( storedArtifact, {
		shape: contentShape,
		...artifactEmitterHashFields( storedArtifact ),
		threeVersion,
		pluginVersion: toolchainVersion,
	} ) === incoming.__hash;

}
