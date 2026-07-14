/**
 * Production half of the conditional `@tsl-precompile/runtime/setup` entry.
 *
 * Vite has already rewritten every `.precompile()` marker and registered the
 * captured auxiliary artifacts. Keeping this module independent from the dev
 * marker and Three namespace makes setup disappear from production bundles.
 */

const ready = Promise.resolve();
const result = Object.freeze( {
	ready,
	captureAux: async () => [],
	setRenderer() {},
} );

export function setupPrecompile( opts = {} ) {

	if ( ! opts || typeof opts !== 'object' ) {

		throw new TypeError( 'setupPrecompile: opts object is required.' );

	}

	if ( ! opts.renderer ) {

		throw new Error( 'setupPrecompile: opts.renderer is required.' );

	}

	return result;

}
