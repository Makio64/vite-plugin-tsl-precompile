const TSLP_WARNING_TAG = /\[(?:tslp|tsl-precompile)(?:[^\]]*)\]/i;

/**
 * Product/runtime warnings use the public `[tsl-precompile*]` prefix while
 * harness diagnostics use `[tslp*]`. Both are evidence-affecting; unrelated
 * Three.js/browser warnings remain outside this narrow semantic gate.
 */
export function isTslpWarningMessage( value ) {

	return typeof value === 'string' && TSLP_WARNING_TAG.test( value );

}
