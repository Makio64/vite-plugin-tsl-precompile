/**
 * Capture-pass adapter for local examples that call the public
 * `setupPrecompile()` helper.
 *
 * The batch harness owns a per-case capture endpoint. Forward it only when the
 * application did not explicitly choose an endpoint, so the public development
 * setup cannot replace the harness marker's endpoint with its normal Vite
 * default.
 */

import { setupPrecompile as setupDevelopment } from '/__tslp_runtime/setup-development.js';

export function captureSetupOptions( options, state = globalThis.__TSLP_E2E ) {

	if ( ! options || typeof options !== 'object' ) return options;
	if ( Object.prototype.hasOwnProperty.call( options, 'devEndpoint' ) ) return options;
	const captureEndpoint = state && state.captureEndpoint;
	if ( typeof captureEndpoint !== 'string' || captureEndpoint.length === 0 ) return options;
	return {
		...options,
		devEndpoint: captureEndpoint,
	};

}

export function setupPrecompile( options = {} ) {

	return setupDevelopment( captureSetupOptions( options ) );

}
