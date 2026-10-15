/** Runtime-owned half of the plugin/source-entry compatibility handshake. */

import { ARTIFACT_TOOLCHAIN_VERSION } from '@tsl-precompile/contract/versions';
import { createRuntimeThreeEmitterHashFields } from './three-emitter-identity.js';

export const RUNTIME_SLIM_THREE_POLICY_VERSION = 'slim-three-policy@13';
// Keep this tiny runtime-owned copy in sync with the shared build policy. The
// source-entry test guards the duplication so replay does not retain the full
// build-only slim policy module merely to reproduce capture hash identity.
export const RUNTIME_SLIM_THREE_PACKAGE_VERSION = '0.186.1';

export function getRuntimeSlimThreePackageVersion() {

	const injected = typeof globalThis !== 'undefined' && globalThis.__TSLP_THREE_PACKAGE_VERSION__;
	return typeof injected === 'string' && injected.length > 0 ? injected : RUNTIME_SLIM_THREE_PACKAGE_VERSION;

}

export function createRuntimeSlimHashOptions() {

	return Object.freeze( {
		// Vite source mode may use the verified r187 development package. Keep
		// its injected exact identity separate from the published prebuilt pin.
		get threeVersion() { return getRuntimeSlimThreePackageVersion(); },
		...createRuntimeThreeEmitterHashFields( { threeVersion: getRuntimeSlimThreePackageVersion() } ),
		pluginVersion: ARTIFACT_TOOLCHAIN_VERSION,
	} );

}

export function assertSlimSourcePolicyCompatibility( pluginPolicyVersion ) {

	if ( pluginPolicyVersion === RUNTIME_SLIM_THREE_POLICY_VERSION ) return;
	throw new Error(
		`[tsl-precompile] slim source policy mismatch: runtime expects ${ RUNTIME_SLIM_THREE_POLICY_VERSION }, ` +
		`but the Vite plugin provided ${ String( pluginPolicyVersion || '<missing>' ) }. ` +
		'Install matching vite-plugin-tsl-precompile and @tsl-precompile/runtime releases.'
	);

}
