import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SLIM_THREE_PACKAGE_VERSION, THREE_RELEASE_PROFILES } from '@tsl-precompile/contract/slim-three-policy';
import { readSlimThreeReleaseProfile } from '@tsl-precompile/contract/slim-bundle-provenance-node';
import { createThreeEmitterHashFields } from '@tsl-precompile/contract/three-emitter-identity';

const installedEmitterCache = new Map();

/**
 * Harness entry points render with the installed Three package. When that package is the
 * pinned development or r187 build, verify its source fingerprint once (as the Vite plugin does)
 * and supply its identity unless the caller passed any identity field of its own. Unverified
 * development sources still fail closed.
 */
export async function withInstalledCaptureEmitter( core, options = {} ) {

	if ( core.REVISION !== THREE_RELEASE_PROFILES.development.revision && core.REVISION !== '187' ) return options;
	if ( [ 'threeVersion', 'threeRevision', 'threeCommit' ].some( field => options[ field ] !== undefined ) ) return options;
	const cacheKey = `${core.REVISION}:${process.env.TSLP_THREE_SOURCE_ROOT || ''}:${process.env.TSLP_THREE_SOURCE_COMMIT || ''}`;
	if ( ! installedEmitterCache.has( cacheKey ) ) {

		installedEmitterCache.set( cacheKey, ( async () => {

			const packageRoot = process.env.TSLP_THREE_SOURCE_ROOT
				? resolve( process.env.TSLP_THREE_SOURCE_ROOT )
				: resolve( dirname( fileURLToPath( import.meta.resolve( 'three' ) ) ), '..' );
			const release = await readSlimThreeReleaseProfile( packageRoot, {
				sourceCommit: process.env.TSLP_THREE_SOURCE_COMMIT || undefined,
			} );
			return { threeVersion: release.packageVersion, threeRevision: release.revision, threeCommit: release.gitCommit };

		} )() );

	}

	return { ...options, ...await installedEmitterCache.get( cacheKey ) };

}

/** Native development captures require an explicit verified source identity. */
export function captureEmitterOptions( core, options ) {

	const threeVersion = options.threeVersion || ( core.REVISION === '187' ? '0.187.0' : SLIM_THREE_PACKAGE_VERSION );
	if ( core.REVISION === '187dev' && ( options.threeRevision !== core.REVISION || ! options.threeCommit ) ) throw new Error( 'Native r187dev capture requires its verified threeRevision and threeCommit. Recapture with the configured source profile.' );
	return { threeVersion, ...createThreeEmitterHashFields( { ...options, threeVersion } ) };

}
