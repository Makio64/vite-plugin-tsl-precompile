/**
 * @module InspectorLoader
 *
 * Productized wrapper for the three.js Inspector addon (`three/addons/inspector/Inspector.js`).
 *
 * Background: the upstream Inspector reaches `import.meta.url` to fetch
 * `../extensions/extensions.json`. In a Vite production build / `vite preview`
 * the URL resolves to the deployed app root, the file is missing, the SPA
 * fallback returns the index HTML, and `JSON.parse` throws "Unexpected token
 * '<'" — blocking the render init even in scenes where Inspector is "just a
 * dev tool."
 *
 * `loadInspectorOptional()` resolves to the Inspector class in dev and to
 * `null` in production-like environments, using the same runtime-detection
 * trick as `aux-marker.js::lazyLoadCompileTSL`: an `@vite-ignore`-marked
 * dynamic import is left for the browser to resolve, and the production
 * bundle predictably fails. The detection result is cached.
 *
 * Adopters call this once at app startup:
 *
 * ```js
 * import { loadInspectorOptional } from '@tsl-precompile/runtime';
 *
 * const Inspector = await loadInspectorOptional();
 * if ( Inspector ) {
 *     const inspector = new Inspector( renderer );
 *     // … attach to the page in the usual way …
 * }
 * ```
 *
 * In production builds this returns `null`, the Inspector is never
 * imported, and `extensions.json` is never fetched.
 */

let _isProdLike = null;

async function detectProdLike() {

	if ( _isProdLike !== null ) return _isProdLike;
	try {

		// Same signal as `aux-marker.js::lazyLoadCompileTSL`: in a dev
		// environment `vite-plugin-tsl-precompile` is resolvable; in any
		// production bundle the bare specifier is `/* @vite-ignore */`'d and
		// fails. We don't actually use the module — only its resolvability.
		await import( /* @vite-ignore */ 'vite-plugin-tsl-precompile/src/vendor/compileTSL.js' );
		_isProdLike = false;

	} catch ( _ ) {

		_isProdLike = true;

	}
	return _isProdLike;

}

/**
 * Load the three.js Inspector addon class, returning `null` in production-like
 * environments where Inspector's `extensions.json` fetch would 404.
 *
 * @return {Promise<?Function>} Inspector class or null
 */
export async function loadInspectorOptional() {

	if ( await detectProdLike() ) return null;
	try {

		const mod = await import( /* @vite-ignore */ 'three/addons/inspector/Inspector.js' );
		return ( mod && mod.Inspector ) || null;

	} catch ( _ ) {

		return null;

	}

}

/**
 * Force the production-detection result. Test helper; do not call from app code.
 *
 * @param {?boolean} value - `true` to force "prod-like", `false` to force "dev-like",
 *                          `null` to reset and let the next call re-detect.
 */
export function __setProdLikeForTests( value ) {

	_isProdLike = value;

}
