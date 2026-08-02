import { validateArtifact } from '@tsl-precompile/contract/kinds';
import { SLIM_THREE_PACKAGE_VERSION } from '@tsl-precompile/contract/slim-three-policy';
import { ARTIFACT_TOOLCHAIN_VERSION } from '@tsl-precompile/contract/versions';

import { assertArtifactContentIntegrity } from '../../plugin/src/artifact-content-integrity.js';
import { loadArtifactDirectory } from '../../plugin/src/artifact-directory-loader.js';

const SHA256_HEX = /^[a-f0-9]{64}$/;

/**
 * Parse the authoritative capture manifest, select the expected user material,
 * and validate both its shared artifact contract and signed runtime content.
 */
export async function loadValidatedCapturedMaterial( artifactsDirectory, expectedName ) {

	const loaded = await loadArtifactDirectory( artifactsDirectory, {
		manifestConsistencyRetries: 3,
		manifestConsistencyRetryDelayMs: 20,
	} );
	return validateLoadedCapturedMaterial( loaded, expectedName );

}

/**
 * Pure selection/validation seam used by deterministic regressions.
 */
export function validateLoadedCapturedMaterial( loaded, expectedName ) {

	if ( typeof expectedName !== 'string' || expectedName.length === 0 ) {

		throw new TypeError( 'expected captured material name must be a non-empty string' );

	}
	if ( ! loaded || loaded.authoritative !== true ) {

		throw new Error( `capture did not produce an authoritative manifest for ${ JSON.stringify( expectedName ) }` );

	}
	const record = loaded.manifest && loaded.manifest[ expectedName ];
	if ( ! record ) {

		throw new Error( `authoritative capture manifest is missing ${ JSON.stringify( expectedName ) }` );

	}
	return validateCapturedMaterialRecord( record, expectedName );

}

export function validateCapturedMaterialRecord( record, expectedName ) {

	const label = `captured material ${ JSON.stringify( expectedName ) }`;
	if ( ! record || typeof record !== 'object' || Array.isArray( record ) ) {

		throw new Error( `${ label } manifest record must be an object` );

	}
	const envelope = record.entry;
	if ( ! envelope || typeof envelope !== 'object' || Array.isArray( envelope ) ) {

		throw new Error( `${ label } is missing its parsed artifact envelope` );

	}
	if ( envelope.__name !== expectedName ) {

		throw new Error( `${ label } envelope __name is ${ JSON.stringify( envelope.__name ) }` );

	}
	if ( typeof envelope.__hash !== 'string' || ! SHA256_HEX.test( envelope.__hash ) ) {

		throw new Error( `${ label } envelope __hash must be a lowercase 64-character SHA-256 hex string` );

	}
	if ( record.hash !== envelope.__hash ) {

		throw new Error( `${ label } manifest hash does not match envelope __hash` );

	}

	const expectedFilename = `${ expectedName }.${ envelope.__hash.slice( 0, 12 ) }.json`;
	if ( record.file !== expectedFilename ) {

		throw new Error( `${ label } filename must be ${ JSON.stringify( expectedFilename ) }, received ${ JSON.stringify( record.file ) }` );

	}

	const artifact = envelope.artifact;
	if ( ! artifact || typeof artifact !== 'object' || Array.isArray( artifact ) ) {

		throw new Error( `${ label } is missing its artifact payload` );

	}
	if ( artifact.sourceThreeVersion !== SLIM_THREE_PACKAGE_VERSION ) {

		throw new Error( `${ label } sourceThreeVersion must be exact current baseline ${ SLIM_THREE_PACKAGE_VERSION }` );

	}
	if ( artifact.sourceHashVersion !== ARTIFACT_TOOLCHAIN_VERSION ) {

		throw new Error( `${ label } sourceHashVersion must be current toolchain ${ ARTIFACT_TOOLCHAIN_VERSION }` );

	}
	if ( typeof artifact.sourceGraphHash !== 'string' || ! SHA256_HEX.test( artifact.sourceGraphHash ) ) {

		throw new Error( `${ label } sourceGraphHash must be a lowercase 64-character SHA-256 hex string` );

	}
	if ( typeof artifact.renderContextSignature !== 'string' || artifact.renderContextSignature.length === 0 ) {

		throw new Error( `${ label } is missing its renderContextSignature` );

	}

	const validation = validateArtifact( envelope, {
		label,
		requireShaders: true,
	} );
	if ( ! validation.ok ) {

		throw new Error( `${ label } failed the shared artifact contract: ${ validation.errors.map( ( error ) => error.message ).join( '; ' ) }` );

	}

	assertArtifactContentIntegrity( artifact, envelope.__hash, {
		label,
		shape: `material:${ expectedName }`,
		threeVersion: artifact.sourceThreeVersion,
		pluginVersion: artifact.sourceHashVersion,
		required: true,
	} );

	return {
		file: record.file,
		hash: envelope.__hash,
		envelope,
		validation,
	};

}

/**
 * Normalize every browser failure for the capture gate. The ocean page embeds
 * its favicon, so there is no legitimate failed-resource exception.
 */
export function fatalCaptureReplayBrowserErrors( failures ) {

	if ( ! Array.isArray( failures ) ) return [ {
		kind: 'browser',
		message: 'browser failure collector returned a non-array value',
		url: '',
	} ];

	return failures.map( normalizeBrowserFailure );

}

function normalizeBrowserFailure( failure ) {

	if ( typeof failure === 'string' ) return {
		kind: 'browser',
		message: failure,
		url: '',
	};
	if ( ! failure || typeof failure !== 'object' ) return {
		kind: 'browser',
		message: String( failure ),
		url: '',
	};
	return {
		kind: typeof failure.kind === 'string' && failure.kind.length > 0 ? failure.kind : 'browser',
		message: typeof failure.message === 'string' ? failure.message : String( failure.message || '<no diagnostic message>' ),
		url: typeof failure.url === 'string' ? failure.url : '',
	};

}
