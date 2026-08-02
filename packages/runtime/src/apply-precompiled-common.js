/**
 * Mode-independent production artifact gates.
 *
 * Both full-Three compatibility builds and compiler-free slim builds verify
 * the exact shipped artifact and validate source freshness here. Registry
 * payloads, generated updaters, and material adoption remain mode-owned so the
 * full build never pulls replay-only Three source constructors into its graph.
 */

import { ARTIFACT_TOOLCHAIN_VERSION } from '@tsl-precompile/contract/versions';
import { hashMaterialSync } from './graph-hash.js';

const SOURCE_HASH_FIELDS = Object.freeze( [
	'sourceGraphHash',
	'sourceHashVersion',
	'sourceThreeVersion',
	'renderContextSignature',
] );

/**
 * Recompute the captured material-source fingerprint before replay mutates a
 * source material. Full mode runs the same gate even though it keeps the live
 * graph, so stale artifacts fail identically in both production modes.
 */
function assertCapturedSourceIsFresh( material, artifactModule, artifact, name ) {

	const metadataSource = SOURCE_HASH_FIELDS.some( ( key ) => artifact && artifact[ key ] !== undefined )
		? artifact
		: SOURCE_HASH_FIELDS.some( ( key ) => artifactModule && artifactModule[ key ] !== undefined )
			? artifactModule
			: null;
	if ( metadataSource === null ) return; // Explicit legacy policy.

	const sourceGraphHash = metadataSource.sourceGraphHash;
	const sourceHashVersion = metadataSource.sourceHashVersion;
	const sourceThreeVersion = metadataSource.sourceThreeVersion;
	const renderContextSignature = metadataSource.renderContextSignature;
	const sourceValidationMode = artifactModule && artifactModule.__sourceValidationMode || metadataSource.sourceValidationMode;

	if ( typeof sourceGraphHash !== 'string' || ! /^[a-f0-9]{64}$/i.test( sourceGraphHash ) ) {

		throw new Error( `[tsl-precompile] artifact "${ name || '<unnamed>' }" has incomplete source-hash metadata: sourceGraphHash must be 64 SHA-256 hex characters. Recapture.` );

	}
	if ( sourceHashVersion !== ARTIFACT_TOOLCHAIN_VERSION ) {

		throw new Error( `[tsl-precompile] artifact "${ name || '<unnamed>' }" has source-hash/toolchain version ${ sourceHashVersion || '<missing>' }; runtime requires ${ ARTIFACT_TOOLCHAIN_VERSION }. Recapture.` );

	}
	if ( typeof sourceThreeVersion !== 'string' || sourceThreeVersion.length === 0 ) {

		throw new Error( `[tsl-precompile] artifact "${ name || '<unnamed>' }" has incomplete source-hash metadata: sourceThreeVersion is missing. Recapture.` );

	}
	if ( typeof name !== 'string' || name.length === 0 ) {

		throw new Error( '[tsl-precompile] source-hash validation requires an artifact name. Recapture.' );

	}

	const detectedThreeVersion = typeof globalThis !== 'undefined' && typeof globalThis.__TSLP_THREE_PACKAGE_VERSION__ === 'string'
		? globalThis.__TSLP_THREE_PACKAGE_VERSION__
		: '';
	if ( detectedThreeVersion && detectedThreeVersion !== sourceThreeVersion ) {

		throw new Error( `[tsl-precompile] artifact "${ name }" was captured with three ${ sourceThreeVersion }, but this bundle uses three ${ detectedThreeVersion }. Recapture it with the installed three version.` );

	}
	if ( sourceValidationMode === 'callsite' ) {

		// autoMark is rewritten at `new *NodeMaterial()`, before subsequent
		// assignments configure the graph. Source slim also replaces application
		// TSL nodes with inert carriers. In both cases the plugin has already
		// validated the captured module/call-site revision at build time.
		return;

	}

	const currentSourceGraphHash = hashMaterialSync( material, {
		name,
		threeVersion: detectedThreeVersion || sourceThreeVersion,
		toolchainVersion: ARTIFACT_TOOLCHAIN_VERSION,
		renderContextSignature,
	} );
	if ( currentSourceGraphHash !== sourceGraphHash ) {

		throw new Error( `[tsl-precompile] stale source graph detected for "${ name }": capture recorded ${ sourceGraphHash }, current material source is ${ currentSourceGraphHash }. Recapture the artifact before building.` );

	}

}

/**
 * Validate one transformed artifact without choosing its registry payload or
 * whether the caller's material should be retained/adopted. Keeping the
 * generated module namespace from escaping this boundary lets full builds
 * tree-shake replay-only updater imports.
 *
 * @returns {Object}
 */
export function preparePrecompiledArtifact( material, artifactModule, expectedHash ) {

	if ( ! artifactModule || typeof artifactModule !== 'object' ) {

		throw new Error( '[tsl-precompile] __applyPrecompiled: artifactModule is missing. Did the virtual module resolver run?' );

	}

	const shipped = artifactModule.__hash || ( artifactModule.artifact && artifactModule.artifact.__hash );
	if ( shipped !== expectedHash ) {

		throw new Error( `[tsl-precompile] stale artifact detected for "${ artifactModule.name || '<unnamed>' }": expected hash ${ expectedHash }, bundle shipped ${ shipped || '<missing>' }. Rebuild — the on-disk artifact is out of sync with source.` );

	}

	const artifact = artifactModule.artifact || artifactModule;
	const name = artifactModule.name || artifact.__name;
	assertCapturedSourceIsFresh( material, artifactModule, artifact, name );
	return artifact;

}
