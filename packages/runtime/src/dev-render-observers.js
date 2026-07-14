/**
 * Package-private completed-render observer registry.
 *
 * The renderer owns the registry under a global symbol so a renderer wrapper
 * installed before HMR can still notify observers registered by a later
 * runtime module instance. Keeping this out of precompile-marker.js also
 * avoids exposing setup plumbing through the public `runtime/marker` entry.
 */

const DEV_RENDER_OBSERVERS = Symbol.for( '@tsl-precompile/runtime/dev-render-observers@1' );

export function observeDevRendererRenders( renderer, observer ) {

	if ( ! renderer || typeof renderer.render !== 'function' ) throw new TypeError( 'observeDevRendererRenders: renderer.render is required.' );
	if ( typeof observer !== 'function' ) throw new TypeError( 'observeDevRendererRenders: observer must be a function.' );

	let observers = renderer[ DEV_RENDER_OBSERVERS ];
	if ( ! observers ) {

		observers = new Set();
		Object.defineProperty( renderer, DEV_RENDER_OBSERVERS, {
			value: observers,
			configurable: true,
		} );

	}
	observers.add( observer );
	return () => observers.delete( observer );

}

export function notifyDevRendererObservers( renderer, scene, camera ) {

	const observers = renderer && renderer[ DEV_RENDER_OBSERVERS ];
	if ( ! observers || observers.size === 0 ) return;
	for ( const observer of [ ...observers ] ) {

		try { observer( { renderer, scene, camera } ); } catch ( error ) {

			console.error( '[tsl-precompile] dev render observer failed:', error );

		}

	}

}
