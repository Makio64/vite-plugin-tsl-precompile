import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SLIM_THREE_PACKAGE_VERSION, THREE_RELEASE_PROFILES } from '@tsl-precompile/contract/slim-three-policy';
import { readSlimThreeReleaseProfile } from '@tsl-precompile/contract/slim-bundle-provenance-node';
import { createThreeEmitterHashFields } from '@tsl-precompile/contract/three-emitter-identity';

let installedDevelopmentEmitter = null;

/**
 * Harness entry points render with the installed Three package. When that package is the
 * pinned development build, verify its source fingerprint once (as the Vite plugin does) and
 * supply its identity unless the caller passed any identity field of its own. Unverified
 * development sources still fail closed.
 */
export async function withInstalledCaptureEmitter( core, options = {} ) {

	if ( core.REVISION !== THREE_RELEASE_PROFILES.development.revision ) return options;
	if ( [ 'threeVersion', 'threeRevision', 'threeCommit' ].some( field => options[ field ] !== undefined ) ) return options;
	installedDevelopmentEmitter ??= ( async () => {

		const packageRoot = resolve( dirname( fileURLToPath( import.meta.resolve( 'three' ) ) ), '..' );
		const release = await readSlimThreeReleaseProfile( packageRoot );
		return { threeVersion: release.packageVersion, threeRevision: release.revision, threeCommit: release.gitCommit };

	} )();
	return { ...options, ...await installedDevelopmentEmitter };

}

/** Native development captures require an explicit verified source identity. */
export function captureEmitterOptions( core, options ) {

	const threeVersion = options.threeVersion || SLIM_THREE_PACKAGE_VERSION;
	if ( core.REVISION === '187dev' && ( options.threeRevision !== core.REVISION || ! options.threeCommit ) ) throw new Error( 'Native r187dev capture requires its verified threeRevision and threeCommit. Recapture with the configured source profile.' );
	return { threeVersion, ...createThreeEmitterHashFields( { ...options, threeVersion } ) };

}
