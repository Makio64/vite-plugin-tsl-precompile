/** Browser-side axes supplied by verified Vite configuration or explicit callers. */
import { assertArtifactThreeEmitterIdentity, createThreeEmitterHashFields } from '@tsl-precompile/contract/three-emitter-identity';
import { THREE_RELEASE_PROFILES } from '@tsl-precompile/contract/slim-three-releases';
import { ARTIFACT_TOOLCHAIN_VERSION } from '@tsl-precompile/contract/versions';

export function createRuntimeCaptureHashOptions( options ) {

	return {
		threeVersion: options.threeVersion,
		...createRuntimeThreeEmitterHashFields( options ),
		pluginVersion: options.pluginVersion || ARTIFACT_TOOLCHAIN_VERSION,
	};

}

export function createRuntimeThreeEmitterHashFields( options = {} ) {

	if ( options.threeRevision !== undefined || options.threeCommit !== undefined ) return createThreeEmitterHashFields( options );
	if ( globalThis.__TSLP_THREE_PACKAGE_VERSION__ === options.threeVersion ) {

		return createThreeEmitterHashFields( {
			threeVersion: options.threeVersion,
			threeRevision: globalThis.__TSLP_THREE_REVISION__ ?? ( options.three?.REVISION === THREE_RELEASE_PROFILES.development.revision ? options.three.REVISION : undefined ),
			threeCommit: globalThis.__TSLP_THREE_COMMIT__,
		} );

	}
	// A development Three namespace is sufficient to require exact axes, but
	// its nominal package version alone never identifies the emitter commit.
	return createThreeEmitterHashFields( {
		threeVersion: options.threeVersion,
		...( options.three?.REVISION === THREE_RELEASE_PROFILES.development.revision ? { threeRevision: options.three.REVISION } : {} ),
	} );

}

/** Validate durable emitter metadata before a raw artifact reaches native replay. */
export function validateRuntimeArtifactThreeEmitterIdentity( artifact, label = 'Artifact' ) {

	const threeVersion = artifact?.sourceThreeVersion;
	const development = THREE_RELEASE_PROFILES.development;
	if ( threeVersion === development.packageVersion ) {

		assertArtifactThreeEmitterIdentity( artifact, {
			threeVersion, threeRevision: development.revision, threeCommit: development.gitCommit,
		}, label );

	}
	const fields = createThreeEmitterHashFields( {
		threeVersion,
		threeRevision: artifact?.sourceThreeRevision,
		threeCommit: artifact?.sourceThreeCommit,
	} );
	const configuredThreeVersion = globalThis.__TSLP_THREE_PACKAGE_VERSION__;
	const configured = createRuntimeThreeEmitterHashFields( { threeVersion: configuredThreeVersion } );
	if ( configured.threeRevision ) {

		assertArtifactThreeEmitterIdentity( artifact, { threeVersion: configuredThreeVersion, ...configured }, label );
		if ( threeVersion !== configuredThreeVersion ) throw new Error( `${ label } mismatches sourceThreeVersion for the verified development emitter. Recapture it with pinned r187dev before building.` );

	}
	return fields;

}
