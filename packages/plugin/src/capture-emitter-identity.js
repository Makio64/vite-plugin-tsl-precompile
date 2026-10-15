import { SLIM_THREE_PACKAGE_VERSION } from '@tsl-precompile/contract/slim-three-policy';
import { createThreeEmitterHashFields } from '@tsl-precompile/contract/three-emitter-identity';

/** Native development captures require an explicit verified source identity. */
export function captureEmitterOptions( core, options ) {

	const threeVersion = options.threeVersion || SLIM_THREE_PACKAGE_VERSION;
	if ( core.REVISION === '187dev' && ( options.threeRevision !== core.REVISION || ! options.threeCommit ) ) throw new Error( 'Native r187dev capture requires its verified threeRevision and threeCommit. Recapture with the configured source profile.' );
	return { threeVersion, ...createThreeEmitterHashFields( { ...options, threeVersion } ) };

}
