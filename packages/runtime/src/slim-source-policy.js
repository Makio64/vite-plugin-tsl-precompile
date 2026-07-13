/** Runtime-owned half of the plugin/source-entry compatibility handshake. */

export const RUNTIME_SLIM_THREE_POLICY_VERSION = 'slim-three-policy@4';

export function assertSlimSourcePolicyCompatibility( pluginPolicyVersion ) {

	if ( pluginPolicyVersion === RUNTIME_SLIM_THREE_POLICY_VERSION ) return;
	throw new Error(
		`[tsl-precompile] slim source policy mismatch: runtime expects ${ RUNTIME_SLIM_THREE_POLICY_VERSION }, ` +
		`but the Vite plugin provided ${ String( pluginPolicyVersion || '<missing>' ) }. ` +
		'Install matching vite-plugin-tsl-precompile and @tsl-precompile/runtime releases.'
	);

}
