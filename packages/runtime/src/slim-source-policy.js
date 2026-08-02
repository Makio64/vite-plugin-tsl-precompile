/** Runtime-owned half of the plugin/source-entry compatibility handshake. */

export const RUNTIME_SLIM_THREE_POLICY_VERSION = 'slim-three-policy@12';
// Keep this tiny runtime-owned copy in sync with the shared build policy. The
// source-entry test guards the duplication so replay does not retain the full
// build-only slim policy module merely to reproduce capture hash identity.
export const RUNTIME_SLIM_THREE_PACKAGE_VERSION = '0.185.1';

export function assertSlimSourcePolicyCompatibility( pluginPolicyVersion ) {

	if ( pluginPolicyVersion === RUNTIME_SLIM_THREE_POLICY_VERSION ) return;
	throw new Error(
		`[tsl-precompile] slim source policy mismatch: runtime expects ${ RUNTIME_SLIM_THREE_POLICY_VERSION }, ` +
		`but the Vite plugin provided ${ String( pluginPolicyVersion || '<missing>' ) }. ` +
		'Install matching vite-plugin-tsl-precompile and @tsl-precompile/runtime releases.'
	);

}
