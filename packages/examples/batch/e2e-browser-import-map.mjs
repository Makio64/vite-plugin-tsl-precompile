/**
 * Exact bare-specifier mappings used by the native-browser E2E harness.
 *
 * Import-map keys without a trailing slash match only one exact specifier, so
 * every public package subpath imported by a local evidence route must be
 * listed here. Keep the targets extension-complete because the harness serves
 * runtime source files directly rather than applying Node package exports.
 */
export function createTslpBrowserImportMap( mode, {
	auxVirtualUrl = '/__tslp__/aux-virtual.js',
} = {} ) {

	const setupTarget = mode === 'capture'
		? '/__tslp_batch/e2e-capture-setup-adapter.js'
		: '/__tslp_runtime/setup-production.js';

	return {
		'@tsl-precompile/runtime': '/__tslp_runtime/index.js',
		'@tsl-precompile/runtime/setup': setupTarget,
		'@tsl-precompile/runtime/apply': '/__tslp_runtime/apply-precompiled.js',
		'@tsl-precompile/runtime/compute': '/__tslp_runtime/precompiled-compute-runner.js',
		'@tsl-precompile/runtime/material-variants': '/__tslp_runtime/material-variants.js',
		'@tsl-precompile/runtime/writers': '/__tslp_runtime/writers.js',
		'@tsl-precompile/runtime/slim-support/live-scene-index': '/__tslp_runtime/slim-support/live-scene-index.js',
		'@tsl-precompile/runtime/slim-support/pmrem': '/__tslp_runtime/slim-support/pmrem.js',
		'@tsl-precompile/runtime/slim-support/precompiled-shadows': '/__tslp_runtime/slim-support/precompiled-shadows.js',
		'@tsl-precompile/runtime/slim-support/gpu-texture-share': '/__tslp_runtime/slim-support/gpu-texture-share.js',
		'@tsl-precompile/runtime/slim-support/compute-sync': '/__tslp_runtime/slim-support/compute-sync.js',
		'@tsl-precompile/runtime/slim-support/auto-compute': '/__tslp_runtime/slim-support/auto-compute.js',
		'@tsl-precompile/runtime/slim-support/live-uniform-registry': '/__tslp_runtime/slim-support/live-uniform-callsite.js',
		'@tsl-precompile/contract': '/__tslp_contract/index.js',
		'@tsl-precompile/contract/dynamic-bindings': '/__tslp_contract/dynamic-bindings.js',
		'@tsl-precompile/contract/fragment-outputs': '/__tslp_contract/fragment-outputs.js',
		'@tsl-precompile/contract/graph-normalize': '/__tslp_contract/graph-normalize.js',
		'@tsl-precompile/contract/kinds': '/__tslp_contract/kinds.js',
		'@tsl-precompile/contract/texture-props': '/__tslp_contract/texture-props.js',
		'@tsl-precompile/contract/': '/__tslp_contract/',
		'virtual:tsl-precompile/__aux': auxVirtualUrl,
		'vite-plugin-tsl-precompile/src/vendor/compileTSL.js': '/__tslp_plugin/vendor/compileTSL.js',
		'vite-plugin-tsl-precompile/src/emit-updater.js': '/__tslp_plugin/emit-updater.js',
	};

}
