import { THREE_RELEASE_PROFILES } from '@tsl-precompile/contract/slim-three-policy';
import { createThreeEmitterHashFields, assertArtifactThreeEmitterIdentity } from '@tsl-precompile/contract/three-emitter-identity';
import { ARTIFACT_CONTENT_HASH_VERSION } from '@tsl-precompile/contract/artifact-content';

export function captureReleaseHashOptions( release ) {

	return { threeVersion: release.packageVersion, ...createThreeEmitterHashFields( { threeVersion: release.packageVersion, threeRevision: release.revision, threeCommit: release.gitCommit } ) };

}

export function captureReleaseDefines( release ) {

	const fields = createThreeEmitterHashFields( captureReleaseHashOptions( release ) );
	return fields.threeRevision ? {
		'globalThis.__TSLP_THREE_REVISION__': JSON.stringify( fields.threeRevision ),
		'globalThis.__TSLP_THREE_COMMIT__': JSON.stringify( fields.threeCommit ),
	} : {};

}

export function artifactEmitterHashFields( artifact ) {

	return createThreeEmitterHashFields( { threeVersion: artifact.sourceThreeVersion, threeRevision: artifact.sourceThreeRevision, threeCommit: artifact.sourceThreeCommit } );

}

export function auxiliaryCaptureEnvelopesAgree( payload, existing, storedCapture ) {

	const expected = { shape: payload.materialShape, configHash: payload.configHash, threeVersion: payload.threeVersion, pluginVersion: payload.pluginVersion, ...artifactEmitterHashFields( payload.artifact ) };
	const stored = { shape: storedCapture.__materialShape, configHash: storedCapture.__configHash, ...storedCapture };
	return Object.entries( expected ).every( ( [ field, value ] ) => existing[ field ] === value && stored[ field ] === value ) &&
		[ storedCapture.artifact, payload.artifact ].every( artifact => artifact.sourceThreeVersion === payload.threeVersion && artifact.sourceHashVersion === payload.pluginVersion );

}

export function assertDevCaptureEmitter( payload, release ) {

	try {

		const expected = captureReleaseHashOptions( release );
		assertArtifactThreeEmitterIdentity( payload.artifact, expected, 'Captured artifact' );
		if ( release.channel === 'development' && payload.artifact.artifactContentHashVersion !== ARTIFACT_CONTENT_HASH_VERSION ) throw new Error( 'Development artifacts require a current content signature. Recapture with the verified emitter.' );
		if ( payload.materialShape ) for ( const [ field, value ] of Object.entries( createThreeEmitterHashFields( expected ) ) ) {

			if ( payload[ field ] !== value ) throw new Error( `Auxiliary payload is missing or mismatches ${ field }. Recapture it with the verified emitter.` );

		}

	} catch ( error ) {

		error.code = 'EINVAL';
		throw error;

	}

}

/** Accept a canonical release object verified by the plugin, never a payload claim. */
export function resolveDevCaptureRelease( release = THREE_RELEASE_PROFILES.stable ) {

	if ( ! Object.values( THREE_RELEASE_PROFILES ).includes( release ) ) throw new Error( 'Dev capture requires a canonical verified Three release profile.' );
	return release;

}

export function assertDevCaptureVersion( version, release, label ) {

	if ( version === release.packageVersion ) return;
	const error = new Error( `${ label } must match the current exact baseline ${ release.packageVersion } (${ release.id })` );
	error.code = 'EINVAL';
	throw error;

}
